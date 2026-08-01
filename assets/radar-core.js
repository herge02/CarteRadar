/*  Cœur commun aux deux consoles radar.
    Accès au service WMS GeoMet d'ECCC, gestion de la boucle d'images,
    fonds de carte et lecture ponctuelle. Ne dépend que de Leaflet.        */

(function (global) {
"use strict";

var GEOMET = "https://geo.weather.gc.ca/geomet";
var TZ     = "America/Toronto";
var ATTR   = 'Radar © <a href="https://eccc-msc.github.io/open-data/" target="_blank" rel="noopener">ECCC / GeoMet</a>';
var CARTO  = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

var PRODUCTS = {
  RADAR_1KM_RRAI: { label: "Pluie", unit: "mm/h", coverage: "RADAR_COVERAGE_RRAI.INV" },
  RADAR_1KM_RSNO: { label: "Neige", unit: "cm/h", coverage: "RADAR_COVERAGE_RSNO.INV" }
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

/* --------------------------------------------------- axe temps de GeoMet */
async function fetchTimes(product, wanted){
  var url = GEOMET + "?service=WMS&version=1.3.0&request=GetCapabilities&layer="
          + encodeURIComponent(product) + "&t=" + Date.now();
  var res = await fetch(url);
  if(!res.ok) throw new Error("GetCapabilities " + res.status);

  var xml = new DOMParser().parseFromString(await res.text(), "text/xml");
  var all = xml.getElementsByTagName("Dimension"), dim = null;
  for(var i = 0; i < all.length; i++){
    if((all[i].getAttribute("name") || "").toLowerCase() === "time"){ dim = all[i]; break; }
  }
  if(!dim) dim = all[0];
  if(!dim) throw new Error("dimension temporelle absente");

  var parts  = dim.textContent.trim().split("/");
  var m      = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(parts[2] || "PT6M") || [];
  var stepMs = ((+m[1] || 0) * 60 + (+m[2] || 6)) * 60000;

  var d0 = new Date(parts[0]), d1 = new Date(parts[1]);
  if(isNaN(d1)) throw new Error("axe temps illisible");

  var available = Math.floor((d1 - d0) / stepMs) + 1;
  var n = Math.max(1, Math.min(wanted, available));

  var out = [];
  for(var k = n - 1; k >= 0; k--) out.push(new Date(d1.getTime() - k * stepMs));
  return { times: out, available: available, step: stepMs };
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

  this.on = Object.assign({
    built:    function(){},
    show:     function(){},
    progress: function(){},
    playing:  function(){},
    error:    function(){}
  }, opts.on || {});
}

RadarLoop.prototype.info = function(){
  return PRODUCTS[this.product] || { label: this.product, unit: "", coverage: null };
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
  catch(e){ this.on.error(e); return false; }

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

RadarLoop.prototype.setProduct = function(id){
  this.product = id;
  this.pause();
  return this.build();
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
  RadarLoop: RadarLoop
};

})(window);
