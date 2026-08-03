-- Morceau 2 sur 4 — la demande
-- À coller seul dans l'éditeur SQL de Supabase, puis « Run ».
-- Les quatre morceaux se collent dans l'ordre ; chacun tient sous
-- cent lignes. Le fichier entier reste dans schema.sql.

-- ---------------------------------------------------------------- collecte
--  Étape 1 — la demande. pg_net travaille en différé : cet appel ne fait que
--  déposer la requête, la réponse arrivera quelques secondes plus tard.
create or replace function public.request_planes()
returns bigint
language plpgsql
security definer
set search_path = public, net
as $$
declare
  c public.plane_config;
  cible text;
begin
  select * into c from public.plane_config where id = 1;

  cible := case c.source
    when 'airplanes.live' then
      format('https://api.airplanes.live/v2/point/%s/%s/%s',
             to_char(c.lat, 'FM990.0999'), to_char(c.lon, 'FM990.0999'), c.radius_nm)
    else
      format('https://api.adsb.lol/v2/lat/%s/lon/%s/dist/%s',
             to_char(c.lat, 'FM990.0999'), to_char(c.lon, 'FM990.0999'), c.radius_nm)
  end;

  return net.http_get(
    url     := cible,
    headers := jsonb_build_object(
                 'Accept', 'application/json',
                 'User-Agent', 'carteradar/1.0 (historique personnel)'),
    timeout_milliseconds := 20000
  );
end;
$$;
