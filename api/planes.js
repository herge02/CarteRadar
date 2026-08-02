/*  Relais pour le trafic aérien.

    Les flux ADS-B communautaires ne renvoient pas d'en-tête
    Access-Control-Allow-Origin : un navigateur refuse donc de lire leur
    réponse, et l'appel échoue avec un « Failed to fetch » dépourvu de code
    HTTP. Rien de cassé du côté de la source — c'est la politique d'origine
    du navigateur qui s'interpose.

    Cette fonction s'exécute chez Vercel, pas dans le navigateur : la requête
    part d'un serveur, où cette politique ne s'applique pas, et le résultat
    revient depuis notre propre origine. C'est le seul morceau de code du
    projet qui ne tourne pas chez le visiteur.

    Aucune clé n'est en jeu : ces sources sont ouvertes. Le relais sert à
    contourner le CORS, pas à cacher un secret.                            */

const SOURCES = {
  "adsb.lol": function(lat, lon, nm){
    return "https://api.adsb.lol/v2/lat/" + lat + "/lon/" + lon + "/dist/" + nm;
  },
  "airplanes.live": function(lat, lon, nm){
    return "https://api.airplanes.live/v2/point/" + lat + "/" + lon + "/" + nm;
  }
};

module.exports = async function handler(req, res){
  const url = new URL(req.url, "https://" + (req.headers.host || "localhost"));
  const q   = url.searchParams;

  /*  Number(null) vaut zéro : un paramètre absent passerait pour une
      latitude valide, au large de l'Afrique. On exige une valeur écrite. */
  const rawLat = q.get("lat"), rawLon = q.get("lon");
  const lat = (rawLat === null || rawLat.trim() === "") ? NaN : Number(rawLat);
  const lon = (rawLon === null || rawLon.trim() === "") ? NaN : Number(rawLon);
  const src = SOURCES[q.get("source")] ? q.get("source") : "adsb.lol";

  /*  Le rayon est borné : un client ne doit pas pouvoir demander la planète
      entière à une source tenue par des bénévoles.                       */
  const nm = Math.round(Math.min(Math.max(Number(q.get("dist")) || 120, 5), 250));

  if(!Number.isFinite(lat) || !Number.isFinite(lon)
     || Math.abs(lat) > 90 || Math.abs(lon) > 180){
    res.status(400).json({ error: "latitude ou longitude invalide" });
    return;
  }

  const upstream = SOURCES[src](lat.toFixed(4), lon.toFixed(4), nm);

  try {
    const r = await fetch(upstream, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "carteradar/1.0 (console radar personnelle)"
      }
    });

    if(!r.ok){
      res.status(502).json({ error: "source " + src + " : HTTP " + r.status });
      return;
    }

    const body = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    /*  Dix secondes de cache en périphérie : plusieurs onglets, ou plusieurs
        visiteurs, ne martèlent pas la source pour la même zone.          */
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=10, stale-while-revalidate=20");
    res.setHeader("X-Source", src);
    res.status(200).send(body);

  } catch(e){
    res.status(502).json({ error: "source " + src + " injoignable : " + e.message });
  }
};
