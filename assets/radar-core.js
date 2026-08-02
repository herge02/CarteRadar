/*  Cœur commun aux deux consoles radar.
    Accès au service WMS GeoMet d'ECCC, gestion de la boucle d'images,
    fonds de carte et lecture ponctuelle. Ne dépend que de Leaflet.        */

(function (global) {
"use strict";

/*  Version du moteur, affichée dans l'interface. Elle sert à repérer d'un
    coup d'œil un fichier resté en cache : si le numéro montré à l'écran ne
    correspond pas au dernier déploiement, c'est le cache, pas le service. */
var VERSION = "14";

var GEOMET = "https://geo.weather.gc.ca/geomet";
var TZ     = "America/Toronto";
var ATTR   = 'Radar © <a href="https://eccc-msc.github.io/open-data/" target="_blank" rel="noopener">ECCC / GeoMet</a>';
var CARTO  = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

/*  Composites 1 km de GeoMet. Toute l'interface se construit à partir d'ici :
    ajouter une ligne suffit à faire apparaître le produit des deux côtés,
    et les intitulés de grandeur s'effacent d'eux-mêmes s'il n'en reste
    qu'une. « pluie » et « neige » désignent la table de conversion appliquée
    à l'écho, pas ce qui tombe réellement.

    N'inscrire ici qu'un identifiant relevé dans le GetCapabilities du
    service. Deux couches de réflectivité, RADAR_1KM_RDBR et RADAR_1KM_RDBS,
    ont été ajoutées sur la foi d'un annuaire tiers : GeoMet les refuse avec
    « InvalidLayersParameter — Couche non disponible ». Elles sont retirées
    en attendant les vrais identifiants.                                  */
var PRODUCTS = {
  RADAR_1KM_RRAI: { quantity:"Taux de précipitation", phase:"Pluie", unit:"mm/h", coverage:"RADAR_COVERAGE_RRAI.INV" },
  RADAR_1KM_RSNO: { quantity:"Taux de précipitation", phase:"Neige", unit:"cm/h", coverage:"RADAR_COVERAGE_RSNO.INV" }
};

/* GeoMet ne conserve que les trois dernières heures, à six minutes d'écart. */
var MAX_FRAMES = 30;

function isoZ(d){ return d.toISOString().replace(/\.\d{3}Z$/, "Z"); }

function clock(d, opts){
  var base = { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("fr-CA", Object.assign(base, opts || {}))
    .format(d).replace(",", "");
}

/* ------------------------------------------------------------- préférences */
var Prefs = {
  key: "carteradar:prefs",
  read: function(){
    try { return JSON.parse(localStorage.getItem(this.key)) || {}; }
    catch(e){ return {}; }
  },
  write: function(patch){
    try { localStorage.setItem(this.key, JSON.stringify(Object.assign(this.read(), patch))); }
    catch(e){ /* navigation privée : on continue sans mémoire */ }
  }
};

/* -------------------------------------------------------- fonds de carte */
function basemaps(){
  var u = function(style){ return "https://{s}.basemaps.cartocdn.com/" + style + "/{z}/{x}/{y}{r}.png"; };
  return {
    bases: {
      dark : L.tileLayer(u("dark_nolabels"),               { attribution: CARTO, maxZoom: 19 }),
      light: L.tileLayer(u("light_nolabels"),              { attribution: CARTO, maxZoom: 19 }),
      sat  : L.tileLayer(u("rastertiles/voyager_nolabels"), { attribution: CARTO, maxZoom: 19 })
    },
    labels: {
      dark : L.tileLayer(u("dark_only_labels"),                { pane: "labels", maxZoom: 19 }),
      light: L.tileLayer(u("light_only_labels"),               { pane: "labels", maxZoom: 19 }),
      sat  : L.tileLayer(u("rastertiles/voyager_only_labels"), { pane: "labels", maxZoom: 19 })
    }
  };
}

/* Trois plans : le radar sous les couches fixes, les noms de lieux au-dessus. */
function panes(map){
  map.createPane("radar");  map.getPane("radar").style.zIndex  = 350;
  map.createPane("static"); map.getPane("static").style.zIndex = 380;
  map.createPane("labels"); map.getPane("labels").style.zIndex = 460;
  map.getPane("labels").style.pointerEvents = "none";
  map.createPane("planes"); map.getPane("planes").style.zIndex = 470;
}

/*  Premier élément portant ce nom local, préfixé ou non. getElementsByTagName
    compare le nom qualifié : sur <ogc:ServiceException>, il ne trouve rien. */
function pickAny(xml, tag){
  return xml.getElementsByTagName(tag)[0]
      || xml.getElementsByTagNameNS("*", tag)[0]
      || null;
}

/*  Cherche un élément par nom local, que le document soit muni d'espaces de
    noms ou non, et privilégie celui qui porte name="time".                */
function pickNamed(xml, tag){
  var els = xml.getElementsByTagName(tag);
  if(!els.length) els = xml.getElementsByTagNameNS("*", tag);
  var first = null;
  for(var i = 0; i < els.length; i++){
    if(!first) first = els[i];
    if((els[i].getAttribute("name") || "").toLowerCase() === "time") return els[i];
  }
  return first;
}

/*  Le WMS a déplacé l'axe temps d'une version à l'autre :
      1.3.0 — <Dimension name="time" units="ISO8601">valeurs</Dimension>
      1.1.1 — <Dimension name="time"/> purement déclaratif, les valeurs
              vivant dans <Extent name="time">valeurs</Extent>
    MapServer, sur lequel repose GeoMet, sert l'une ou l'autre selon la
    couche. On accepte les deux, et à défaut l'attribut default, qui donne
    au moins l'image courante.                                            */
function timeAxisFrom(xml){
  var dim = pickNamed(xml, "Dimension");
  var ext = pickNamed(xml, "Extent");

  var value = (dim && dim.textContent.trim()) || (ext && ext.textContent.trim()) || "";
  if(value) return value;

  return ((dim && dim.getAttribute("default"))
       || (ext && ext.getAttribute("default")) || "").trim();
}

/*  Portrait compact du document reçu, joint au message d'erreur : sans lui,
    un échec d'analyse ne se distingue pas d'une panne du service.        */
function describeDoc(xml){
  var count = function(tag){
    var a = xml.getElementsByTagName(tag);
    return a.length || xml.getElementsByTagNameNS("*", tag).length;
  };

  var names = [], ns = xml.getElementsByTagName("Name");
  if(!ns.length) ns = xml.getElementsByTagNameNS("*", "Name");
  for(var i = 0; i < ns.length && names.length < 3; i++){
    var v = ns[i].textContent.trim();
    if(v) names.push(v);
  }

  return (xml.documentElement ? xml.documentElement.nodeName : "?")
       + " · Layer×" + count("Layer")
       + " Dimension×" + count("Dimension")
       + " Extent×" + count("Extent")
       + (names.length ? " · " + names.join(" ") : "");
}

/* ====================================================== catalogue GeoMet ==
   Le GetCapabilities complet est la seule liste faisant foi des couches du
   service. Il pèse plusieurs mégaoctets : on le parcourt en texte plutôt
   que d'en construire un arbre DOM entier, et on le garde en mémoire pour
   la durée de la session.                                                */

var catalogue = null;

/*  Découpe sur « <Layer » : chaque tronçon porte le Name et le Title de sa
    couche, et s'arrête à la couche suivante — les dimensions d'une fille ne
    débordent donc pas sur sa mère. « </Layer> » ne contient pas « <Layer ».  */
function scanLayers(text){
  var out = [], seen = {}, chunks = text.split("<Layer");

  for(var i = 1; i < chunks.length; i++){
    var c = chunks[i];
    var n = /<(?:\w+:)?Name>([^<]+)<\/(?:\w+:)?Name>/.exec(c);
    if(!n) continue;

    var name = n[1].trim();
    if(!name || seen[name]) continue;
    seen[name] = true;

    var t = /<(?:\w+:)?Title>([^<]*)<\/(?:\w+:)?Title>/.exec(c);
    out.push({
      name : name,
      title: t ? t[1].trim() : "",
      time : /<(?:\w+:)?(?:Dimension|Extent)[^>]*name\s*=\s*"time"/i.test(c)
    });
  }
  return out;
}

async function fetchCatalogue(){
  if(catalogue) return catalogue;

  var res = await fetch(GEOMET + "?service=WMS&version=1.3.0&request=GetCapabilities");
  if(!res.ok) throw new Error("GetCapabilities " + res.status);

  var text = await res.text();
  var xml  = new DOMParser().parseFromString(text.slice(0, 4000), "text/xml");
  var exc  = pickAny(xml, "ServiceException");
  if(exc) throw new Error("refus de GeoMet : " + exc.textContent.trim().slice(0, 120));

  catalogue = scanLayers(text);
  if(!catalogue.length){ catalogue = null; throw new Error("aucune couche lisible dans la réponse"); }
  return catalogue;
}

/* Filtre insensible à la casse, sur l'identifiant comme sur l'intitulé. */
function searchCatalogue(list, needle){
  needle = (needle || "").trim().toLowerCase();
  if(!needle) return list;
  return list.filter(function(l){
    return l.name.toLowerCase().indexOf(needle) !== -1
        || l.title.toLowerCase().indexOf(needle) !== -1;
  });
}

/* --------------------------------------------------- axe temps de GeoMet */
async function fetchTimes(product, wanted){
  var url = GEOMET + "?service=WMS&version=1.3.0&request=GetCapabilities&layer="
          + encodeURIComponent(product) + "&t=" + Date.now();
  var res = await fetch(url);
  if(!res.ok) throw new Error("GetCapabilities " + res.status);

  var body = await res.text();
  var xml  = new DOMParser().parseFromString(body, "text/xml");

  /*  GeoMet répond 200 en portant un rapport d'exception OGC, dont les
      éléments sont préfixés : <ogc:ServiceException>. Une recherche par nom
      qualifié les manquerait — d'où la recherche par nom local.          */
  var exc = pickAny(xml, "ServiceException") || pickAny(xml, "ExceptionText");
  if(exc){
    var code = exc.getAttribute("code") || exc.getAttribute("exceptionCode") || "";
    throw new Error("refus de GeoMet" + (code ? " (" + code + ")" : "")
                  + " : " + exc.textContent.trim().slice(0, 120));
  }

  var raw = timeAxisFrom(xml);
  if(!raw) throw new Error("aucun axe temps dans la réponse [" + describeDoc(xml) + "]");

  var times = expandTimeDimension(raw, wanted);
  if(!times.length) throw new Error("axe temps illisible : « " + raw.slice(0, 60) + " »");

  return { times: times.slice(-wanted), available: times.length, raw: raw };
}

/*  Durée ISO 8601 en millisecondes. Le « M » vaut mois avant le T, minutes
    après : c'est la position qui tranche, d'où les deux groupes.          */
function durationMs(iso){
  var m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
          .exec((iso || "").trim());
  if(!m) return 0;
  return ((+m[1] || 0) * 31536000 + (+m[2] || 0) * 2592000 + (+m[3] || 0) * 86400
        + (+m[4] || 0) * 3600     + (+m[5] || 0) * 60      + (+m[6] || 0)) * 1000;
}

/*  Le WMS admet deux écritures pour la dimension temps, et GeoMet se sert
    des deux selon le produit : un intervalle « début/fin/pas », ou une
    liste d'instants séparés par des virgules. Les deux peuvent même se
    mêler dans une même liste. On développe le tout, du plus vieux au plus
    récent, en s'arrêtant dès qu'on tient assez d'images récentes.        */
function expandTimeDimension(raw, wanted){
  var budget = Math.max(1, wanted) + 8;   // marge pour le rafraîchissement
  var out = [];

  raw.split(",").forEach(function(token){
    token = token.trim();
    if(!token) return;

    if(token.indexOf("/") === -1){
      var t = new Date(token);
      if(!isNaN(t)) out.push(t);
      return;
    }

    var parts = token.split("/");
    var d0 = new Date(parts[0]);
    var d1 = new Date(parts[1]);
    var step = durationMs(parts[2]);
    if(isNaN(d0) || isNaN(d1)) return;
    if(!step) step = 6 * 60000;           // pas annoncé ou nul : six minutes

    /* On remonte depuis la fin : seules les dernières images comptent. */
    for(var t2 = d1.getTime(); t2 >= d0.getTime() && out.length < budget * 4; t2 -= step){
      out.push(new Date(t2));
    }
  });

  /* Dédoublonne et ordonne : une liste mixte peut se recouper. */
  var seen = {};
  return out
    .filter(function(d){
      var k = d.getTime();
      if(seen[k]) return false;
      seen[k] = true;
      return true;
    })
    .sort(function(a, b){ return a - b; });
}

/*  Couches choisies dans le catalogue : hors de PRODUCTS, qui ne contient que
    les produits vérifiés et outillés, mais retenues ici pour que l'intitulé
    et l'unité suivent la couche partout où elle est affichée.            */
var ADHOC = {};

/* L'intitulé de GeoMet porte son unité entre crochets : « … [dBZ] ». */
function guessUnit(title){
  var m = /\[([^\]]{1,12})\]\s*$/.exec((title || "").trim());
  return m ? m[1] : "";
}

function remember(id, meta){
  ADHOC[id] = {
    title   : (meta && meta.title) || id,
    quantity: (meta && meta.title) || id,
    phase   : "",
    unit    : (meta && meta.unit) || guessUnit(meta && meta.title),
    coverage: null
  };
  return ADHOC[id];
}

function metaFor(id){
  return PRODUCTS[id] || ADHOC[id] || { quantity: id, phase: "", unit: "", coverage: null };
}

/* ================================================================ Track ==
   Une couche animée : sa pile d'images WMS, son propre axe temps et sa
   propre opacité. Plusieurs pistes se superposent, chacune gardant sa
   cadence — le radar bat aux six minutes, un satellite à un autre rythme. */

function Track(map, id, meta, opts){
  opts = opts || {};
  this.map     = map;
  this.id      = id;
  this.meta    = meta || {};
  this.opacity = opts.opacity != null ? opts.opacity : 0.78;
  this.zIndex  = opts.zIndex  != null ? opts.zIndex  : 400;

  this.times  = [];
  this.frames = [];
  this.shown  = -1;      // index de l'image visible, -1 si aucune
  this.loaded = 0;
  this.available = 0;
}

Track.prototype.title = function(){
  return this.meta.title || this.meta.quantity || this.id;
};

Track.prototype.unit = function(){
  return this.meta.unit || "";
};

Track.prototype._frame = function(date){
  return L.tileLayer.wms(GEOMET + "?", {
    layers        : this.id,
    format        : "image/png",
    transparent   : true,
    version       : "1.3.0",
    time          : isoZ(date),
    opacity       : 0,
    pane          : "radar",
    zIndex        : this.zIndex,
    updateWhenIdle: true,
    keepBuffer    : 1,
    attribution   : ATTR
  });
};

Track.prototype.build = async function(wanted, onProgress){
  var data = await fetchTimes(this.id, wanted);   // peut lever
  this.destroy();

  this.times     = data.times;
  this.available = data.available;
  this.loaded    = 0;

  var self = this, total = data.times.length;
  this.frames = data.times.map(function(d){ return self._frame(d); });
  this.frames.forEach(function(l){
    l.once("load", function(){
      self.loaded++;
      if(onProgress) onProgress(self.loaded / total);
    });
    l.addTo(self.map);
  });
  return true;
};

/*  Chaque piste a sa cadence : à l'instant demandé par la ligne du temps
    commune, on montre l'image la plus proche que cette piste possède.
    Seules deux opacités changent, pas toute la pile.                     */
Track.prototype.showAt = function(t){
  var n = this.times.length;
  if(!n) return;

  var ms = t.getTime(), best = 0, delta = Infinity;
  for(var i = 0; i < n; i++){
    var d = Math.abs(this.times[i].getTime() - ms);
    if(d < delta){ delta = d; best = i; }
  }
  if(best === this.shown) return;

  if(this.shown >= 0 && this.frames[this.shown]) this.frames[this.shown].setOpacity(0);
  this.frames[best].setOpacity(this.opacity);
  this.shown = best;
};

Track.prototype.setOpacity = function(v){
  this.opacity = v;
  if(this.shown >= 0 && this.frames[this.shown]) this.frames[this.shown].setOpacity(v);
};

Track.prototype.setZIndex = function(z){
  this.zIndex = z;
  this.frames.forEach(function(l){ l.setZIndex(z); });
};

Track.prototype.destroy = function(){
  var self = this;
  this.frames.forEach(function(l){ self.map.removeLayer(l); });
  this.frames = [];
  this.times  = [];
  this.shown  = -1;
};

/* Ajoute les images parues depuis le dernier appel, sans rebâtir la pile. */
Track.prototype.refresh = async function(wanted){
  var data = await fetchTimes(this.id, wanted);
  if(!data.times.length) return false;

  var newest = data.times[data.times.length - 1].getTime();
  if(this.times.length && newest === this.times[this.times.length - 1].getTime()) return false;

  var self = this, known = {};
  this.times.forEach(function(d){ known[d.getTime()] = true; });

  data.times.forEach(function(d){
    if(known[d.getTime()]) return;
    var l = self._frame(d);
    l.addTo(self.map);
    self.times.push(d);
    self.frames.push(l);
  });

  while(this.times.length > wanted){
    this.map.removeLayer(this.frames.shift());
    this.times.shift();
    this.shown = this.shown > 0 ? this.shown - 1 : -1;
  }
  return true;
};

Track.prototype.legendUrl = function(){
  return GEOMET + "?version=1.3.0&service=WMS&request=GetLegendGraphic"
       + "&sld_version=1.1.0&format=image/png&layer=" + encodeURIComponent(this.id);
};

/* Intensité sous un point, à l'image que cette piste montre en ce moment. */
Track.prototype.valueAt = async function(latlng){
  var out = { id: this.id, title: this.title(), unit: this.unit(), value: null };
  if(this.shown < 0) return out;

  var map  = this.map;
  var size = map.getSize();
  var b    = map.getBounds();
  var sw   = L.CRS.EPSG3857.project(b.getSouthWest());
  var ne   = L.CRS.EPSG3857.project(b.getNorthEast());
  var pt   = map.latLngToContainerPoint(latlng);

  var q = new URLSearchParams({
    service: "WMS", version: "1.3.0", request: "GetFeatureInfo",
    layers: this.id, query_layers: this.id,
    crs: "EPSG:3857",
    bbox: [sw.x, sw.y, ne.x, ne.y].join(","),
    width: size.x, height: size.y,
    i: Math.round(pt.x), j: Math.round(pt.y),
    info_format: "application/json",
    time: isoZ(this.times[this.shown])
  });

  try {
    var res = await fetch(GEOMET + "?" + q.toString());
    var txt = await res.text();
    try {
      var j = JSON.parse(txt);
      var p = (j.features && j.features[0] && j.features[0].properties) || {};
      for(var k in p){
        var v = parseFloat(p[k]);
        if(!isNaN(v)){ out.value = v; break; }
      }
    } catch(e){
      var m = /-?\d+(\.\d+)?/.exec(txt);
      if(m) out.value = parseFloat(m[0]);
    }
  } catch(e){ out.failed = true; }

  return out;
};

/* ============================================================ RadarLoop ==
   Chef d'orchestre : tient les pistes, la ligne du temps commune et
   l'horloge de lecture. L'interface s'y branche par des rappels ; elle ne
   touche jamais aux couches Leaflet directement.                         */

function RadarLoop(map, opts){
  opts = opts || {};
  this.map    = map;
  this.wanted = opts.wanted || MAX_FRAMES;
  this.fps    = opts.fps    || 5;
  this.dwell  = opts.dwell  || 1300;   // arrêt sur la dernière image

  this.tracks = [];
  this.times  = [];
  this.idx    = 0;

  this.playing   = false;
  this.timer     = null;
  this.lastError = null;

  this.on = Object.assign({
    built:    function(){},
    show:     function(){},
    progress: function(){},
    playing:  function(){},
    error:    function(){},
    tracks:   function(){}
  }, opts.on || {});
}

RadarLoop.prototype.find = function(id){
  for(var i = 0; i < this.tracks.length; i++){
    if(this.tracks[i].id === id) return this.tracks[i];
  }
  return null;
};

RadarLoop.prototype.addTrack = async function(id, meta, opacity){
  if(this.find(id)) return true;

  var self  = this;
  var track = new Track(this.map, id, meta || PRODUCTS[id] || ADHOC[id], {
    opacity: opacity,
    zIndex : 400 + this.tracks.length
  });

  try {
    await track.build(this.wanted, function(r){ self.on.progress(r); });
  } catch(e){
    this.lastError = e;
    this.on.error(e);
    track.destroy();
    return false;
  }

  this.lastError = null;
  this.tracks.push(track);
  this.retime();
  this.show(this.times.length - 1);
  this.on.tracks(this.tracks);
  return true;
};

RadarLoop.prototype.removeTrack = function(id){
  var t = this.find(id);
  if(!t) return false;

  t.destroy();
  this.tracks.splice(this.tracks.indexOf(t), 1);
  this.tracks.forEach(function(tr, i){ tr.setZIndex(400 + i); });

  this.retime();
  if(this.times.length) this.show(Math.min(this.idx, this.times.length - 1));
  else this.pause();
  this.on.tracks(this.tracks);
  return true;
};

RadarLoop.prototype.setTrackOpacity = function(id, v){
  var t = this.find(id);
  if(t) t.setOpacity(v);
};

/*  Ligne du temps commune : l'union des instants de toutes les pistes. Une
    piste qui n'a pas d'image à un instant donné garde la sienne, la plus
    proche — pas de trou, pas de clignotement.                            */
RadarLoop.prototype.retime = function(){
  var seen = {}, all = [];
  this.tracks.forEach(function(t){
    t.times.forEach(function(d){
      var k = d.getTime();
      if(!seen[k]){ seen[k] = true; all.push(d); }
    });
  });
  all.sort(function(a, b){ return a - b; });

  this.times = all.slice(-Math.max(1, this.wanted));
  if(this.idx >= this.times.length) this.idx = Math.max(0, this.times.length - 1);
  this.on.built(this);
};

RadarLoop.prototype.show = function(i){
  var n = this.times.length;
  if(!n) return;
  i = ((i % n) + n) % n;
  this.idx = i;

  var t = this.times[i];
  this.tracks.forEach(function(tr){ tr.showAt(t); });
  this.on.show(t, i, n);
};

RadarLoop.prototype._tick = function(){
  var self = this;
  this.show(this.idx >= this.times.length - 1 ? 0 : this.idx + 1);
  var atEnd = this.idx >= this.times.length - 1;
  this.timer = setTimeout(function(){ self._tick(); }, atEnd ? this.dwell : 1000 / this.fps);
};

RadarLoop.prototype.play = function(){
  if(this.playing || this.times.length < 2) return;
  var self = this;
  this.playing = true;
  this.on.playing(true);
  this.timer = setTimeout(function(){ self._tick(); }, 1000 / this.fps);
};

RadarLoop.prototype.pause = function(){
  if(!this.playing && !this.timer) return;
  clearTimeout(this.timer);
  this.timer = null;
  this.playing = false;
  this.on.playing(false);
};

RadarLoop.prototype.toggle = function(){ this.playing ? this.pause() : this.play(); };

RadarLoop.prototype.setFps = function(v){
  this.fps = v;
  if(this.playing){ this.pause(); this.play(); }
};

RadarLoop.prototype.setWanted = async function(n){
  this.wanted = n;
  var self = this;
  for(var i = 0; i < this.tracks.length; i++){
    try { await this.tracks[i].build(n, function(r){ self.on.progress(r); }); }
    catch(e){ this.lastError = e; this.on.error(e); }
  }
  this.retime();
  this.show(this.times.length - 1);
};

RadarLoop.prototype.refresh = async function(){
  if(!this.tracks.length) return false;

  var changed = false;
  for(var i = 0; i < this.tracks.length; i++){
    try { if(await this.tracks[i].refresh(this.wanted)) changed = true; }
    catch(e){ /* une piste muette ne doit pas arrêter les autres */ }
  }
  if(!changed) return false;

  var wasLive = this.idx === this.times.length - 1;
  this.retime();
  this.show(wasLive ? this.times.length - 1 : this.idx);
  return true;
};

/* Une lecture par piste : superposées, elles répondent chacune la sienne. */
RadarLoop.prototype.valueAt = function(latlng){
  return Promise.all(this.tracks.map(function(t){ return t.valueAt(latlng); }));
};
/* ============================================================== Avions ====
   Le trafic aérien ne vient pas de GeoMet : c'est une source séparée, en
   ADS-B communautaire, sans clé ni compte. Elle ne diffuse que l'instant
   présent — aucun historique. La console, elle, remonte trois heures.

   D'où le tampon : tant que la page est ouverte, chaque relevé est daté et
   conservé ; quand on se déplace dans la boucle, chaque appareil est montré
   à la position enregistrée la plus proche de cet instant. Avant l'ouverture
   de la page, rien n'est connu, et rien n'est inventé.                     */

/*  Les sources sont interrogées par le relais /api/planes, et non en direct :
    aucune ne renvoie d'en-tête CORS, un navigateur ne peut donc pas lire
    leur réponse lui-même. Voir api/planes.js.                            */
var PLANE_RELAY = "/api/planes";

var PLANE_SOURCES = {
  "adsb.lol":       { label: "adsb.lol" },
  "airplanes.live": { label: "airplanes.live" }
};

/*  Bandes d'altitude, en pieds. Rampe séquentielle bleue à teinte unique,
    du sombre au clair : sur fond noir, plus c'est haut, plus c'est lisible,
    et le trafic de croisière — le plus nombreux — ressort. Validée pour
    l'écart de clarté entre paliers et pour le contraste du palier le plus
    sombre sur la surface.                                                 */
var ALT_BANDS = [
  { max:  3000, color:"#184f95", label:"< 3 000 pi"      },
  { max: 10000, color:"#256abf", label:"3 – 10 000 pi"   },
  { max: 20000, color:"#3987e5", label:"10 – 20 000 pi"  },
  { max: 30000, color:"#86b6ef", label:"20 – 30 000 pi"  },
  { max: Infinity, color:"#b7d3f6", label:"> 30 000 pi"  }
];

function altBand(ft){
  if(ft === null || ft === undefined || isNaN(ft)) return ALT_BANDS[0];
  for(var i = 0; i < ALT_BANDS.length; i++){ if(ft < ALT_BANDS[i].max) return ALT_BANDS[i]; }
  return ALT_BANDS[ALT_BANDS.length - 1];
}

function num(v){
  if(v === null || v === undefined || v === "") return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/*  Les sources ADS-B ne nomment pas leurs champs de la même façon : on
    accepte les graphies courantes plutôt que d'en épouser une seule.     */
function normalisePlane(a){
  if(!a) return null;
  var lat = num(a.lat !== undefined ? a.lat : a.latitude);
  var lon = num(a.lon !== undefined ? a.lon : (a.lng !== undefined ? a.lng : a.longitude));
  if(lat === null || lon === null) return null;

  var alt = a.alt_baro;
  if(alt === "ground") alt = 0;
  if(alt === undefined || alt === null) alt = a.alt_geom;
  if(alt === undefined || alt === null) alt = a.altitude;
  if(alt === undefined || alt === null) alt = a.baro_altitude;

  var trk = a.track;
  if(trk === undefined || trk === null) trk = a.true_heading;
  if(trk === undefined || trk === null) trk = a.heading;
  if(trk === undefined || trk === null) trk = a.mag_heading;

  var id = (a.hex || a.icao || a.icao24 || a.r || "").toString().trim().toLowerCase();
  if(!id) return null;

  return {
    id  : id,
    call: ((a.flight || a.callsign || "") + "").trim(),
    reg : ((a.r || a.registration || "") + "").trim(),
    type: ((a.t || a.type || "") + "").trim(),
    lat : lat,
    lon : lon,
    alt : num(alt),
    trk : num(trk),
    spd : num(a.gs !== undefined ? a.gs : (a.speed !== undefined ? a.speed : a.velocity))
  };
}

function extractPlanes(data){
  var list = null;
  if(Array.isArray(data)) list = data;
  else if(data && Array.isArray(data.ac)) list = data.ac;
  else if(data && Array.isArray(data.aircraft)) list = data.aircraft;
  else if(data && Array.isArray(data.states)) list = data.states;   // OpenSky : tableaux bruts
  if(!list) return null;

  var out = [];
  list.forEach(function(a){
    /* OpenSky rend des tableaux positionnels, pas des objets. */
    if(Array.isArray(a)){
      a = { hex:a[0], callsign:a[1], lon:a[5], lat:a[6], baro_altitude:a[7],
            velocity:a[9], true_heading:a[10] };
      if(a.baro_altitude !== null && a.baro_altitude !== undefined) a.baro_altitude *= 3.28084;
    }
    var p = normalisePlane(a);
    if(p) out.push(p);
  });
  return out;
}


/* ------------------------------------------------- mémoire du trafic ----
   Aucune source gratuite ne rend les positions passées : l'archive
   d'adsb.lol paraît le lendemain. Le seul historique disponible est donc
   celui qu'on a soi-même relevé. On le conserve d'une visite à l'autre,
   pour qu'il s'étende au lieu de repartir de zéro à chaque ouverture.

   IndexedDB plutôt que localStorage : quelques milliers de relevés
   dépasseraient vite les cinq mégaoctets de ce dernier.                  */
var PlaneStore = {
  name: "carteradar", store: "planes", key: "buffer", db: null,

  open: function(){
    var self = this;
    if(this.db) return Promise.resolve(this.db);
    return new Promise(function(resolve, reject){
      if(!global.indexedDB) return reject(new Error("IndexedDB indisponible"));
      var req = global.indexedDB.open(self.name, 1);
      req.onupgradeneeded = function(){
        if(!req.result.objectStoreNames.contains(self.store)) req.result.createObjectStore(self.store);
      };
      req.onsuccess = function(){ self.db = req.result; resolve(self.db); };
      req.onerror   = function(){ reject(req.error || new Error("ouverture refusée")); };
    });
  },

  load: async function(){
    try {
      var db = await this.open(), self = this;
      return await new Promise(function(resolve, reject){
        var tx = db.transaction(self.store, "readonly").objectStore(self.store).get(self.key);
        tx.onsuccess = function(){ resolve(tx.result || null); };
        tx.onerror   = function(){ reject(tx.error); };
      });
    } catch(e){ return null; }
  },

  save: async function(payload){
    try {
      var db = await this.open(), self = this;
      await new Promise(function(resolve, reject){
        var tx = db.transaction(self.store, "readwrite").objectStore(self.store).put(payload, self.key);
        tx.onsuccess = function(){ resolve(); };
        tx.onerror   = function(){ reject(tx.error); };
      });
      return true;
    } catch(e){ return false; }
  },

  clear: async function(){
    try {
      var db = await this.open(), self = this;
      await new Promise(function(resolve){
        var tx = db.transaction(self.store, "readwrite").objectStore(self.store).delete(self.key);
        tx.onsuccess = tx.onerror = function(){ resolve(); };
      });
      return true;
    } catch(e){ return false; }
  }
};

/* ------------------------------------------- historique côté Supabase ----
   Le tampon du navigateur ne connaît que ce qui s'est passé pendant que la
   page était ouverte. Une tâche planifiée chez Supabase, elle, relève le
   trafic chaque minute sans interruption : c'est cet historique-là qui peut
   accompagner toute la boucle radar.

   La clé ci-dessous est publiable — c'est son nom même. Elle ne protège
   rien : la table n'accorde que la lecture, et l'écriture est réservée à la
   clé de service, qui ne quitte jamais Supabase. La publier dans une page
   est le mode d'emploi prévu, pas une négligence.                         */
var SUPABASE = {
  url: "https://wmybeiknqecgjjzpnrju.supabase.co",
  key: "sb_publishable_0OhnIWtSJJfZJZnxKu9TWg_CKb2ObTt",
  table: "plane_fix"
};

var HISTORY_PAGE = 1000;   // PostgREST plafonne les réponses : on pagine

function historyEnabled(){
  return !!(SUPABASE.url && SUPABASE.key);
}

/*  Relevés postérieurs à `sinceMs`, restreints à l'emprise donnée. On pagine
    par tranches, et on s'arrête à `cap` pour ne pas noyer un téléphone.   */
async function fetchPlaneHistory(sinceMs, bounds, cap){
  if(!historyEnabled()) return null;
  cap = cap || 40000;

  var q = "?select=icao24,ts,callsign,reg,actype,lat,lon,alt,trk,spd"
        + "&ts=gte." + encodeURIComponent(new Date(sinceMs).toISOString())
        + "&order=ts.asc";

  if(bounds){
    q += "&lat=gte." + bounds.getSouth().toFixed(3)
      +  "&lat=lte." + bounds.getNorth().toFixed(3)
      +  "&lon=gte." + bounds.getWest().toFixed(3)
      +  "&lon=lte." + bounds.getEast().toFixed(3);
  }

  var url  = SUPABASE.url + "/rest/v1/" + SUPABASE.table + q;
  var rows = [], from = 0;

  while(rows.length < cap){
    var res = await fetch(url, {
      headers: {
        apikey: SUPABASE.key,
        Authorization: "Bearer " + SUPABASE.key,
        Accept: "application/json",
        Range: from + "-" + (from + HISTORY_PAGE - 1)
      }
    });
    if(!res.ok){
      var why = "";
      try { why = (await res.json()).message || ""; } catch(_){}
      throw new Error(why || ("historique : HTTP " + res.status));
    }

    var page = await res.json();
    if(!page.length) break;
    rows = rows.concat(page);
    if(page.length < HISTORY_PAGE) break;
    from += HISTORY_PAGE;
  }
  return rows;
}

function Aircraft(map, opts){
  opts = opts || {};
  this.map      = map;
  this.source   = PLANE_SOURCES[opts.source] ? opts.source : "adsb.lol";
  this.radius   = opts.radius || 120;      // milles nautiques
  this.every    = opts.every  || 15000;    // intervalle de relevé
  this.tolerance= opts.tolerance || 150000;// écart maximal toléré, 2 min 30
  this.keep     = opts.keep || 3 * 3600000;// profondeur du tampon
  /*  On relève aux 15 s, mais on ne conserve qu'un point par appareil et par
      45 s : la boucle radar bat aux six minutes, cette finesse suffit
      largement et divise d'autant la mémoire occupée.                    */
  this.minGap   = opts.minGap || 45000;
  this.saveEvery= opts.saveEvery || 60000;
  this.cap      = opts.cap || 40000;      // garde-fou sur le volume rapatrié
  this.saveTimer= null;

  this.enabled  = false;

  /*  Trois façons de situer la flotte dans le temps :
        « direct » — toujours maintenant, quelle que soit l'image radar ;
        « radar »  — appariée à l'image affichée, donc par bonds de six
                     minutes, ce qui montre mal le déplacement ;
        « propre » — horloge indépendante, avançant par petits pas, pour
                     voir les trajectoires se dérouler.                   */
  this.mode     = opts.mode || (opts.follow ? "radar" : "direct");
  this.step     = opts.step || 5000;    // temps enregistré gagné par battement
  this.tickMs   = opts.tickMs || 200;   // cinq battements par seconde
  this.cursor   = null;                 // instant courant, mode « propre »
  this.anim     = null;

  /*  Au-delà de cet écart entre deux relevés, l'appareil a probablement
      quitté la zone : interpoler tracerait une droite à travers le vide.  */
  this.gapMax   = opts.gapMax || 180000;
  this.lastFrame  = null;
  this.lastNewest = null;
  this.buffer   = {};     // identifiant → relevés datés
  this.meta     = {};     // identifiant → indicatif, immatriculation, type
  this.markers  = {};
  this.layer    = L.layerGroup();
  this.since      = null;
  this.histBounds = null;
  this.timer      = null;
  this.lastError= null;

  this.on = Object.assign({
    count: function(){},
    status: function(){},
    error: function(){}
  }, opts.on || {});
}

Aircraft.prototype.sourceLabel = function(){
  return (PLANE_SOURCES[this.source] || {}).label || this.source;
};

Aircraft.prototype.enable = async function(){
  if(this.enabled) return;
  this.enabled = true;
  this.layer.addTo(this.map);

  var self = this;
  await this.restore();                 // l'historique déjà relevé revient
  this.render();
  this.poll();

  this.timer = setInterval(function(){
    if(document.hidden) return;         // en arrière-plan, on ne sonde pas
    self.poll();
  }, this.every);

  this.saveTimer = setInterval(function(){ self.persist(); }, this.saveEvery);
};

Aircraft.prototype.disable = function(){
  this.enabled = false;
  this.stopAnim();
  clearInterval(this.timer);
  clearInterval(this.saveTimer);
  this.timer = this.saveTimer = null;
  this.persist();                       // on ne perd pas ce qui a été relevé
  this.map.removeLayer(this.layer);
  this.layer.clearLayers();
  this.markers = {};
  this.histBounds = null;
  this.on.count(0);
};

Aircraft.prototype.poll = async function(){
  if(!this.enabled) return false;

  var c = this.map.getCenter();
  var url = PLANE_RELAY + "?source=" + encodeURIComponent(this.source)
          + "&lat=" + c.lat.toFixed(4) + "&lon=" + c.lng.toFixed(4)
          + "&dist=" + Math.round(this.radius);

  var data;
  try {
    var res = await fetch(url, { headers: { "Accept": "application/json" } });

    if(res.status === 404){
      throw new Error("le relais /api/planes n'est pas déployé — "
                    + "cette page est-elle servie par Vercel ?");
    }
    if(!res.ok){
      var why = "";
      try { why = (await res.json()).error || ""; } catch(_){}
      throw new Error(why || ("relais : HTTP " + res.status));
    }
    data = await res.json();

  } catch(e){
    this.lastError = e;
    this.on.error(e);
    this.on.status("Trafic indisponible — " + e.message);
    return false;
  }

  var planes = extractPlanes(data);
  if(!planes){
    this.on.status("Réponse de " + this.sourceLabel() + " non reconnue.");
    return false;
  }

  this.record(planes, Date.now());
  this.render();          // la boucle peut être en pause : on rafraîchit ici
  return true;
};

Aircraft.prototype.record = function(planes, when){
  if(!this.since) this.since = when;
  var self = this;

  planes.forEach(function(p){
    var b = self.buffer[p.id] = self.buffer[p.id] || [];
    var last = b[b.length - 1];
    if(last && when - last.t < self.minGap){
      /* Trop rapproché du précédent : on remplace plutôt que d'empiler. */
      b[b.length - 1] = { t:when, lat:p.lat, lon:p.lon, trk:p.trk, alt:p.alt, spd:p.spd };
    } else {
      b.push({ t:when, lat:p.lat, lon:p.lon, trk:p.trk, alt:p.alt, spd:p.spd });
    }
    self.meta[p.id] = { call:p.call, reg:p.reg, type:p.type };
  });

  this.prune(when);
  this.on.status(planes.length + " appareils · relevés depuis "
                 + clock(new Date(this.since)) + " · " + this.sourceLabel());
};

Aircraft.prototype.prune = function(now){
  var floor = now - this.keep;
  for(var id in this.buffer){
    var b = this.buffer[id].filter(function(s){ return s.t >= floor; });
    if(b.length) this.buffer[id] = b;
    else { delete this.buffer[id]; delete this.meta[id]; }
  }
};

/* Relevé le plus proche de l'instant demandé, si l'écart reste tolérable. */
Aircraft.prototype.sampleAt = function(id, ms){
  var b = this.buffer[id];
  if(!b || !b.length) return null;

  var best = null, delta = Infinity;
  for(var i = 0; i < b.length; i++){
    var d = Math.abs(b[i].t - ms);
    if(d < delta){ delta = d; best = b[i]; }
  }
  return delta <= this.tolerance ? best : null;
};

function lerp(a, b, f){
  if(a === null || a === undefined) return b;
  if(b === null || b === undefined) return a;
  return a + (b - a) * f;
}

/*  Un cap se boucle à 360 : entre 350 et 10 degrés, le chemin court passe
    par zéro, pas par 180. On interpole donc sur l'écart replié.         */
function lerpAngle(a, b, f){
  if(a === null || a === undefined) return b;
  if(b === null || b === undefined) return a;
  var d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

/*  Position à un instant quelconque, interpolée entre les deux relevés qui
    l'encadrent. Sans cela, une horloge au pas de cinq secondes n'aurait
    rien à montrer : la collecte ne relève qu'une fois par minute.       */
Aircraft.prototype.stateAt = function(id, ms){
  var b = this.buffer[id];
  if(!b || !b.length) return null;

  var avant = null, apres = null;
  for(var i = 0; i < b.length; i++){
    if(b[i].t <= ms) avant = b[i];
    if(b[i].t >= ms){ apres = b[i]; break; }
  }

  /* Hors de la plage relevée : on tolère un léger débord, pas davantage. */
  if(!avant && !apres) return null;
  if(!avant) return (apres.t - ms) <= this.tolerance ? apres : null;
  if(!apres) return (ms - avant.t) <= this.tolerance ? avant : null;
  if(avant === apres || apres.t === avant.t) return avant;

  var ecart = apres.t - avant.t;
  if(ecart > this.gapMax){
    /* Trou trop large : on s'accroche au relevé voisin, sans inventer. */
    if(ms - avant.t <= this.tolerance) return avant;
    if(apres.t - ms <= this.tolerance) return apres;
    return null;
  }

  var f = (ms - avant.t) / ecart;
  return {
    t   : ms,
    lat : lerp(avant.lat, apres.lat, f),
    lon : lerp(avant.lon, apres.lon, f),
    alt : lerp(avant.alt, apres.alt, f),
    spd : lerp(avant.spd, apres.spd, f),
    trk : lerpAngle(avant.trk, apres.trk, f)
  };
};

Aircraft.prototype.icon = function(s){
  var band = altBand(s.alt);
  return L.divIcon({
    className: "plane",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: '<svg viewBox="0 0 24 24" style="transform:rotate(' + (s.trk || 0) + 'deg)">'
        + '<path d="M12 1.5 14.2 10 22.5 13.2v2.1L14.2 13.6v5.1l3 2.2v1.6L12 20.9 6.8 22.5v-1.6l3-2.2v-5.1L1.5 15.3v-2.1L9.8 10z"'
        + ' fill="' + band.color + '" stroke="#0E1012" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  });
};

/*  Dessine la flotte, marqueurs recyclés par identifiant : on déplace, on ne
    recrée pas.

    L'appariement des temps mérite une explication. Les relevés ADS-B sont
    datés de l'heure courante ; la dernière image radar, elle, a déjà
    quelques minutes de retard. Comparer les deux directement écarterait tout
    le trafic. On raisonne donc en décalage : à l'image située à T moins
    trente minutes correspondent les avions d'il y a trente minutes. Sur la
    dernière image, le décalage est nul et l'on montre le relevé le plus
    frais.                                                                */
Aircraft.prototype.render = function(frameTime, newestTime){
  if(!this.enabled) return;

  this.lastFrame  = frameTime  || this.lastFrame;
  this.lastNewest = newestTime || this.lastNewest;

  var ms = this.clockAt();
  var shown = {}, n = 0, self = this;

  for(var id in this.buffer){
    var s = this.stateAt(id, ms);
    if(!s) continue;
    shown[id] = true;
    n++;

    var m = this.markers[id];
    if(m){
      m.setLatLng([s.lat, s.lon]);
      /*  Reconstruire l'icône à chaque battement coûterait cher : cinq fois
          par seconde, sur des centaines d'appareils. On ne touche donc que
          la rotation, et la couleur seulement au changement de bande.    */
      var band = altBand(s.alt);
      if(m._svg){
        m._svg.style.transform = "rotate(" + (s.trk || 0) + "deg)";
        if(m._band !== band.color){
          m._svg.firstChild.setAttribute("fill", band.color);
          m._band = band.color;
        }
      } else {
        m.setIcon(this.icon(s));
      }
    } else {
      m = L.marker([s.lat, s.lon], { icon:this.icon(s), pane:"planes", keyboard:false });
      m.bindTooltip(this.describe(id, s), { direction:"top", offset:[0,-8], className:"plane-tip" });
      this.markers[id] = m;
      this.layer.addLayer(m);
      var el = m.getElement();
      m._svg  = el ? el.querySelector("svg") : null;
      m._band = altBand(s.alt).color;
    }
    m.setTooltipContent(this.describe(id, s));
  }

  for(var k in this.markers){
    if(shown[k]) continue;
    this.layer.removeLayer(this.markers[k]);
    delete this.markers[k];
  }
  this.on.count(n, ms);
};

Aircraft.prototype.describe = function(id, s){
  var m = this.meta[id] || {};
  var bits = [];
  if(m.call) bits.push(m.call);
  if(m.reg && m.reg !== m.call) bits.push(m.reg);
  if(m.type) bits.push(m.type);
  if(!bits.length) bits.push(id.toUpperCase());

  var line2 = [];
  if(s.alt !== null && s.alt !== undefined) line2.push(Math.round(s.alt).toLocaleString("fr-CA") + " pi");
  if(s.spd !== null && s.spd !== undefined) line2.push(Math.round(s.spd) + " kt");
  if(s.trk !== null && s.trk !== undefined) line2.push(Math.round(s.trk) + "°");

  return '<b>' + bits.join(" · ") + '</b>'
       + (line2.length ? '<br>' + line2.join("  ·  ") : "");
};

/*  Étendue réellement couverte par la mémoire : c'est elle qui dit quelle
    portion de la boucle radar peut être accompagnée d'avions.           */
Aircraft.prototype.coverage = function(){
  var from = Infinity, to = -Infinity, samples = 0, n = 0;
  for(var id in this.buffer){
    var b = this.buffer[id];
    if(!b.length) continue;
    n++; samples += b.length;
    if(b[0].t < from) from = b[0].t;
    if(b[b.length - 1].t > to) to = b[b.length - 1].t;
  }
  if(!n) return null;
  return { from:new Date(from), to:new Date(to), aircraft:n, samples:samples };
};

Aircraft.prototype.restore = async function(){
  var saved = await PlaneStore.load();
  if(saved && saved.buffer){
    this.buffer = saved.buffer;
    this.meta   = saved.meta || {};
  }

  /*  L'historique du serveur vient par-dessus : il remonte plus loin que le
      tampon local, qui ne couvre que les visites précédentes.           */
  await this.syncHistory(true);

  this.prune(Date.now());
  var c = this.coverage();
  this.since = c ? c.from.getTime() : null;
  return !!c;
};

/*  Verse des lignes venues de la base dans le tampon, en respectant le même
    amincissement que les relevés locaux, et sans dupliquer un instant déjà
    connu.                                                                */
/*  Rapatrie l'historique du serveur pour l'emprise courante. On mémorise
    l'emprise servie : tant que la carte y reste, rien à redemander. Sortir
    du cadre, en revanche, doit ramener les vols de la nouvelle zone.     */
Aircraft.prototype.syncHistory = async function(force){
  if(!historyEnabled()) return false;

  var bounds = this.map.getBounds();
  if(!force && this.histBounds && this.histBounds.contains(bounds)) return false;

  try {
    /*  On demande un peu plus large que l'écran : un léger déplacement ne
        redéclenche alors pas tout le rapatriement.                       */
    var marge = bounds.pad(0.35);
    var rows  = await fetchPlaneHistory(Date.now() - this.keep, marge, this.cap);
    if(rows){
      this.absorb(rows);
      this.histBounds = marge;
      this.prune(Date.now());
      this.render();
      var c = this.coverage();
      if(c) this.since = c.from.getTime();
      this.on.status(rows.length + " positions d'archive · " + this.sourceLabel());
    }
    return true;
  } catch(e){
    this.lastError = e;
    this.on.status("Historique indisponible — " + e.message + ". Le direct reste actif.");
    return false;
  }
};

Aircraft.prototype.absorb = function(rows){
  var self = this, added = 0;

  rows.forEach(function(r){
    var when = Date.parse(r.ts);
    if(isNaN(when)) return;

    var id = (r.icao24 || "").toLowerCase();
    if(!id) return;

    var b = self.buffer[id] = self.buffer[id] || [];
    var doublon = b.some(function(s){ return Math.abs(s.t - when) < 1000; });
    if(doublon) return;

    b.push({ t:when, lat:r.lat, lon:r.lon, trk:r.trk, alt:r.alt, spd:r.spd });
    added++;

    if(!self.meta[id] || !self.meta[id].call){
      self.meta[id] = { call:r.callsign || "", reg:r.reg || "", type:r.actype || "" };
    }
  });

  /* Le versement arrive dans le désordre : chaque piste est remise en ordre. */
  for(var id in this.buffer){
    this.buffer[id].sort(function(a, b){ return a.t - b.t; });
  }
  return added;
};

Aircraft.prototype.persist = function(){
  return PlaneStore.save({ buffer:this.buffer, meta:this.meta, saved:Date.now() });
};

Aircraft.prototype.forget = async function(){
  this.buffer = {}; this.meta = {}; this.since = null;
  await PlaneStore.clear();
  this.render();
  this.on.status("Mémoire du trafic effacée.");
};

/*  Instant auquel la flotte est montrée, selon le mode retenu. */
Aircraft.prototype.clockAt = function(){
  if(this.mode === "propre" && this.cursor) return this.cursor;

  var lag = (this.mode === "radar" && this.lastNewest && this.lastFrame)
          ? Math.max(0, this.lastNewest.getTime() - this.lastFrame.getTime())
          : 0;
  return Date.now() - lag;
};

/*  Horloge indépendante : elle parcourt l'étendue enregistrée par pas de
    `step` millisecondes de temps réel, et reboucle au début.            */
Aircraft.prototype.startAnim = function(){
  this.stopAnim();
  var self = this, c = this.coverage();
  if(!c) return false;

  if(!this.cursor || this.cursor < c.from.getTime() || this.cursor > c.to.getTime()){
    this.cursor = c.from.getTime();
  }

  this.anim = setInterval(function(){
    if(document.hidden) return;
    var e = self.coverage();
    if(!e) return;
    self.cursor += self.step;
    if(self.cursor > e.to.getTime()) self.cursor = e.from.getTime();
    self.render();
  }, this.tickMs);
  return true;
};

Aircraft.prototype.stopAnim = function(){
  clearInterval(this.anim);
  this.anim = null;
};

Aircraft.prototype.setMode = function(m){
  this.mode = m;
  if(m === "propre") this.startAnim();
  else { this.stopAnim(); this.cursor = null; }
  this.render();
};

Aircraft.prototype.setStep = function(ms){ this.step = ms; };

Aircraft.prototype.setRadius = function(nm){ this.radius = nm; if(this.enabled) this.poll(); };

Aircraft.prototype.setFollow = function(on){ this.follow = !!on; this.render(); };

/* --------------------------------------------------------------- exports */
global.RadarCore = {
  VERSION: VERSION,
  GEOMET: GEOMET,
  ATTR: ATTR,
  CARTO: CARTO,
  TZ: TZ,
  PRODUCTS: PRODUCTS,
  MAX_FRAMES: MAX_FRAMES,
  Prefs: Prefs,
  isoZ: isoZ,
  clock: clock,
  basemaps: basemaps,
  panes: panes,
  fetchTimes: fetchTimes,
  fetchCatalogue: fetchCatalogue,
  searchCatalogue: searchCatalogue,
  scanLayers: scanLayers,
  remember: remember,
  guessUnit: guessUnit,
  lerpAngle: lerpAngle,
  metaFor: metaFor,
  Track: Track,
  expandTimeDimension: expandTimeDimension,
  durationMs: durationMs,
  timeAxisFrom: timeAxisFrom,
  describeDoc: describeDoc,
  RadarLoop: RadarLoop,
  Aircraft: Aircraft,
  PLANE_SOURCES: PLANE_SOURCES,
  PlaneStore: PlaneStore,
  SUPABASE: SUPABASE,
  fetchPlaneHistory: fetchPlaneHistory,
  historyEnabled: historyEnabled,
  ALT_BANDS: ALT_BANDS,
  extractPlanes: extractPlanes
};

})(window);
