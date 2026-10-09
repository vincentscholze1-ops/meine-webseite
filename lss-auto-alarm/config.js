// Standard-Einstellungen. Alles hier lässt sich auf der Optionsseite anpassen.
// Wird von bot.js, options.js und popup.js gemeinsam genutzt.

const LSS_DEFAULTS = {
  // Bot läuft (Start/Stopp im Panel oder Popup)
  running: false,

  // Welche Fahrzeuge geschickt werden. Pro Eintrag: Anzahl + erlaubte Fahrzeugtypen.
  // Von den erlaubten Typen wird immer das nächstgelegene freie Fahrzeug genommen.
  // Gespeichert werden die festen Typ-IDs (vehicle_type_id), nicht die Namen.
  preset: [{ count: 1, typeIds: lssTypeIds(["LF 20", "HLF 20", "LF 10", "LF 8/6", "LF 20/16", "LF 10/6", "LF 16-TS", "TSF-W", "MLF"]) }],

  // ---------- Grenzen ----------
  // Tempo-Stufe (siehe LSS_SPEEDS); "eigene", sobald Werte von Hand geändert werden
  speed: "normal",
  // Prüfintervall in Sekunden (± 30 % Zufall)
  intervalSec: 60,
  // Pause zwischen zwei Alarmierungen innerhalb einer Prüfung (Sekunden, ± 30 % Zufall)
  pauseSec: 3,
  // Optionale Obergrenzen (0 = unbegrenzt): pro Durchgang, gleichzeitig beteiligt, pro Stunde
  maxPerRound: 5,
  maxActive: 0,
  maxPerHour: 0,
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
  maxErrors: 3,
  // Version der gespeicherten Einstellungen (für Umstellungen bei Updates)
  settingsVersion: 6
};

// Tempo-Stufen für die drei Knöpfe im Panel und auf der Einstellungsseite
const LSS_SPEEDS = {
  gemuetlich: { icon: "🐢", label: "Gemütlich", intervalSec: 120, maxPerRound: 2, pauseSec: 6,
    hint: "alle ~2 min, höchstens 2 Einsätze pro Prüfung" },
  normal: { icon: "🚗", label: "Normal", intervalSec: 60, maxPerRound: 5, pauseSec: 3,
    hint: "jede Minute, höchstens 5 Einsätze pro Prüfung" },
  schnell: { icon: "🚀", label: "Schnell", intervalSec: 25, maxPerRound: 0, pauseSec: 1,
    hint: "alle ~25 s, alle passenden Einsätze sofort" }
};

// Welche Tempo-Stufe passt zu den aktuellen Werten? (sonst "eigene")
function lssSpeedOf(s) {
  const hit = Object.entries(LSS_SPEEDS).find(
    ([, v]) => v.intervalSec === s.intervalSec && v.maxPerRound === s.maxPerRound && v.pauseSec === s.pauseSec
  );
  return hit ? hit[0] : "eigene";
}

function lssSpeedValues(key) {
  const { intervalSec, maxPerRound, pauseSec } = LSS_SPEEDS[key];
  return { speed: key, intervalSec, maxPerRound, pauseSec };
}

// Einsatzlisten auf der Hauptseite: Schlüssel -> [Element-ID, Anzeigename, geplant?]
const LSS_LISTS = {
  alliance: ["mission_list_alliance", "Verbandseinsätze", false],
  alliance_event: ["mission_list_alliance_event", "Verbands-Großschadenslagen / Events", false],
  sicherheitswache: ["mission_list_sicherheitswache", "Eigene geplante Einsätze (Sicherheitswachen)", true],
  sicherheitswache_alliance: ["mission_list_sicherheitswache_alliance", "Geplante Verbandseinsätze (Sicherheitswachen)", true]
};

// Fahrzeugtyp-Namen -> feste Typ-IDs (benötigt vehicle-types.js, das vorher geladen wird)
function lssTypeIds(names) {
  const byName = Object.fromEntries(LSS_VEHICLE_TYPES.map(([id, name]) => [name, id]));
  return names.map((n) => byName[n]).filter((id) => id !== undefined);
}

// Alte Auswahl (Typnamen) auf Typ-IDs umstellen
function lssMigratePreset(preset) {
  if (!Array.isArray(preset)) return preset;
  return preset.map((p) => (p.typeIds ? p : { count: p.count || 1, typeIds: lssTypeIds(p.types || []) }));
}

function lssLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ ...LSS_DEFAULTS, settingsVersion: 0 }, (s) => {
      // Ab Version 4 sind die Mengen-Obergrenzen standardmäßig aus
      if (s.settingsVersion < 4) {
        Object.assign(s, { maxPerRound: 0, maxActive: 0, maxPerHour: 0, settingsVersion: 4 });
        chrome.storage.sync.set({ maxPerRound: 0, maxActive: 0, maxPerHour: 0, settingsVersion: 4 });
      }
      // Ab Version 5 wird die Fahrzeugauswahl über feste Typ-IDs gespeichert
      if (s.settingsVersion < 5) {
        s.preset = lssMigratePreset(s.preset);
        s.presetPlanned = lssMigratePreset(s.presetPlanned);
        s.settingsVersion = 5;
        chrome.storage.sync.set({ preset: s.preset, presetPlanned: s.presetPlanned, settingsVersion: 5 });
      }
      // Ab Version 6 gibt es Tempo-Stufen; bisherige Werte bleiben erhalten
      if (s.settingsVersion < 6) {
        // Standard-Intervall -> Stufe "Normal"; selbst gewählte Intervalle bleiben als "eigene"
        const v = s.intervalSec === 60 ? lssSpeedValues("normal") : { speed: lssSpeedOf(s), pauseSec: s.pauseSec };
        Object.assign(s, v, { settingsVersion: 6 });
        chrome.storage.sync.set({ ...v, settingsVersion: 6 });
      }
      resolve(s);
    });
  });
}
