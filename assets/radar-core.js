/*  Cœur commun aux deux consoles radar.
    Accès au service WMS GeoMet d'ECCC, gestion de la boucle d'images,
    fonds de carte et lecture ponctuelle. Ne dépend que de Leaflet.        */

(function (global) {
"use strict";

/*  Version du moteur, affichée dans l'interface. Elle sert à repérer d'un
    coup d'œil un fichier resté en cache : si le numéro montré à l'écran ne
    correspond pas au dernier déploiement, c'est le cache, pas le service. */
var VERSION = "4";

var GEOMET = "https://geo.weather.gc.ca/geomet";
var TZ     = "America/Toronto";
var ATTR   = 'Radar © <a href="https://eccc-msc.github.io/open-data/" target="_blank" rel="noopener">ECCC / GeoMet</a>';
var CARTO  = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

/*  Les quatre composites 1 km de GeoMet, croisant deux grandeurs et deux
    hypothèses de phase. Toute l'interface se construit à partir d'ici :
    ajouter une ligne suffit à faire apparaître le produit des deux côtés.
    « pluie » et « neige » désignent la table de conversion appliquée à
    l'écho, pas ce qui tombe réellement.                                  */
var PRODUCTS = {
  RADAR_1KM_RRAI: { quantity:"Taux de précipitation", phase:"Pluie", unit:"mm/h", coverage:"RADAR_COVERAGE_RRAI.INV" },
  RADAR_1KM_RSNO: { quantity:"Taux de précipitation", phase:"Neige", unit:"cm/h", coverage:"RADAR_COVERAGE_RSNO.INV" },
  RADAR_1KM_RDBR: { quantity:"Réflectivité",          phase:"Pluie", unit:"dBZ",  coverage:"RADAR_COVERAGE_RRAI.INV" },
  RADAR_1KM_RDBS: { quantity:"Réflectivité",          phase:"Neige", unit:"dBZ",  coverage:"RADAR_COVERAGE_RSNO.INV" }
};

/* Retrouve l'identifiant à partir du couple grandeur / phase. */
function findProduct(quantity, phase){
  for(var id in PRODUCTS){
    if(PRODUCTS[id].quantity === quantity && PRODUCTS[id].phase === phase) return id;
  }
  return null;
}

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

/* --------------------------------------------------- axe temps de GeoMet */
async function fetchTimes(product, wanted){
  var url = GEOMET + "?service=WMS&version=1.3.0&request=GetCapabilities&layer="
          + encodeURIComponent(product) + "&t=" + Date.now();
  var res = await fetch(url);
  if(!res.ok) throw new Error("GetCapabilities " + res.status);

  var body = await res.text();
  var xml  = new DOMParser().parseFromString(body, "text/xml");

  /* GeoMet répond parfois 200 en portant un rapport d'exception OGC. */
  var exc = xml.getElementsByTagName("ServiceException")[0]
         || xml.getElementsByTagName("ExceptionText")[0];
  if(exc) throw new Error("refus de GeoMet : " + exc.textContent.trim().slice(0, 120));

  var all = xml.getElementsByTagName("Dimension"), dim = null;
  for(var i = 0; i < all.length; i++){
    if((all[i].getAttribute("name") || "").toLowerCase() === "time"){ dim = all[i]; break; }
  }
  if(!dim) dim = all[0];
  if(!dim) throw new Error("couche sans dimension temporelle");

  var raw   = dim.textContent.trim();
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

/* ============================================================ RadarLoop ==
   Détient la pile d'images WMS et son horloge. L'interface s'y branche par
   des rappels ; elle ne touche jamais aux couches Leaflet directement.    */

function RadarLoop(map, opts){
  opts = opts || {};
  this.map     = map;
  this.product = opts.product || "RADAR_1KM_RRAI";
  this.wanted  = opts.wanted  || MAX_FRAMES;
  this.fps     = opts.fps     || 5;
  this.opacity = opts.opacity != null ? opts.opacity : 0.78;
  this.dwell   = opts.dwell   || 1300;   // arrêt sur la dernière image

  this.times = [];
  this.frames = [];
  this.idx = 0;
  this.available = 0;
  this.playing = false;
  this.timer = null;
  this.loaded = 0;
  this.lastError = null;   // cause du dernier échec de build, pour le diagnostic

  this.on = Object.assign({
    built:    function(){},
    show:     function(){},
    progress: function(){},
    playing:  function(){},
    error:    function(){}
  }, opts.on || {});
}

RadarLoop.prototype.info = function(){
  return PRODUCTS[this.product] ||
         { quantity: this.product, phase: "", unit: "", coverage: null };
};

RadarLoop.prototype._frame = function(date){
  return L.tileLayer.wms(GEOMET + "?", {
    layers        : this.product,
    format        : "image/png",
    transparent   : true,
    version       : "1.3.0",
    time          : isoZ(date),
    opacity       : 0,
    pane          : "radar",
    updateWhenIdle: true,
    keepBuffer    : 1,
    attribution   : ATTR
  });
};

RadarLoop.prototype.build = async function(){
  var data;
  try { data = await fetchTimes(this.product, this.wanted); }
  catch(e){ this.lastError = e; this.on.error(e); return false; }
  this.lastError = null;

  var self = this;
  this.frames.forEach(function(l){ self.map.removeLayer(l); });

  this.times     = data.times;
  this.available = data.available;
  this.loaded    = 0;
  this.frames    = data.times.map(function(d){ return self._frame(d); });

  var total = this.frames.length;
  this.frames.forEach(function(l){
    l.once("load", function(){
      self.loaded++;
      self.on.progress(self.loaded / total);
    });
    l.addTo(self.map);
  });

  this.on.built(this);
  this.show(total - 1);
  return true;
};

RadarLoop.prototype.show = function(i){
  var n = this.times.length;
  if(!n) return;
  i = ((i % n) + n) % n;

  var self = this;
  this.frames.forEach(function(l, k){ l.setOpacity(k === i ? self.opacity : 0); });
  this.idx = i;
  this.on.show(this.times[i], i, n);
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

RadarLoop.prototype.setOpacity = function(v){ this.opacity = v; this.show(this.idx); };

RadarLoop.prototype.setFps = function(v){
  this.fps = v;
  if(this.playing){ this.pause(); this.play(); }
};

/*  Toutes les couches annoncées ne sont pas forcément servies : si GeoMet
    refuse la nouvelle, on revient à la précédente plutôt que de laisser la
    carte vide. Le rappel `error` a déjà prévenu l'utilisateur.           */
RadarLoop.prototype.setProduct = async function(id){
  var previous = this.product;
  if(id === previous) return true;

  this.product = id;
  this.pause();
  if(await this.build()) return true;

  var why = this.lastError;    // le build de repli va l'effacer
  this.product = previous;
  await this.build();
  this.lastError = why;
  return false;
};

RadarLoop.prototype.setWanted = function(n){
  this.wanted = n;
  return this.build();
};

/* Ajoute les images parues depuis le dernier appel sans rebâtir la pile. */
RadarLoop.prototype.refresh = async function(){
  if(!this.times.length) return this.build();

  var data;
  try { data = await fetchTimes(this.product, this.wanted); }
  catch(e){ return false; }

  var newest = data.times[data.times.length - 1].getTime();
  if(newest === this.times[this.times.length - 1].getTime()) return false;

  var self    = this;
  var wasLive = this.idx === this.times.length - 1;
  var known   = {};
  this.times.forEach(function(d){ known[d.getTime()] = true; });

  data.times.forEach(function(d){
    if(known[d.getTime()]) return;
    var l = self._frame(d);
    l.addTo(self.map);
    self.times.push(d);
    self.frames.push(l);
  });

  while(this.times.length > this.wanted){
    this.map.removeLayer(this.frames.shift());
    this.times.shift();
    this.idx = Math.max(0, this.idx - 1);
  }

  this.on.built(this);
  this.show(wasLive ? this.times.length - 1 : this.idx);
  return true;
};

RadarLoop.prototype.legendUrl = function(){
  return GEOMET + "?version=1.3.0&service=WMS&request=GetLegendGraphic"
       + "&sld_version=1.1.0&format=image/png&layer=" + encodeURIComponent(this.product);
};

/* Lecture ponctuelle : intensité sous le point cliqué, à l'image affichée. */
RadarLoop.prototype.valueAt = async function(latlng){
  if(!this.times.length) throw new Error("aucune image");

  var size = this.map.getSize();
  var b    = this.map.getBounds();
  var sw   = L.CRS.EPSG3857.project(b.getSouthWest());
  var ne   = L.CRS.EPSG3857.project(b.getNorthEast());
  var pt   = this.map.latLngToContainerPoint(latlng);

  var q = new URLSearchParams({
    service: "WMS", version: "1.3.0", request: "GetFeatureInfo",
    layers: this.product, query_layers: this.product,
    crs: "EPSG:3857",
    bbox: [sw.x, sw.y, ne.x, ne.y].join(","),
    width: size.x, height: size.y,
    i: Math.round(pt.x), j: Math.round(pt.y),
    info_format: "application/json",
    time: isoZ(this.times[this.idx])
  });

  var res = await fetch(GEOMET + "?" + q.toString());
  var txt = await res.text();
  var value = null;

  try {
    var j = JSON.parse(txt);
    var p = (j.features && j.features[0] && j.features[0].properties) || {};
    for(var k in p){
      var v = parseFloat(p[k]);
      if(!isNaN(v)){ value = v; break; }
    }
  } catch(e){
    var m = /-?\d+(\.\d+)?/.exec(txt);
    if(m) value = parseFloat(m[0]);
  }

  return { value: value, unit: this.info().unit };
};

/* --------------------------------------------------------------- exports */
global.RadarCore = {
  VERSION: VERSION,
  GEOMET: GEOMET,
  ATTR: ATTR,
  CARTO: CARTO,
  TZ: TZ,
  PRODUCTS: PRODUCTS,
  findProduct: findProduct,
  MAX_FRAMES: MAX_FRAMES,
  Prefs: Prefs,
  isoZ: isoZ,
  clock: clock,
  basemaps: basemaps,
  panes: panes,
  fetchTimes: fetchTimes,
  expandTimeDimension: expandTimeDimension,
  durationMs: durationMs,
  RadarLoop: RadarLoop
};

})(window);
