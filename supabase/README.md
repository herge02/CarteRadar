# Historique du trafic aérien — mise en service

Trois étapes, une seule fois. Rien à installer sur votre machine si vous
passez par le tableau de bord.

Le projet visé est `wmybeiknqecgjjzpnrju`. Si vous en changez, il faut
retoucher deux endroits : l'URL dans `schema.sql` et la constante `SUPABASE`
en tête de `assets/radar-core.js`.

---

## 1. Le schéma

Tableau de bord Supabase → **SQL Editor** → coller tout `schema.sql` → **Run**.

Cela crée la table, ouvre la lecture publique, ferme l'écriture, installe la
purge et programme les deux tâches. Aucun secret n'y figure.

Vérification, dans le même éditeur :

```sql
select jobname, schedule, active from cron.job;
```

Deux lignes doivent apparaître, `collecte-avions` chaque minute et
`purge-avions` chaque heure.

---

## 2. La fonction de collecte

Elle doit être déployée **en accès libre**, parce que l'appel de `pg_cron` ne
porte aucune autorisation. Ce n'est pas une brèche : la fonction ne fait
qu'écrire un relevé pour la minute courante, et la clé primaire de la table
rend un second appel sans effet.

### Par la ligne de commande

```sh
npx supabase login
npx supabase link --project-ref wmybeiknqecgjjzpnrju
npx supabase functions deploy collect-planes --no-verify-jwt
```

### Par le tableau de bord

**Edge Functions** → **Deploy a new function** → nom `collect-planes` →
coller le contenu de `functions/collect-planes/index.ts` → décocher
**Verify JWT** → déployer.

### Réglages facultatifs

Dans **Edge Functions → collect-planes → Secrets** :

| Variable | Défaut | Effet |
|---|---|---|
| `PLANES_RADIUS_NM` | `120` | Rayon enregistré autour de Blainville, borné à 250 |
| `PLANES_SOURCE` | `adsb.lol` | Ou `airplanes.live` |

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont fournies d'office par
Supabase. **N'y touchez pas et ne les recopiez nulle part** : c'est la seule
clé du montage qui doive rester secrète, et elle ne quitte jamais Supabase.

---

## 3. Vérifier que ça moissonne

Attendez deux minutes, puis :

```sql
select count(*) as relevés, min(ts) as depuis, max(ts) as jusqu
  from public.plane_fix;
```

Le compte doit croître d'environ le nombre d'appareils en vol à chaque
minute. Si la table reste vide :

```sql
select jobname, status, return_message, start_time
  from cron.job_run_details
 order by start_time desc limit 20;
```

Puis le journal de la fonction, dans **Edge Functions → collect-planes →
Logs**. Une réponse `{"ts":…,"inserted":N}` signale une collecte réussie.

---

## Ce que ça consomme

Le plan gratuit donne 500 Mo de base, 5 Go de trafic sortant par mois et
500 000 invocations de fonction.

| Poste | Consommation | Quota |
|---|---|---|
| Invocations | 43 200 par mois | 9 % |
| Base, rayon 120 NM, rétention 24 h | ~30 Mo, stationnaire | 6 % |
| Trafic sortant, un chargement de 3 h | ~400 Ko compressés | négligeable |

**La purge n'est pas facultative.** Sans elle, 30 Mo s'ajoutent chaque jour et
les 500 Mo sont atteints en trois semaines. Avec elle, le volume ne bouge
plus. Pour garder davantage — six heures suffisent au radar, mais la journée
entière permet de remonter plus loin — changez l'argument :

```sql
select cron.unschedule('purge-avions');
select cron.schedule('purge-avions', '7 * * * *',
  $$ select public.purge_plane_fix(48); $$);   -- 48 heures
```

Un projet gratuit se met en veille après sept jours **sans aucune requête**.
Une collecte à la minute écrit en permanence : la veille ne se déclenchera
pas tant que les tâches tournent.

---

## Les limites, dites franchement

**L'enregistrement porte sur un point fixe.** La collecte interroge un cercle
autour de Blainville. En déplaçant la carte vers Québec ou Sherbrooke, vous
verrez le direct mais pas d'archive — la console vous le signalera par le
trait de couverture sous la ligne du temps.

**L'historique commence au déploiement.** Il n'existe aucun moyen de remonter
avant : les archives publiques d'adsb.lol paraissent le lendemain, en fichiers
quotidiens, et ne couvrent donc jamais les trois dernières heures.

**La clé publiable est publique.** C'est prévu ainsi : elle n'ouvre que la
lecture d'une table de positions déjà diffusées en clair par les
transpondeurs. La sécurité tient à la politique d'accès, pas au secret.
