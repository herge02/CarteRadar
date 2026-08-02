# Console radar — Sud du Québec

Boucle radar animée pour le sud du Québec, à partir du service WMS **GeoMet**
d'Environnement et Changement climatique Canada. Site statique, sans dépendance
de compilation : Leaflet est chargé depuis un CDN, tout le reste est du HTML,
du CSS et du JavaScript écrits à la main.

Deux interfaces distinctes partagent le même moteur :

| Adresse   | Pour                          | Ce qui change                                                                 |
|-----------|-------------------------------|-------------------------------------------------------------------------------|
| `/pc`     | Écran large, souris, clavier   | Tiroir latéral, règle graduée à l'heure, raccourcis clavier                   |
| `/mobile` | Téléphone, tablette, tactile   | Bandes haute et basse, feuille de réglages, gros curseur, géolocalisation     |

La racine `/` détecte l'appareil et redirige. Le choix est mémorisé.

## Structure

```
index.html                 aiguillage /pc ou /mobile
api/planes.js              relais serveur pour le trafic aérien (contournement CORS)
pc/index.html              console bureau
mobile/index.html          console mobile
assets/radar-core.js       moteur commun : GeoMet, boucle d'images, fonds de carte
assets/theme.css           palette et éléments partagés
assets/pc.css              mise en page bureau
assets/mobile.css          mise en page mobile
vercel.json                URL propres et en-têtes
manifest.webmanifest       installation sur l'écran d'accueil
```

Le fichier `assets/radar-core.js` contient toute la logique météo : lecture de
l'axe temps dans le `GetCapabilities`, construction des couches WMS, lecture,
rafraîchissement aux six minutes, `GetFeatureInfo` pour l'intensité au point.

L'axe temps est lu sous toutes les formes que la norme WMS autorise, parce que
GeoMet en emploie plusieurs selon le produit :

- **où le trouver** — `<Dimension name="time">` de la version 1.3.0, ou le
  couple `<Dimension/>` déclaratif et `<Extent name="time">` de la 1.1.1 ; à
  défaut, l'attribut `default`, qui donne au moins l'image courante ;
- **comment le lire** — intervalle `début/fin/pas` ou liste d'instants séparés
  par des virgules, y compris mêlés dans une même valeur ;
- **les durées** ISO 8601 au complet, le `M` valant mois avant le `T` et
  minutes après.

Quand rien de tout cela n'est trouvé, le message d'erreur emporte un portrait
du document reçu — élément racine, nombre de `Layer`, `Dimension` et `Extent`,
premiers noms de couches. Un échec d'analyse se distingue ainsi d'une panne du
service sans avoir à ouvrir les outils de développement.

Les deux pages ne font qu'y brancher leurs commandes. Une correction du moteur
profite donc aux deux versions.

## Fonctions

- **Pile de couches animées** : plusieurs couches WMS se superposent, chacune
  avec sa propre opacité, sa propre cadence et son propre axe temps. La ligne
  du temps de la console est l'union des instants de toutes les pistes ; à
  chaque pas, une piste montre l'image la plus proche qu'elle possède. Un
  radar aux 6 minutes et un satellite aux 10 cohabitent donc sans trou ni
  clignotement.

  L'ordre d'empilement suit l'ordre d'ajout : la dernière ajoutée passe
  au-dessus.

- **Produits de départ** : deux composites radar 1 km — `RADAR_1KM_RRAI`
  (mm/h) et `RADAR_1KM_RSNO` (cm/h), proposés en raccourcis. « Pluie » et
  « neige » désignent la table de conversion appliquée à l'écho, pas ce qui
  tombe réellement.

  La table `PRODUCTS`, au début de `assets/radar-core.js`, ne sert plus qu'à
  ces raccourcis outillés — couverture radar associée, unité connue. Tout le
  reste passe par le catalogue. **N'y inscrire qu'un identifiant relevé dans
  le `GetCapabilities` du service** : deux couches de réflectivité y ont
  figuré sur la foi d'un annuaire tiers qui republie GeoMet, et le service
  les refuse avec `InvalidLayersParameter`.

