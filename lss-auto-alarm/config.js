// Standard-Einstellungen. Alles hier lässt sich auf der Optionsseite anpassen.
// Wird von content.js, options.js und popup.js gemeinsam genutzt.

const LSS_DEFAULTS = {
  enabled: true,
  // Fahrzeuge beim Öffnen eines Einsatzes automatisch anhaken
  autoSelect: true,
  // Nach "Alarmieren" per Tastenkürzel direkt zum nächsten Einsatz springen
  alarmAndNext: false,
  // Tastenkürzel (immer mit Alt): Alt+<alarmKey> alarmiert, Alt+<reselectKey> berechnet neu
  alarmKey: "a",
  reselectKey: "r",
  // Wenn weder Fehlmeldung noch Einsatzanforderung bekannt ist: was soll geschickt werden?
  fallback: [{ category: "loeschfahrzeug", count: 1 }],

  // Fahrzeugkategorien. "match" ist ein regulärer Ausdruck, der gegen die Texte der
  // Fehlmeldung ("Zusätzlich benötigte Fahrzeuge: 2 Löschfahrzeuge, 1 Drehleiter")
  // geprüft wird. "types" sind die Fahrzeugtypen in Wunsch-Reihenfolge.
  // Reihenfolge der Kategorien ist wichtig: die erste passende gewinnt.
  categories: [
    { id: "elw2", label: "ELW 2", match: "ELW ?2|Einsatzleitwagen 2", types: ["ELW 2", "AB-Einsatzleitung"] },
    { id: "elw1", label: "ELW 1", match: "ELW ?1|Einsatzleitwagen", types: ["ELW 1", "ELW 2"] },
    { id: "drehleiter", label: "Drehleiter", match: "Drehleiter|DLK", types: ["DLK 23"] },
    { id: "ruestwagen", label: "Rüstwagen", match: "Rüstwagen|\\bRW\\b", types: ["RW", "HLF 20", "HLF 10"] },
    { id: "gwa", label: "GW-Atemschutz", match: "Atemschutz|GW-A\\b", types: ["GW-A", "AB-Atemschutz"] },
    { id: "gwoel", label: "GW-Öl", match: "Öl", types: ["GW-Öl", "AB-Öl"] },
    { id: "gwmess", label: "GW-Messtechnik", match: "Messtechnik|GW-Mess", types: ["GW-Messtechnik"] },
    { id: "gwg", label: "GW-Gefahrgut", match: "Gefahrgut|GW-G\\b", types: ["GW-Gefahrgut", "AB-Gefahrgut"] },
    { id: "gwh", label: "GW-Höhenrettung", match: "Höhenrettung", types: ["GW-Höhenrettung"] },
    { id: "dekon", label: "Dekon-P", match: "Dekon", types: ["Dekon-P", "AB-Dekon-P"] },
    { id: "schlauchwagen", label: "Schlauchwagen", match: "Schlauchwagen|\\bSW\\b", types: ["SW 1000", "SW 2000", "SW 2000-Tr", "SW Kats", "GW-L2-Wasser", "AB-Schlauch"] },
    { id: "fwk", label: "Feuerwehrkran", match: "FwK|Kran", types: ["FwK"] },
    { id: "tlf", label: "Tanklöschfahrzeug", match: "Tanklösch|\\bTLF\\b", types: ["TLF 2000", "TLF 3000", "TLF 4000", "TLF 8/8", "TLF 8/18", "TLF 16/24-Tr", "TLF 16/25", "TLF 16/45", "TLF 20/40", "TLF 20/40-SL", "TLF 16"] },
    { id: "loeschfahrzeug", label: "Löschfahrzeug", match: "Löschfahrzeug|Feuerwehrfahrzeug", types: ["LF 20", "HLF 20", "LF 10", "HLF 10", "LF 20/16", "LF 10/6", "LF 8/6", "LF 16-TS", "TSF-W", "MLF", "KLF"] },
    { id: "mtw", label: "MTW", match: "\\bMTW\\b|Mannschaftstransport", types: ["MTW"] },
    { id: "nef", label: "NEF", match: "\\bNEF\\b|Notarzt", types: ["NEF", "RTH"] },
    { id: "rtw", label: "RTW", match: "\\bRTW\\b|Rettungswagen", types: ["RTW"] },
    { id: "ktw", label: "KTW", match: "\\bKTW\\b|Krankentransport", types: ["KTW"] },
    { id: "fustw", label: "Funkstreifenwagen", match: "Streifenwagen|FuStW|Polizei", types: ["FuStW", "FuStW (DGL)"] },
    { id: "gkw", label: "GKW (THW)", match: "\\bGKW\\b|Gerätekraftwagen", types: ["GKW"] }
  ],

  // Zuordnung der Anforderungs-Schlüssel aus /einsaetze.json zu den Kategorien oben.
  // Wird nur genutzt, solange noch keine Fehlmeldung im Einsatz steht (frischer Einsatz).
  requirementMap: {
    firetrucks: "loeschfahrzeug",
    platform_trucks: "drehleiter",
    heavy_rescue_vehicles: "ruestwagen",
    battalion_chief_vehicles: "elw1",
    mobile_command_vehicles: "elw2",
    mobile_air_vehicles: "gwa",
    gwoil: "gwoel",
    gwmess: "gwmess",
    hazmat_vehicles: "gwg",
    height_rescue_units: "gwh",
    hazmat_dekon: "dekon",
    water_tankers: "tlf",
    gwl2wasser: "schlauchwagen",
    fwk: "fwk",
    mtw: "mtw",
    ambulances: "rtw",
    police_cars: "fustw",
    thw_gkw: "gkw"
  }
};

// Fallback, falls eine Tabellenzeile keinen Typnamen trägt, nur die vehicle_type_id.
const LSS_TYPE_IDS = {
  0: "LF 20", 1: "LF 10", 2: "DLK 23", 3: "ELW 1", 4: "RW", 5: "GW-A", 6: "LF 8/6",
  7: "LF 20/16", 8: "LF 10/6", 9: "LF 16-TS", 10: "GW-Öl", 11: "GW-L2-Wasser",
  12: "GW-Messtechnik", 13: "SW 1000", 14: "SW 2000", 15: "SW 2000-Tr", 16: "SW Kats",
  17: "TLF 2000", 18: "TLF 3000", 19: "TLF 8/8", 20: "TLF 8/18", 21: "TLF 16/24-Tr",
  22: "TLF 16/25", 23: "TLF 16/45", 24: "TLF 20/40", 25: "TLF 20/40-SL", 26: "TLF 16",
  27: "GW-Gefahrgut", 28: "RTW", 29: "NEF", 30: "HLF 20", 31: "RTH", 32: "FuStW",
  33: "GW-Höhenrettung", 34: "ELW 2", 36: "MTW", 37: "TSF-W", 38: "KTW", 39: "GKW",
  53: "Dekon-P", 57: "FwK"
};

function lssLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(LSS_DEFAULTS, (s) => resolve(s));
  });
}
