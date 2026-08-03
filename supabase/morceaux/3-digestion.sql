-- Morceau 3 sur 4 — la digestion
-- À coller seul dans l'éditeur SQL de Supabase, puis « Run ».
-- Les quatre morceaux se collent dans l'ordre ; chacun tient sous
-- cent lignes. Le fichier entier reste dans schema.sql.

--  Étape 2 — la digestion. Elle lit les réponses parvenues depuis la
--  dernière fois et les verse dans la table. Une réponse illisible est
--  passée sans bloquer les suivantes.
create or replace function public.ingest_planes()
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  dernier bigint;
  ajoutes integer := 0;
  n       integer;
  r       record;
  liste   jsonb;
begin
  select last_response into dernier from public.plane_ingest where id = 1;

  for r in
    select id, content, created
      from net._http_response
     where id > coalesce(dernier, 0)
       and status_code = 200
       and content is not null
     order by id
     limit 30
  loop
    begin
      --  Les sources ne s'accordent pas sur l'enveloppe : objet muni d'un
      --  champ « ac », ou « aircraft », ou tableau nu.
      liste := coalesce(
        r.content::jsonb -> 'ac',
        r.content::jsonb -> 'aircraft',
        case when jsonb_typeof(r.content::jsonb) = 'array'
             then r.content::jsonb else '[]'::jsonb end);

      insert into public.plane_fix
             (icao24, ts, callsign, reg, actype, lat, lon, alt, trk, spd)
      select distinct on (lower(a ->> 'hex'))
             lower(a ->> 'hex'),
             date_trunc('minute', r.created),
             nullif(btrim(coalesce(a ->> 'flight', a ->> 'callsign', '')), ''),
             nullif(btrim(coalesce(a ->> 'r', '')), ''),
             nullif(btrim(coalesce(a ->> 't', '')), ''),
             (a ->> 'lat')::double precision,
             (a ->> 'lon')::double precision,
             --  « ground » vaut zéro ; à défaut d'altitude barométrique on
             --  se rabat sur la géométrique.
             case
               when a ->> 'alt_baro' = 'ground' then 0
               when (a ->> 'alt_baro') ~ '^-?[0-9]+(\.[0-9]+)?$'
                 then round((a ->> 'alt_baro')::numeric)::integer
               when (a ->> 'alt_geom') ~ '^-?[0-9]+(\.[0-9]+)?$'
                 then round((a ->> 'alt_geom')::numeric)::integer
             end,
             --  Bornés : la colonne est un smallint, une valeur aberrante
             --  la ferait déborder et perdrait toute la réponse.
             case when (a ->> 'track') ~ '^-?[0-9]+(\.[0-9]+)?$'
                  then least(360, greatest(0, round((a ->> 'track')::numeric)))::smallint end,
             case when (a ->> 'gs') ~ '^-?[0-9]+(\.[0-9]+)?$'
                  then least(32000, greatest(0, round((a ->> 'gs')::numeric)))::smallint end
        from jsonb_array_elements(liste) a
       where nullif(btrim(coalesce(a ->> 'hex', '')), '') is not null
         and (a ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$'
         and (a ->> 'lon') ~ '^-?[0-9]+(\.[0-9]+)?$'
       order by lower(a ->> 'hex')
      on conflict (icao24, ts) do nothing;

      get diagnostics n = row_count;
      ajoutes := ajoutes + n;

    exception when others then
      --  Réponse tronquée, JSON invalide, forme inattendue : on l'enjambe.
      null;
    end;

    dernier := r.id;
  end loop;

  update public.plane_ingest set last_response = coalesce(dernier, last_response) where id = 1;
  return ajoutes;
end;
$$;