- **Boucle** : jusqu'à 30 images, soit les trois dernières heures. Arrêt d'une
  seconde et demie sur la dernière image avant de reboucler, comme les boucles
  d'ECCC.
- **Rafraîchissement** : vérification chaque minute ; les nouvelles images sont
  ajoutées sans rebâtir la pile, et les plus vieilles sont retirées.
- **Lecture au point** : un clic ou une touche donne une valeur **par couche
  empilée**, chacune à l'image qu'elle montre à cet instant.
- **Catalogue** : la console interroge le `GetCapabilities` complet et liste
  les couches réellement servies, filtrées par identifiant ou par intitulé.
  Celles qui portent un axe temps sont marquées d'un ▶ et s'animent d'un clic ;
  les autres se posent en couche fixe. L'unité est tirée de l'intitulé, que
  GeoMet termine par des crochets — « … [dBZ] ».

  Le document pèse lourd : il n'est demandé qu'à la demande explicite, puis
  gardé en mémoire pour la session. Il est parcouru en texte, sans construire
  d'arbre DOM, pour rester tenable sur téléphone.

  C'est la seule liste faisant foi. Un annuaire tiers qui republie GeoMet ne
  l'est pas — voir la note sur `PRODUCTS`.

- **Couches libres** : un identifiant peut aussi être saisi à la main, par
  exemple `HRDPS.CONTINENTAL_PR`.
- **Trafic aérien** : les avions se posent en surimpression, orientés selon
  leur cap et colorés par bande d'altitude. La source est un flux ADS-B
  communautaire — `adsb.lol`, sans clé ni compte — **étrangère à GeoMet**.

  Deux modes. **En direct** par défaut : la flotte affichée est celle de
  maintenant, quelle que soit l'image radar sous elle. **Suivre la boucle** :
  les décalages sont appariés, l'image d'il y a trente minutes montrant les
  avions d'il y a trente minutes. Ce second mode ne peut rien montrer avant
  l'ouverture de la page — la source ne diffuse que l'instant présent, et
  rien n'est inventé pour combler.

  Les relevés sont pris toutes les 15 secondes, jamais en arrière-plan. Deux
  sources sont proposées, `adsb.lol` et `airplanes.live` : si l'une flanche,
  l'autre est à un clic.

  **L'historique est celui qu'on a soi-même relevé — il n'en existe pas
  d'autre.** Aucune source gratuite ne rend les positions passées : l'archive
  d'adsb.lol paraît le lendemain, en fichiers quotidiens, ce qui ne couvre
  jamais les trois dernières heures. Les relevés sont donc conservés dans
  IndexedDB et rechargés d'une visite à l'autre, pour que la mémoire s'étende
  au lieu de repartir de zéro. Un point par appareil et par 45 secondes
  suffit : la boucle radar bat aux six minutes.

  En mode « suivre la boucle », un trait bleu sous la ligne du temps marque la
  portion de la boucle qui dispose de positions. Hors de cette plage, la carte
  reste vide plutôt que de montrer des avions au mauvais moment. Un bouton
  efface la mémoire.

  **Ces flux passent par `api/planes.js`, pas en direct.** Ils ne renvoient
  aucun en-tête `Access-Control-Allow-Origin`, et un navigateur refuse donc de
  lire leur réponse — l'appel échoue en « Failed to fetch », sans code HTTP.
  Le relais fait la requête côté serveur, où la politique d'origine ne
  s'applique pas. C'est le seul morceau du projet qui ne tourne pas chez le
  visiteur. Aucune clé n'y est en jeu : ces sources sont ouvertes, le relais
  contourne le CORS, il ne cache pas un secret.

  Le relais borne le rayon à 250 milles nautiques et n'accepte que les deux
  hôtes nommés — un client ne peut pas s'en servir pour atteindre autre chose.
  Ses réponses sont mises en cache dix secondes en périphérie, pour que
  plusieurs onglets ne martèlent pas une source tenue par des bénévoles.
