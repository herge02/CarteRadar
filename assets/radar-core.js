/*  Cœur commun aux deux consoles radar.
    Accès au service WMS GeoMet d'ECCC, gestion de la boucle d'images,
    fonds de carte et lecture ponctuelle. Ne dépend que de Leaflet.        */

(function (global) {
"use strict";

/*  Version du moteur, affichée dans l'interface. Elle sert à repérer d'un
    coup d'œil un fichier resté en cache : si le numéro montré à l'écran ne
    correspond pas au dernier déploiement, c'est le cache, pas le service. */
var VERSION = "8";

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
  metaFor: metaFor,
  Track: Track,
  expandTimeDimension: expandTimeDimension,
  durationMs: durationMs,
  timeAxisFrom: timeAxisFrom,
  describeDoc: describeDoc,
  RadarLoop: RadarLoop
};

})(window);
