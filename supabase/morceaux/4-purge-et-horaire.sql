-- Morceau 4 sur 4 — purge et ordonnancement
-- À coller seul dans l'éditeur SQL de Supabase, puis « Run ».
-- Les quatre morceaux se collent dans l'ordre ; chacun tient sous
-- cent lignes. Le fichier entier reste dans schema.sql.

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
