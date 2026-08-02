/*  Collecte du trafic aérien — fonction Edge, déclenchée chaque minute par
    pg_cron.

    Elle interroge une source ADS-B communautaire et écrit un relevé par
    appareil pour la minute courante. C'est le seul moyen d'avoir un
    historique : aucune source gratuite ne rend les positions passées.

    Elle ne reçoit aucun secret par la requête. La clé de service lui vient
    de son propre environnement, injectée par Supabase — d'où le déploiement
    en accès libre : l'appel de pg_cron n'a rien à porter. Un déclenchement
    intempestif ne fait qu'écrire la même minute, que la clé primaire de la
    table rend sans effet.                                                */

const SOURCES: Record<string, (lat: number, lon: number, nm: number) => string> = {
  "adsb.lol": (lat, lon, nm) =>
    `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`,
  "airplanes.live": (lat, lon, nm) =>
    `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}`,
};

/*  Centre et rayon de la zone enregistrée. La collecte porte sur un point
    fixe : elle ne suit pas les déplacements de la carte. Blainville, 120
    milles nautiques — de quoi couvrir la grande région de Montréal et
    déborder largement sur l'Outaouais et l'Estrie.                       */
const CENTRE = { lat: 45.65, lon: -73.85 };
const RAYON_NM = Number(Deno.env.get("PLANES_RADIUS_NM") ?? "120");
const SOURCE = Deno.env.get("PLANES_SOURCE") ?? "adsb.lol";

type Fix = {
  icao24: string; ts: string; callsign: string | null; reg: string | null;
  actype: string | null; lat: number; lon: number;
  alt: number | null; trk: number | null; spd: number | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function texte(v: unknown): string | null {
  const s = (v ?? "").toString().trim();
  return s.length ? s.slice(0, 24) : null;
}

/*  Les sources ne nomment pas leurs champs de la même façon : on accepte les
    graphies courantes plutôt que d'en épouser une seule.                 */
function normalise(a: Record<string, unknown>, ts: string): Fix | null {
  const lat = num(a.lat ?? a.latitude);
  const lon = num(a.lon ?? a.lng ?? a.longitude);
  if (lat === null || lon === null) return null;

  const icao24 = texte(a.hex ?? a.icao ?? a.icao24)?.toLowerCase();
  if (!icao24) return null;

  let alt = a.alt_baro;
  if (alt === "ground") alt = 0;
  if (alt === undefined || alt === null) alt = a.alt_geom ?? a.altitude;

  const trk = num(a.track ?? a.true_heading ?? a.heading ?? a.mag_heading);
  const spd = num(a.gs ?? a.speed ?? a.velocity);

  return {
    icao24, ts,
    callsign: texte(a.flight ?? a.callsign),
    reg: texte(a.r ?? a.registration),
    actype: texte(a.t ?? a.type),
    lat, lon,
    alt: num(alt) === null ? null : Math.round(num(alt) as number),
    /* smallint : on borne pour ne pas faire déborder la colonne. */
    trk: trk === null ? null : Math.max(0, Math.min(360, Math.round(trk))),
    spd: spd === null ? null : Math.max(0, Math.min(32000, Math.round(spd))),
  };
}

export function extraire(data: unknown, ts: string): Fix[] {
  const brut = Array.isArray(data)
    ? data
    : (data as Record<string, unknown>)?.ac ??
      (data as Record<string, unknown>)?.aircraft;
  if (!Array.isArray(brut)) return [];

  const vus = new Set<string>();
  const out: Fix[] = [];
  for (const a of brut) {
    const f = normalise(a as Record<string, unknown>, ts);
    /*  Un même appareil peut apparaître deux fois dans une réponse ; la clé
        primaire le refuserait, autant l'écarter ici.                     */
    if (f && !vus.has(f.icao24)) { vus.add(f.icao24); out.push(f); }
  }
  return out;
}

/* Horodatage aligné à la minute : c'est ce qui rend l'insertion idempotente. */
export function minuteCourante(now = new Date()): string {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return Response.json({ error: "environnement Supabase incomplet" }, { status: 500 });
  }

  const amont = SOURCES[SOURCE] ?? SOURCES["adsb.lol"];
  const nm = Math.round(Math.min(Math.max(RAYON_NM, 5), 250));

  let data: unknown;
  try {
    const r = await fetch(amont(CENTRE.lat, CENTRE.lon, nm), {
      headers: { Accept: "application/json", "User-Agent": "carteradar/1.0 (historique personnel)" },
    });
    if (!r.ok) return Response.json({ error: `source ${SOURCE} : HTTP ${r.status}` }, { status: 502 });
    data = await r.json();
  } catch (e) {
    return Response.json({ error: `source ${SOURCE} injoignable : ${e}` }, { status: 502 });
  }

  const ts = minuteCourante();
  const fixes = extraire(data, ts);
  if (!fixes.length) return Response.json({ ts, inserted: 0, note: "aucun appareil" });

  /*  on_conflict + Prefer: resolution=ignore-duplicates — une minute déjà
      écrite n'est pas réécrite, et l'appel reste sans effet.            */
  const rep = await fetch(`${url}/rest/v1/plane_fix?on_conflict=icao24,ts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(fixes),
  });

  if (!rep.ok) {
    return Response.json({ error: `écriture refusée : ${rep.status} ${await rep.text()}` }, { status: 500 });
  }
  return Response.json({ ts, inserted: fixes.length, source: SOURCE, radius_nm: nm });
});
