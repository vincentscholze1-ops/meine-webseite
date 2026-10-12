// Symbol-Badge: zeigt auf einen Blick, was der Bot macht.
//   grüne Zahl  = Bot läuft, Anzahl aktiver Einsätze
//   gelbes "II" = pausiert
//   rotes "!"   = Bot ist an, aber kein Spiel-Tab meldet sich
//   leer        = gestoppt
async function updateBadge() {
  const { running = false, pausedUntil = 0 } = await chrome.storage.sync.get(["running", "pausedUntil"]);
  const { liveStatus } = await chrome.storage.local.get("liveStatus");
  const fresh = liveStatus && Date.now() - liveStatus.at < 2 * 60 * 1000;
  let text = "";
  let color = "#16a34a";
  let title = "LSS Verbands-Bot – gestoppt";
  if (running && pausedUntil > Date.now()) {
    text = "II";
    color = "#f59e0b";
    title = `LSS Verbands-Bot – pausiert bis ${new Date(pausedUntil).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  } else if (running && !fresh) {
    text = "!";
    color = "#d03b3b";
    title = "LSS Verbands-Bot – an, aber die Hauptseite des Leitstellenspiels ist nicht geöffnet";
  } else if (running) {
    text = String(liveStatus.active ?? "");
    title = `LSS Verbands-Bot – läuft, ${liveStatus.active ?? 0} Einsätze aktiv`;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && ("running" in changes || "pausedUntil" in changes)) || (area === "local" && changes.liveStatus)) {
    updateBadge();
  }
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
// Pausen-Ende und "Spiel geschlossen" auch ohne Speicheränderung erkennen
chrome.alarms.create("lssaa-badge", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === "lssaa-badge" && updateBadge());