- **Mémoire** : la pile de couches avec leurs opacités, la vitesse, le fond de
  carte et la dernière position sont conservés dans le navigateur. Une couche
  que le service ne sert plus est signalée au rechargement, pas subie.
- **Économie** : la lecture s'arrête quand l'onglet passe en arrière-plan. La
  version mobile charge 15 images par défaut plutôt que 30.

### Raccourcis clavier — version bureau

| Touche         | Effet                    |
|----------------|--------------------------|
| Espace         | Lecture / pause          |
| ← / →          | Image précédente / suivante |

## Déploiement sur Vercel

Aucune étape de compilation.

1. Dans Vercel, **Add New → Project**, puis importer ce dépôt.
2. Framework Preset : **Other**.
3. Build Command : laisser vide. Output Directory : laisser vide (racine).
4. Déployer.

`vercel.json` active `cleanUrls`, ce qui donne les adresses `/pc` et `/mobile`
sans le suffixe `.html`. Vercel détecte seul le contenu de `api/` et le déploie
en fonction serverless — rien à configurer.

Le trafic aérien est la seule fonction qui en dépende : sur un hébergement
purement statique, la console fonctionne, mais le trafic annonce que le relais
n'est pas déployé.

### Cache

Les pages et les fichiers de `assets/` sont servis en `no-cache` : le
navigateur les garde, mais revalide avant chaque usage, et reçoit un 304 tant
que rien n'a changé. Les liens vers `assets/` portent en plus une marque de
version (`?v=10`).

Cette prudence a une raison. Un `stale-while-revalidate` généreux sur les
assets a déjà servi un `radar-core.js` périmé avec un HTML à jour : les deux
fichiers d'un même déploiement se désynchronisent, et la panne qui en résulte
ressemble à une panne du service. Le pied du tiroir, comme celui de la feuille
de réglages, affiche donc **le numéro de version du moteur** — s'il ne
correspond pas au dernier déploiement, c'est le cache, pas GeoMet.

À chaque modification d'un fichier de `assets/`, incrémenter `VERSION` en tête
de `radar-core.js` et la marque `?v=` dans les deux pages.

Essai local, sans Vercel :

```sh
python3 -m http.server 8080
```

Les adresses deviennent alors `/pc/` et `/mobile/` — le serveur intégré de
Python ne fait pas d'URL propres, et `/api/planes` n'existe pas, mais tout le
reste fonctionne.

## Forcer une version

- `/?v=pc` ou `/?v=mobile` — impose la version et la mémorise.
- Le lien en bas du tiroir, ou de la feuille de réglages, fait la bascule.

## Couleur

Les bandes d'altitude des avions suivent une rampe séquentielle à teinte
unique, du sombre au clair : sur fond noir, plus l'appareil vole haut, plus il
ressort — et le trafic de croisière, le plus nombreux, se lit d'un coup d'œil.
La rampe a été validée pour la monotonie de clarté, l'écart entre paliers et le
contraste du palier le plus sombre sur la surface. Chaque palier est nommé dans
l'échelle : la couleur ne porte jamais seule.

Les marqueurs portent un liseré sombre, parce qu'ils se posent sur de
l'imagerie quelconque et non sur une surface unie.

## Données

Imagerie radar © Environnement et Changement climatique Canada, service
[GeoMet](https://eccc-msc.github.io/open-data/). Trafic aérien : flux ADS-B
communautaire [adsb.lol](https://www.adsb.lol/), alimenté par des bénévoles.
Fonds de carte © OpenStreetMap et CARTO. Le site n'a pas de serveur : le
navigateur interroge chaque source directement.
