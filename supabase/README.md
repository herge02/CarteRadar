# Historique du trafic aérien — mise en service

**Une seule opération : coller `schema.sql` dans l'éditeur SQL de Supabase.**

Pas de ligne de commande, pas de fonction à déployer, aucun secret à
manipuler. La collecte s'exécute dans la base elle-même, par `pg_cron` et
`pg_net`, tous deux fournis d'office sur le plan gratuit.

---

## L'unique étape

Tableau de bord → **SQL Editor** → **New query** → coller tout le contenu de
`schema.sql` → **Run**.

### Si l'éditeur refuse un collage aussi long

`schema.sql` fait 239 lignes. Le dossier `morceaux/` contient exactement le
même contenu découpé en **quatre fichiers de moins de cent lignes**, à coller
l'un après l'autre, dans l'ordre :

| Fichier | Lignes | Contenu |
|---|--:|---|
| `morceaux/1-tables.sql` | 64 | extensions, tables, index, sécurité |
| `morceaux/2-demande.sql` | 38 | `request_planes()` — dépose la requête |
| `morceaux/3-digestion.sql` | 88 | `ingest_planes()` — verse les réponses |
| `morceaux/4-purge-et-horaire.sql` | 40 | `purge_plane_fix()` et les trois tâches |

L'ordre compte : le dernier morceau programme des tâches qui appellent les
fonctions des précédents. Chaque morceau se recolle sans dommage — les tables
sont créées `if not exists`, les fonctions `create or replace`, et les tâches
sont déprogrammées avant d'être reprogrammées.

Les deux voies donnent une base identique — tables, colonnes, politiques,
fonctions et tâches — ce qui a été vérifié en installant les deux côte à côte
sur un PostgreSQL 16 et en les comparant.

C'est fait. Trois tâches sont désormais programmées :

| Tâche | Cadence | Rôle |
|---|---|---|
| `collecte-avions` | chaque minute | dépose la requête vers la source ADS-B |
| `digestion-avions` | chaque minute | verse les réponses arrivées dans la table |
| `purge-avions` | chaque heure | efface au-delà de la rétention |

La collecte et la digestion sont séparées parce que `pg_net` travaille en
différé : la requête part, la réponse arrive quelques secondes plus tard. La
digestion ramasse donc ce qui est parvenu depuis son passage précédent. Ce
décalage d'une minute est sans conséquence pour un historique.

---

## Vérifier

Les tâches sont-elles là ?

```sql
select jobname, schedule, active from cron.job;
```

Deux ou trois minutes plus tard, la moisson :

```sql
select count(*) as relevés, min(ts) as depuis, max(ts) as jusqu
  from public.plane_fix;
```

Le compte doit croître d'environ le nombre d'appareils en vol, chaque minute.

Si la table reste vide, dans l'ordre :

```sql
-- les tâches s'exécutent-elles ?
select jobname, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;

-- la source répond-elle ?
select id, status_code, left(content, 160), created
  from net._http_response order by id desc limit 5;
```

Un `status_code` à 200 avec du JSON signale que la collecte fonctionne et que
le problème est en aval ; l'absence de toute ligne signale que la requête ne
part pas.

---

## Régler

Tout se change par une mise à jour, sans retoucher au code :

```sql
update public.plane_config set
  radius_nm  = 200,               -- rayon enregistré, de 5 à 250 NM
  keep_hours = 48,                -- profondeur de l'historique
  source     = 'airplanes.live',  -- ou 'adsb.lol'
  lat = 45.65, lon = -73.85;      -- centre de la zone
```

La modification prend effet à la minute suivante.

---

## Ce que ça consomme

Le plan gratuit donne 500 Mo de base et 5 Go de trafic sortant par mois. Rien
ici n'utilise de fonction Edge, donc ce quota-là reste entier.

| Poste | Consommation | Quota |
|---|---|---|
| Base, rayon 120 NM, rétention 24 h | ~30 Mo, stationnaire | 6 % |
| Trafic sortant, un chargement de 3 h | ~400 Ko compressés | négligeable |

**La purge n'est pas facultative.** Sans elle, une trentaine de mégaoctets
s'ajoutent chaque jour et les 500 Mo sont atteints en trois semaines. Avec
elle, le volume ne bouge plus.

Un projet gratuit se met en veille après sept jours **sans aucune requête**.
Une collecte à la minute écrit en permanence : la veille ne se déclenchera pas
tant que les tâches tournent.

---

## Tout arrêter

```sql
select cron.unschedule('collecte-avions');
select cron.unschedule('digestion-avions');
select cron.unschedule('purge-avions');
```

La table demeure. Pour la vider aussi : `truncate public.plane_fix;`

---

## Les limites, dites franchement

**L'enregistrement porte sur un point fixe.** La collecte interroge un cercle
autour d'un centre unique. En déplaçant la carte vers Québec ou Sherbrooke,
vous verrez le direct mais pas d'archive — la console vous le signale par le
trait de couverture sous la ligne du temps.

**L'historique commence à l'installation.** Rien ne permet de remonter avant :
les archives publiques d'adsb.lol paraissent le lendemain, en fichiers
quotidiens, et ne couvrent donc jamais les trois dernières heures.

**La clé publiable figure dans le code de la console.** C'est son emploi
prévu : elle n'ouvre que la lecture de `plane_fix`, des positions déjà
diffusées en clair par les transpondeurs. Les tables de réglage et d'état
restent fermées, et aucune politique n'autorise l'écriture où que ce soit.
