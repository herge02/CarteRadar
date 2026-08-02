-- =====================================================================
--  Historique du trafic aérien — schéma, sécurité, purge et ordonnancement
--
--  À coller tel quel dans l'éditeur SQL de Supabase, une seule fois.
--  Rien ici ne contient de secret : la collecte s'authentifie toute seule,
--  côté Supabase, avec la clé de service que la fonction Edge reçoit de son
--  environnement.
--
--  Pourquoi ce montage. Aucune source ADS-B gratuite ne rend les positions
--  passées — l'archive d'adsb.lol paraît le lendemain. Le seul historique
--  possible est celui qu'on enregistre soi-même, en continu, indépendamment
--  de tout navigateur ouvert. C'est ce que fait la tâche planifiée.
-- =====================================================================

-- ---------------------------------------------------------------- table
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

  --  L'horodatage est aligné à la minute par la collecte : la clé primaire
  --  rend donc l'insertion idempotente. Un double déclenchement de la tâche
  --  ne crée pas de doublon, il ne fait rien.
  primary key (icao24, ts)
);

--  La lecture se fait toujours par fenêtre de temps, souvent restreinte à
--  l'emprise de la carte.
create index if not exists plane_fix_ts_idx      on public.plane_fix (ts desc);
create index if not exists plane_fix_ts_pos_idx  on public.plane_fix (ts desc, lat, lon);

-- ------------------------------------------------------------- sécurité
alter table public.plane_fix enable row level security;

--  Lecture ouverte : ces positions sont déjà publiques, diffusées en clair
--  par les transpondeurs et republiées par des réseaux communautaires.
drop policy if exists "lecture publique" on public.plane_fix;
create policy "lecture publique"
  on public.plane_fix for select
  to anon, authenticated
  using (true);

--  Aucune politique d'écriture : seule la clé de service, qui contourne ces
--  politiques, peut insérer. La clé publiée dans la console ne le peut pas.

-- ----------------------------------------------------------------- purge
--  Sans elle, la base se remplit. Avec elle, le volume est stationnaire.
create or replace function public.purge_plane_fix(keep_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.plane_fix
   where ts < now() - make_interval(hours => keep_hours);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ------------------------------------------------------- ordonnancement
create extension if not exists pg_cron;
create extension if not exists pg_net;

--  Collecte : chaque minute. L'appel ne porte aucune autorisation — la
--  fonction est déployée en accès libre (--no-verify-jwt) et se contente
--  d'écrire un relevé pour la minute courante. La clé primaire rend
--  l'opération sans effet si elle est déclenchée deux fois.
select cron.unschedule('collecte-avions')
 where exists (select 1 from cron.job where jobname = 'collecte-avions');

select cron.schedule(
  'collecte-avions',
  '* * * * *',
  $cron$
    select net.http_post(
      url     := 'https://wmybeiknqecgjjzpnrju.supabase.co/functions/v1/collect-planes',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $cron$
);

--  Purge : chaque heure, à la septième minute — hors des pointes rondes où
--  se bousculent les autres tâches.
select cron.unschedule('purge-avions')
 where exists (select 1 from cron.job where jobname = 'purge-avions');

select cron.schedule(
  'purge-avions',
  '7 * * * *',
  $cron$ select public.purge_plane_fix(24); $cron$
);

-- ------------------------------------------------------------ vérification
--  Les deux tâches doivent apparaître, actives :
--     select jobname, schedule, active from cron.job;
--  Le journal des exécutions, en cas de doute :
--     select jobname, status, return_message, start_time
--       from cron.job_run_details order by start_time desc limit 20;
--  Et la moisson :
--     select count(*), min(ts), max(ts) from public.plane_fix;
