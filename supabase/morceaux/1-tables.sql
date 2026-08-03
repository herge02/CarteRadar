-- Morceau 1 sur 4 — extensions, tables, sécurité
-- À coller seul dans l'éditeur SQL de Supabase, puis « Run ».
-- Les quatre morceaux se collent dans l'ordre ; chacun tient sous
-- cent lignes. Le fichier entier reste dans schema.sql.

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
