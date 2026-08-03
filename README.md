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
supabase/schema.sql        collecte, table, sécurité, purge et tâches — un seul collage
supabase/README.md         mise en service, pas à pas
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

- **Ligne du temps** : son pas est indépendant du rythme des images. Trente
  secondes par défaut, réglable de 15 s à 6 min. À chaque jalon, une couche
  animée montre la **dernière image parue** à cet instant — elle la garde donc
  affichée jusqu'à la suivante — tandis que les avions, eux, sont interpolés.
  C'est ce qui rend leur déplacement continu alors que l'imagerie avance par
  sauts.

  La dernière image parue, non la plus proche : à 10 h 10, l'image en vigueur
  est celle de 10 h 05, pas celle de 10 h 11, qui n'existait pas encore. Sans
  cette règle, le radar montrait par moments un instant que le curseur n'avait
  pas encore atteint.

  La ligne **court jusqu'à l'heure courante**, non jusqu'à la dernière image.
  GeoMet publie en différé : à toute heure, la plus récente a jusqu'à six
  minutes. S'arrêter à elle amputerait la ligne de ces minutes-là — justement
  celles où le trafic est connu en direct. La queue montre donc la dernière
  image, tenue, pendant que les avions avancent. Cette queue est bornée à une
  cadence d'image : si la source se tait une heure, la ligne s'arrête plutôt
  que d'afficher une heure de gel sans le dire.

  Les graduations de la règle marquent les **instants où une image existe**,
  pas les jalons : elles disent où l'imagerie change réellement. La queue n'en
  porte donc aucune — c'est l'attente de la prochaine image.

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

  Deux façons de les situer dans le temps. **En direct** par défaut : la
  flotte de maintenant, quelle que soit la position dans la boucle — ce mode
  fonctionne sans historique. **Suivre la ligne du temps** : les avions sont
  montrés à l'instant du curseur, ce qui demande d'avoir enregistré cet
  instant.

  Dans ce second mode, l'heure des avions est **celle du curseur, sans
  correction** : l'historique est daté en temps absolu et le jalon en est un.
  Un calcul antérieur passait par « maintenant, moins le retard de la dernière
  image » — hérité de l'époque où le tampon ne contenait que du direct. Il
  décalait la flotte de l'âge de l'image, jusqu'à six minutes, et c'est
  précisément ce qui la désaccordait du curseur.

  Ce second mode repose sur une **interpolation** : la collecte ne relève
  qu'une position par minute, une ligne du temps au pas de trente secondes
  n'aurait donc rien à montrer. Les positions intermédiaires sont calculées
  entre les deux relevés qui les encadrent — le cap sur l'écart replié, pour
  que le passage de 350° à 10° emprunte le chemin court. Au-delà de trois
  minutes entre deux relevés, l'appareil a probablement quitté la zone : rien
  n'est interpolé, car ce serait tracer une droite à travers le vide.

  Les relevés sont pris toutes les 15 secondes, jamais en arrière-plan. Deux
  sources sont proposées, `adsb.lol` et `airplanes.live` : si l'une flanche,
  l'autre est à un clic.

- **Traînées** : le chemin parcouru derrière chaque appareil, de deux à quinze
  minutes, effacé vers l'arrière. Elles s'arrêtent à l'instant du curseur et
  ne le devancent jamais — une traînée qui précéderait l'avion montrerait un
  avenir que personne ne connaît. Un trou de plus de trois minutes entre deux
  relevés la coupe : elle repart après le trou plutôt que de traverser le vide
  en ligne droite, comme s'y refuse déjà l'interpolation.

  Elles sont dessinées sur une **toile**, non en polylignes Leaflet : à mille
  appareils ce serait autant d'objets à créer et détruire cinq fois par
  seconde. Le tri des traînées hors cadre se fait en degrés, avant toute
  projection. Un liseré sombre double le trait sur les fonds clair et relief,
  où un bleu pâle se perdrait ; sur le fond sombre il est omis — inutile là, et
  c'est un tracé de moins par appareil.

