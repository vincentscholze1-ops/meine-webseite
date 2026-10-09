const checks = ["enabled", "autoSelect", "alarmAndNext"];
const keys = ["alarmKey", "reselectKey"];
const jsons = ["fallback", "categories", "requirementMap"];
const status = document.getElementById("status");

function fill(s) {
  for (const id of checks) document.getElementById(id).checked = s[id];
  for (const id of keys) document.getElementById(id).value = s[id];
  for (const id of jsons) document.getElementById(id).value = JSON.stringify(s[id], null, 2);
}

function show(text, isError) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

document.getElementById("save").addEventListener("click", () => {
  const s = {};
  for (const id of checks) s[id] = document.getElementById(id).checked;
  for (const id of keys) s[id] = (document.getElementById(id).value || LSS_DEFAULTS[id]).toLowerCase();
  try {
    for (const id of jsons) s[id] = JSON.parse(document.getElementById(id).value);
    for (const c of s.categories) new RegExp(c.match);
  } catch (e) {
    show("Fehler: " + e.message, true);
    return;
  }
  chrome.storage.sync.set(s, () => {
    if (chrome.runtime.lastError) show("Fehler: " + chrome.runtime.lastError.message, true);
    else show("Gespeichert – Einsatzfenster neu öffnen.");
  });
});

document.getElementById("reset").addEventListener("click", () => {
  chrome.storage.sync.clear(() => {
    fill(LSS_DEFAULTS);
    show("Zurückgesetzt.");
  });
});

lssLoadSettings().then(fill);
