const numbers = ["intervalSec", "maxPerRound", "maxActive", "maxPerHour", "maxDistanceKm", "reserve", "minCredits", "maxErrors"];
const texts = ["excludeMatch", "listSelector"];
const status = document.getElementById("status");
const $ = (id) => document.getElementById(id);

function fill(s) {
  for (const id of numbers) $(id).value = s[id];
  for (const id of texts) $(id).value = s[id];
  $("allowUnknownCredits").checked = s.allowUnknownCredits;
  $("preset").value = JSON.stringify(s.preset, null, 2);
}

function show(text, isError) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

$("save").addEventListener("click", () => {
  const s = { allowUnknownCredits: $("allowUnknownCredits").checked };
  for (const id of numbers) {
    const v = parseFloat($(id).value);
    s[id] = Number.isFinite(v) ? v : LSS_DEFAULTS[id];
  }
  s.intervalSec = Math.max(20, s.intervalSec);
  for (const id of texts) s[id] = $(id).value.trim();
  if (!s.listSelector) s.listSelector = LSS_DEFAULTS.listSelector;
  try {
    s.preset = JSON.parse($("preset").value);
    if (!Array.isArray(s.preset) || !s.preset.every((p) => p.count > 0 && Array.isArray(p.types))) {
      throw new Error("Fahrzeugauswahl: jeder Eintrag braucht count und types");
    }
    if (s.excludeMatch) new RegExp(s.excludeMatch);
    document.querySelector(s.listSelector);
  } catch (e) {
    show("Fehler: " + e.message, true);
    return;
  }
  chrome.storage.sync.set(s, () => {
    if (chrome.runtime.lastError) show("Fehler: " + chrome.runtime.lastError.message, true);
    else show("Gespeichert – gilt sofort.");
  });
});

$("reset").addEventListener("click", () => {
  lssLoadSettings().then(({ running }) => {
    chrome.storage.sync.clear(() => {
      chrome.storage.sync.set({ running });
      fill(LSS_DEFAULTS);
      show("Zurückgesetzt.");
    });
  });
});

lssLoadSettings().then(fill);
