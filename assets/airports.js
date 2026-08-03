/*  Aérodromes tracés sur la carte — position et géométrie des pistes.

    Provenance : OurAirports, domaine public, relevé le 2026-08-03
    (davidmegginson/ourairports-data). Les seuils sont donnés en degrés ;
    le tracé n'est qu'une droite de l'un à l'autre, ce qui suffit : une piste
    est droite.

    Vérification faite à la génération — cap et longueur recalculés depuis les
    seuils et comparés aux valeurs publiées. Sept pistes sur huit s'accordent
    à 1,3 degré et 2,3 pour cent près. La huitième porte une note.

    Pour en ajouter : reprendre runways.csv d'OurAirports, ou saisir les
    seuils à la main. Rien d'autre à toucher — la console lit ce tableau.   */

window.CarteRadarAirports = [
  { ident:"CYUL", nom:"Montréal–Trudeau", officiel:"Montreal / Pierre Elliott Trudeau International Airport",
    lat:45.467837, lon:-73.742294, alt:118,
    pistes:[
      { id:"06L/24R", le:{ id:"06L", lat:45.461063, lon:-73.765015 }, he:{ id:"24R", lat:45.483276, lon:-73.735924 }, long:11000, larg:200, surface:"asphalte", eclairee:true, fermee:false },
      { id:"06R/24L", le:{ id:"06R", lat:45.457661, lon:-73.741386 }, he:{ id:"24L", lat:45.47702, lon:-73.716011 }, long:9600, larg:200, surface:"asphalte", eclairee:true, fermee:false },
      { id:"10/28", le:{ id:"10", lat:45.462502, lon:-73.764999 }, he:{ id:"28", lat:45.463299, lon:-73.738297 }, long:7000, larg:200, surface:"asphalte", eclairee:true, fermee:true },
    ]},
  { ident:"CYMX", nom:"Mirabel", officiel:"Montreal Mirabel International Airport",
    lat:45.679501, lon:-74.038696, alt:270,
    pistes:[
      { id:"06/24", le:{ id:"06", lat:45.670403, lon:-74.021751 }, he:{ id:"24", lat:45.693691, lon:-73.988564 }, long:12000, larg:200, surface:"béton", eclairee:true, fermee:false },
      { id:"11/29", le:{ id:"11", lat:45.670799, lon:-74.089996 }, he:{ id:"29", lat:45.6661, lon:-74.043602 }, long:8852, larg:200, surface:"béton", eclairee:false, fermee:false, note:"longueur publiée 8 852 pi, mais les seuils publiés en couvrent 11 951 — piste vraisemblablement raccourcie ; elle n'est plus éclairée" },
    ]},
  { ident:"CYHU", nom:"Saint-Hubert", officiel:"Montréal / Saint-Hubert Metropolitan Airport",
    lat:45.517502, lon:-73.416901, alt:90,
    pistes:[
      { id:"06L/24R", le:{ id:"06L", lat:45.510754, lon:-73.429131 }, he:{ id:"24R", lat:45.525387, lon:-73.40686 }, long:7840, larg:150, surface:"asphalte", eclairee:true, fermee:false },
      { id:"06R/24L", le:{ id:"06R", lat:45.511398, lon:-73.414703 }, he:{ id:"24L", lat:45.5186, lon:-73.403603 }, long:3920, larg:100, surface:"asphalte", eclairee:true, fermee:false },
      { id:"10/28", le:{ id:"10", lat:45.510799, lon:-73.426102 }, he:{ id:"28", lat:45.5117, lon:-73.415298 }, long:2800, larg:150, surface:"asphalte", eclairee:true, fermee:false },
    ]},
];
