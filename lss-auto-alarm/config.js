// Standard-Einstellungen. Alles hier lässt sich auf der Optionsseite anpassen.
// Wird von bot.js, options.js und popup.js gemeinsam genutzt.

const LSS_DEFAULTS = {
  // Bot läuft (Start/Stopp im Panel oder Popup)
  running: false,

  // Welche Fahrzeuge geschickt werden. Pro Eintrag: Anzahl + erlaubte Typen.
  // Von den erlaubten Typen wird immer das nächstgelegene freie Fahrzeug genommen.
  preset: [{ count: 1, types: ["LF 20", "HLF 20", "LF 10", "LF 8/6", "LF 20/16", "LF 10/6", "LF 16-TS", "TSF-W", "MLF"] }],

  // ---------- Grenzen ----------
  // Prüfintervall in Sekunden (± 30 % Zufall)
  intervalSec: 60,
  // Höchstens so viele Einsätze pro Durchgang
  maxPerRound: 3,
  // Höchstens so viele Verbandseinsätze gleichzeitig, an denen du beteiligt bist
  maxActive: 10,
  // Höchstens so viele Alarmierungen pro Stunde
  maxPerHour: 40,
  // Nur Einsätze, bei denen das nächste passende Fahrzeug höchstens so weit weg ist (km)
  maxDistanceKm: 15,
  // Mindestens so viele passende Fahrzeuge bleiben für deine eigenen Einsätze frei
  reserve: 3,
  // Nur Einsätze mit mindestens so vielen Durchschnitts-Credits (laut einsaetze.json); 0 = egal
  minCredits: 0,
  // Einsätze ohne bekannte Credits (z.B. Events) trotzdem anfahren?
  allowUnknownCredits: true,
  // Einsätze überspringen, deren Name eines dieser Wörter enthält
  excludeWords: [],
  // Welche Einsatzlisten der Hauptseite der Bot abarbeitet (siehe LSS_LISTS)
  lists: { alliance: true, alliance_event: true, sicherheitswache: true, sicherheitswache_alliance: true },
  // Eigene Fahrzeugauswahl für geplante Einsätze (Sicherheitswachen); null = gleiche wie oben
  presetPlanned: null,
  // Nach so vielen Fehlern hintereinander stoppt der Bot
  maxErrors: 3
};

// Einsatzlisten auf der Hauptseite: Schlüssel -> [Element-ID, Anzeigename, geplant?]
const LSS_LISTS = {
  alliance: ["mission_list_alliance", "Verbandseinsätze", false],
  alliance_event: ["mission_list_alliance_event", "Verbands-Großschadenslagen / Events", false],
  sicherheitswache: ["mission_list_sicherheitswache", "Eigene geplante Einsätze (Sicherheitswachen)", true],
  sicherheitswache_alliance: ["mission_list_sicherheitswache_alliance", "Geplante Verbandseinsätze (Sicherheitswachen)", true]
};

// Fahrzeugtypen für die Auswahl auf der Einstellungsseite
const LSS_VEHICLE_GROUPS = {
  "Löschfahrzeuge": ["LF 20", "HLF 20", "LF 10", "HLF 10", "LF 8/6", "LF 20/16", "LF 10/6", "LF 16-TS", "TSF-W", "MLF", "KLF"],
  "Tanklöschfahrzeuge": ["TLF 2000", "TLF 3000", "TLF 4000", "TLF 8/8", "TLF 8/18", "TLF 16/24-Tr", "TLF 16/25", "TLF 16/45", "TLF 20/40", "TLF 20/40-SL", "TLF 16"],
  "Feuerwehr-Sonderfahrzeuge": ["DLK 23", "RW", "ELW 1", "ELW 2", "GW-A", "GW-Öl", "GW-Messtechnik", "GW-Gefahrgut", "GW-Höhenrettung", "GW-L2-Wasser", "SW 1000", "SW 2000", "SW 2000-Tr", "SW Kats", "MTW", "Dekon-P", "FwK"],
  "Rettungsdienst": ["RTW", "NEF", "KTW", "KTW Typ B", "RTH"],
  "Polizei": ["FuStW", "FuStW (DGL)", "GruKw", "leBefKw"],
  "THW": ["GKW", "MTW-TZ", "MzGW (FGr N)"]
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
