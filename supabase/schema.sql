-- =====================================================================
--  Historique du trafic aérien — tout tient dans ce fichier.
--
--  À coller dans l'éditeur SQL de Supabase, une seule fois. Aucune ligne de
--  commande, aucune fonction à déployer, aucun secret à manipuler : la
--  collecte s'exécute dans la base elle-même, par pg_cron et pg_net.
--
--  Pourquoi. Aucune source ADS-B gratuite ne rend les positions passées —
--  l'archive d'adsb.lol paraît le lendemain. Le seul historique possible est
--  celui qu'on enregistre soi-même, en continu, sans dépendre d'un
--  navigateur ouvert.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------- réglages
--  Tout se change ici, sans toucher au code :
--     update public.plane_config set radius_nm = 200, keep_hours = 48;
create table if not exists public.plane_config (
  id         smallint primary key default 1 check (id = 1),
  lat        double precision not null default 45.65,   -- Blainville
  lon        double precision not null default -73.85,
  radius_nm  integer not null default 120 check (radius_nm between 5 and 250),
  source     text    not null default 'adsb.lol'
             check (source in ('adsb.lol', 'airplanes.live')),
  keep_hours integer not null default 24 check (keep_hours between 1 and 168)
);
insert into public.plane_config (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------ table
create table if not exists public.plane_fix (
  icao24   text        not null,
  ts       timestamptz not null,
  callsign text,
  reg      text,
  actype   text,
  lat      double precision not null,
  lon      double precision not null,
  alt      integer,
  trk      smallint,
  spd      smallint,

  --  L'horodatage est aligné à la minute : la clé primaire rend donc la
  --  collecte idempotente. Une minute déjà écrite ne se réécrit pas.
  primary key (icao24, ts)
);

create index if not exists plane_fix_ts_idx     on public.plane_fix (ts desc);
create index if not exists plane_fix_ts_pos_idx on public.plane_fix (ts desc, lat, lon);

--  Marque la dernière réponse digérée, pour ne pas relire deux fois.
create table if not exists public.plane_ingest (
  id            smallint primary key default 1 check (id = 1),
  last_response bigint not null default 0
);
insert into public.plane_ingest (id) values (1) on conflict (id) do nothing;

-- --------------------------------------------------------------- sécurité
alter table public.plane_fix    enable row level security;
alter table public.plane_config enable row level security;
alter table public.plane_ingest enable row level security;

--  Lecture ouverte sur les positions seules : elles sont déjà publiques,
--  diffusées en clair par les transpondeurs. Les deux autres tables restent
--  fermées — aucune politique n'y donne accès.
drop policy if exists "lecture publique" on public.plane_fix;
create policy "lecture publique"
  on public.plane_fix for select to anon, authenticated using (true);

--  Aucune politique d'écriture nulle part : seules les fonctions ci-dessous,
--  en security definer, alimentent la table.

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

-- ------------------------------------------------------------------ purge
--  Sans elle, la base se remplit. Avec elle, le volume est stationnaire.
create or replace function public.purge_plane_fix()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  h       integer;
  removed integer;
begin
  select keep_hours into h from public.plane_config where id = 1;
  delete from public.plane_fix where ts < now() - make_interval(hours => coalesce(h, 24));
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ------------------------------------------------------------ ordonnancement
select cron.unschedule('collecte-avions')
 where exists (select 1 from cron.job where jobname = 'collecte-avions');
select cron.unschedule('digestion-avions')
 where exists (select 1 from cron.job where jobname = 'digestion-avions');
select cron.unschedule('purge-avions')
 where exists (select 1 from cron.job where jobname = 'purge-avions');

--  La demande part chaque minute ; la digestion suit une minute plus tard et
--  ramasse ce qui est arrivé entre-temps. Ce décalage d'une minute est sans
--  conséquence pour un historique.
select cron.schedule('collecte-avions',  '* * * * *', $$ select public.request_planes(); $$);
select cron.schedule('digestion-avions', '* * * * *', $$ select public.ingest_planes();  $$);

--  Purge à la septième minute de chaque heure, hors des pointes rondes.
select cron.schedule('purge-avions',     '7 * * * *', $$ select public.purge_plane_fix(); $$);

-- ------------------------------------------------------------- vérification
--  Les trois tâches, actives :
--     select jobname, schedule, active from cron.job;
--  La moisson, deux ou trois minutes plus tard :
--     select count(*) as relevés, min(ts) as depuis, max(ts) as jusqu
--       from public.plane_fix;
--  En cas de silence, le journal des tâches :
--     select jobname, status, return_message, start_time
--       from cron.job_run_details order by start_time desc limit 20;
--  Et les réponses brutes reçues par pg_net :
--     select id, status_code, left(content, 120), created
--       from net._http_response order by id desc limit 5;