- **Pistes d'aéroport** : Trudeau (CYUL), Mirabel (CYMX) et Saint-Hubert
  (CYHU), tracées à leur position et à leur orientation vraies. C'est le
  contexte qui manquait au trafic : une file d'appareils alignés n'est qu'une
  file tant qu'on ne voit pas sur quoi elle s'aligne.

  La géométrie tient dans `assets/airports.js` — deux seuils par piste, et le
  tracé n'est qu'une droite de l'un à l'autre : une piste est droite. Rien
  n'est demandé au réseau. Pour en ajouter, il suffit d'allonger ce tableau.

  **Provenance et vérification.** Les seuils viennent d'OurAirports (domaine
  public). À la génération, cap et longueur ont été recalculés depuis les
  coordonnées et comparés aux valeurs publiées : sept pistes sur huit
  s'accordent à 1,3 degré et 2,3 pour cent près. La huitième, Mirabel 11/29,
  porte une note — sa longueur publiée est de 8 852 pi mais ses seuils en
  couvrent 11 951, la piste ayant vraisemblablement été raccourcie ; elle
  n'est d'ailleurs plus éclairée.

  Contre-épreuve indépendante : le numéro d'une piste est son cap magnétique
  arrondi à la dizaine. La déclinaison à Montréal vaut environ 14 degrés
  **ouest**, donc cap vrai = cap magnétique − 14. Les huit numéros s'accordent
  ainsi avec les coordonnées à 3,4 degrés près. Deux sources indépendantes —
  les relevés et la peinture au sol — disent la même chose.

  **CYUL 10/28 est fermée** ; elle est tracée en pointillé effacé et sans
  repères de seuil, parce qu'un ruban de béton sans explication laisserait
  croire à une piste inactive faute d'usage.

  Le détail suit le zoom : de loin un simple trait, de près la largeur vraie
  de la piste et le repère de chaque seuil, poussé vers l'extérieur pour ne
  pas se poser sur le béton. L'étiquette de l'aérodrome se place sous la piste
  la plus au sud, non au point de référence — celui-ci tombe entre les pistes,
  et le nom venait s'y coucher en travers.

- **Filtre d'altitude** : l'échelle des bandes sert aussi de filtre — chaque
  palier se décoche, la pastille se creuse, l'intitulé se barre. La même chose
  se dit et se commande au même endroit. Le décompte passe alors à « 4 sur 5 »,
  sans quoi une carte vidée par un filtre ne se distinguerait pas d'un silence
  de la source. Le dernier palier coché ne se décoche pas.

  Une altitude absente — véhicule de piste, cible TIS-B — compte pour la bande
  la plus basse : c'est déjà la couleur qu'elle porte à l'écran, et un filtre
  doit retrancher ce qu'on voit.

- **Rayon** : de 20 à **250 NM**, la limite des deux sources. À 250 NM autour
  de Blainville le cercle atteint Toronto, Boston et l'approche de New York :
  la flotte s'y compte par milliers. Mesuré à 1 500 appareils avec traînées de
  quinze minutes, carte dézoomée au maximum — le pire cas — le rendu prend
  28 ms sur bureau et 167 ms sur un téléphone bridé au quart, pour un budget de
  200 ms à cinq images par seconde. Sur fond clair, où le liseré revient, ce
  cas extrême passe à environ 250 ms : l'animation ralentit sans casser.

  Le rayon du **navigateur** est celui-là. Celui de l'enregistrement continu
  est réglé séparément dans Supabase et vaut 120 NM ; l'élargir multiplie le
  volume conservé — voir `supabase/README.md`.

  **L'historique est celui qu'on a soi-même enregistré — il n'en existe pas
  d'autre.** Aucune source gratuite ne rend les positions passées : l'archive
  d'adsb.lol paraît le lendemain, en fichiers quotidiens, ce qui ne couvre
  jamais les trois dernières heures.

  Il est donc constitué à deux niveaux. Une tâche planifiée chez **Supabase**
  relève le trafic chaque minute, sans interruption et sans qu'aucun
  navigateur soit ouvert : c'est elle qui permet d'accompagner toute la boucle
  radar. Elle tient entièrement dans la base, par `pg_cron` et `pg_net` — un
  seul collage de `supabase/schema.sql` suffit, sans ligne de commande ni
  secret à manipuler. En complément, le
  navigateur garde ses propres relevés dans IndexedDB — un point par appareil
  et par 45 secondes, la boucle radar battant aux six minutes — ce qui laisse
  la console utile même si le serveur est muet.

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

## Diagnostic

La console expose sa version au pied du tiroir, la cause exacte de ses échecs
dans ses messages, et une poignée dans la console du navigateur :

```js
carteradar.version              // version du moteur
carteradar.planes.coverage()    // étendue de l'historique en mémoire
carteradar.loop.times.length    // images de la boucle
```

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
