# Console radar — Sud du Québec

Boucle radar animée pour le sud du Québec, à partir du service WMS **GeoMet**
d'Environnement et Changement climatique Canada. Site statique, sans dépendance
de compilation : Leaflet est chargé depuis un CDN, tout le reste est du HTML,
du CSS et du JavaScript écrits à la main.

Deux interfaces distinctes partagent le même moteur :

| Adresse   | Pour                          | Ce qui change                                                                 |
|-----------|-------------------------------|-------------------------------------------------------------------------------|
| `/pc`     | Écran large, souris, clavier   | Tiroir latéral, règle graduée à l'heure, raccourcis clavier, lecture au point |
| `/mobile` | Téléphone, tablette, tactile   | Bandes haute et basse, feuille de réglages, gros curseur, géolocalisation      |

La racine `/` détecte l'appareil et redirige. Le choix est mémorisé.

## Structure

```
index.html                 aiguillage /pc ou /mobile
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

- **Produits** : deux composites 1 km — `RADAR_1KM_RRAI` (mm/h) et
  `RADAR_1KM_RSNO` (cm/h). « Pluie » et « neige » désignent la table de
  conversion appliquée à l'écho, pas ce qui tombe réellement.

  La liste vit dans `PRODUCTS`, au début de `assets/radar-core.js` : une ligne
  de plus la fait apparaître dans les deux interfaces, et les intitulés de
  grandeur reparaissent d'eux-mêmes dès qu'il y en a plus d'une. Si GeoMet
  refuse une couche, la console revient au produit précédent et affiche la
  cause ; un produit retiré du catalogue mais resté dans les préférences est
  ignoré au démarrage.

  **N'y inscrire qu'un identifiant relevé dans le `GetCapabilities` du
  service.** Deux couches de réflectivité en dBZ y ont figuré sur la foi d'un
  annuaire tiers qui republie GeoMet ; le service les refuse avec
  `InvalidLayersParameter`. Un annuaire tiers n'est pas le catalogue.
- **Boucle** : jusqu'à 30 images, soit les trois dernières heures. Arrêt d'une
  seconde et demie sur la dernière image avant de reboucler, comme les boucles
  d'ECCC.
- **Rafraîchissement** : vérification chaque minute ; les nouvelles images sont
  ajoutées sans rebâtir la pile, et les plus vieilles sont retirées.
- **Lecture au point** : un clic ou une touche donne l'intensité sous le
  curseur, à l'image affichée.
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
- **Mémoire** : produit, opacité, vitesse, fond de carte et dernière position
  de la carte sont conservés dans le navigateur.
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
sans le suffixe `.html`.

### Cache

Les pages et les fichiers de `assets/` sont servis en `no-cache` : le
navigateur les garde, mais revalide avant chaque usage, et reçoit un 304 tant
que rien n'a changé. Les liens vers `assets/` portent en plus une marque de
version (`?v=4`).

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
Python ne fait pas d'URL propres, mais les pages fonctionnent.

## Forcer une version

- `/?v=pc` ou `/?v=mobile` — impose la version et la mémorise.
- Le lien en bas du tiroir, ou de la feuille de réglages, fait la bascule.

## Données

Imagerie radar © Environnement et Changement climatique Canada, service
[GeoMet](https://eccc-msc.github.io/open-data/). Fonds de carte © OpenStreetMap
et CARTO. Le site n'a pas de serveur : le navigateur interroge GeoMet
directement.
