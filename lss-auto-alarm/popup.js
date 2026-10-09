const toggle = document.getElementById("toggle");
const diagOut = document.getElementById("diag-out");
let running = false;

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

function render() {
  toggle.textContent = running ? "■ Stoppen" : "▶ Starten";
}

lssLoadSettings().then((s) => {
  running = s.running;
  render();
});
toggle.addEventListener("click", () => {
  running = !running;
  chrome.storage.sync.set({ running });
  render();
});

document.getElementById("diag").addEventListener("click", async () => {
  diagOut.textContent = "Prüfe …";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  if (!/^https:\/\/www\.leitstellenspiel\.de\/(\?.*)?(#.*)?$/.test(url)) {
    diagOut.textContent =
      "Dieser Tab ist nicht die Hauptseite des Leitstellenspiels.\n" +
      "Öffne https://www.leitstellenspiel.de/ und klicke dort noch einmal auf Diagnose.";
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "lssaa-diagnose" });
    diagOut.textContent = res.lines.join("\n") + (res.panel ? "" : "\n(Panel fehlt auf der Seite!)");
  } catch (e) {
    diagOut.textContent =
      "Der Bot ist auf dieser Seite nicht geladen.\n" +
      "→ Seite mit F5 neu laden. Hilft das nicht: auf chrome://extensions beim Bot auf ↻ klicken und erneut F5.\n" +
      "(" + e.message + ")";
  }
});

document.getElementById("stats").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "lssaa-stats" });
    window.close();
  } catch (e) {
    diagOut.textContent = "Die Auswertung öffnet sich auf der Hauptseite des Leitstellenspiels. Öffne den Tab und versuche es erneut.";
  }
});

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
