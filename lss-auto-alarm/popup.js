// Popup der Erweiterung: Steuerung und Live-Zahlen. Die Zahlen schreibt der Bot im Spiel-Tab
// regelmäßig als "liveStatus" in den Speicher; das Popup liest sie nur.
const $ = (id) => document.getElementById(id);
const GAME = "https://www.leitstellenspiel.de/";
let settings = null;
let live = null;
let gameTabs = [];

const fmt = (n) => (n ?? 0).toLocaleString("de-DE");
const clock = (t) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const isPaused = () => settings && settings.pausedUntil > Date.now();
const liveFresh = () => live && Date.now() - live.at < 2 * 60 * 1000;

// Listen zusammengefasst: eigene und Verbands-Sicherheitswachen als ein Schalter
const LIST_GROUPS = [
  ["Verband", ["alliance"]],
  ["Events", ["alliance_event"]],
  ["Geplant", ["sicherheitswache", "sicherheitswache_alliance"]]
];

function render() {
  if (!settings) return;
  const running = settings.running;
  const paused = running && isPaused();
  const offline = !gameTabs.length || !liveFresh();
  document.body.className = paused ? "paused" : running ? (offline ? "running offline" : "running") : "";

  $("state").textContent = !gameTabs.length
    ? running
      ? "an – Spiel ist nicht geöffnet"
      : "gestoppt · Spiel nicht geöffnet"
    : paused
      ? `pausiert bis ${clock(settings.pausedUntil)}`
      : running
        ? liveFresh() && !live.haveLock
          ? "wartet (anderer Tab)"
          : "läuft"
        : "gestoppt";
  $("toggle").textContent = paused ? "▶  Fortsetzen" : running ? "■  Stoppen" : "▶  Starten";
  $("notice").textContent =
    running && !gameTabs.length ? "Der Bot arbeitet nur, solange die Hauptseite des Leitstellenspiels offen ist. → „Zum Spiel“" : "";

  // Tempo
  for (const b of $("speed").children) b.classList.toggle("on", b.dataset.speed === settings.speed);

  // Listen
  for (const b of $("lists").children) {
    const keys = LIST_GROUPS[b.dataset.group][1];
    b.classList.toggle("on", keys.some((k) => settings.lists[k]));
  }

  // Live-Zahlen
  const l = liveFresh() ? live : null;
  $("k-active").textContent = l ? fmt(l.active) : "–";
  $("k-credits").textContent = l && l.creditsToday != null ? fmt(l.creditsToday) : "–";
  $("k-credits-sub").textContent = l ? `Credits heute · ${fmt(l.lastHour)} alarmiert (60 min)` : "Credits heute";
  if (l && l.fleet) {
    $("k-load").textContent = l.fleet.busyPct + " %";
    $("k-load-sub").textContent = `Auslastung · ${fmt(l.fleet.presetFree)} deiner Auswahl frei`;
    $("k-load-meter").style.width = l.fleet.busyPct + "%";
  } else {
    $("k-load").textContent = "–";
    $("k-load-meter").style.width = "0";
  }
  tick();

  const mine = $("mine");
  mine.replaceChildren();
  for (const m of (l && l.mine) || []) {
    const li = document.createElement("li");
    li.className = m.state === "vor Ort" ? "green" : m.state === "Anfahrt" ? "yellow" : "red";
    const a = document.createElement("span");
    a.textContent = (m.planned ? "📅 " : "") + m.caption;
    const b = document.createElement("span");
    b.textContent = m.state;
    li.append(a, b);
    mine.appendChild(li);
  }
  if (!mine.children.length) mine.innerHTML = `<li class="empty" style="background:none;padding:0">—</li>`;

  const log = $("log");
  log.replaceChildren();
  for (const e of ((l && l.log) || []).slice(0, 4)) {
    const li = document.createElement("li");
    const t = document.createElement("time");
    t.textContent = clock(e.t);
    li.append(t, e.text);
    li.title = e.text;
    log.appendChild(li);
  }
  if (!log.children.length) log.innerHTML = `<li class="empty">Noch keine Aktivität.</li>`;
}

// Countdown & Fortschrittslinie jede Sekunde
let cycleStart = Date.now();
let cycleEnd = null;
function tick() {
  const l = liveFresh() ? live : null;
  let text = "–";
  let pct = 0;
  if (isPaused()) text = "Pause";
  else if (l && l.roundRunning) {
    text = "läuft…";
    pct = 100;
  } else if (l && l.nextRoundAt && settings.running) {
    if (l.nextRoundAt !== cycleEnd) {
      cycleEnd = l.nextRoundAt;
      cycleStart = Math.min(Date.now(), l.at);
    }
    text = Math.max(0, Math.round((l.nextRoundAt - Date.now()) / 1000)) + " s";
    pct = ((Date.now() - cycleStart) / Math.max(1, l.nextRoundAt - cycleStart)) * 100;
  }
  $("k-next").textContent = text;
  $("progress").style.width = Math.min(100, Math.max(0, pct)) + "%";
}
setInterval(tick, 1000);

// ---------- Aktionen ----------

$("toggle").addEventListener("click", () => {
  if (isPaused()) chrome.storage.sync.set({ pausedUntil: 0 });
  else chrome.storage.sync.set({ running: !settings.running, pausedUntil: 0 });
});
for (const b of document.querySelectorAll("[data-pause]")) {
  b.addEventListener("click", () =>
    chrome.storage.sync.set({ running: true, pausedUntil: Date.now() + Number(b.dataset.pause) * 60000 })
  );
}
for (const [key, v] of Object.entries(LSS_SPEEDS)) {
  const b = document.createElement("button");
  b.dataset.speed = key;
  b.title = v.hint;
  b.textContent = `${v.icon} ${v.label}`;
  b.addEventListener("click", () => chrome.storage.sync.set(lssSpeedValues(key)));
  $("speed").appendChild(b);
}
LIST_GROUPS.forEach(([label, keys], i) => {
  const b = document.createElement("button");
  b.className = "chip";
  b.dataset.group = i;
  b.textContent = label;
  b.title = keys.map((k) => LSS_LISTS[k][1]).join(" + ");
  b.addEventListener("click", () => {
    const on = !keys.some((k) => settings.lists[k]);
    const lists = { ...settings.lists };
    for (const k of keys) lists[k] = on;
    chrome.storage.sync.set({ lists });
  });
  $("lists").appendChild(b);
});

async function sendToGame(msg) {
  for (const tab of gameTabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, msg);
      if (res) return res;
    } catch (e) {
      // Tab ohne Bot – nächsten versuchen
    }
  }
  return null;
}

$("now").addEventListener("click", async () => {
  const res = await sendToGame({ type: "lssaa-now" });
  $("diag-out").textContent = !res
    ? "Kein Spiel-Tab mit Bot gefunden – „Zum Spiel“ öffnen."
    : res.ok
      ? "Prüfung gestartet."
      : res.reason + ".";
});
$("diag").addEventListener("click", async () => {
  $("diag-out").textContent = "Prüfe …";
  const res = await sendToGame({ type: "lssaa-diagnose" });
  $("diag-out").textContent = res
    ? res.lines.join("\n")
    : "Der Bot ist in keinem Tab geladen. Öffne die Hauptseite des Leitstellenspiels (oder lade sie mit F5 neu).";
});
$("game").addEventListener("click", async () => {
  const tab = gameTabs.find((t) => /^https:\/\/www\.leitstellenspiel\.de\/(\?.*)?(#.*)?$/.test(t.url || "")) || gameTabs[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: GAME });
  }
  window.close();
});
const openPage = (page) => () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  window.close();
};
$("stats").addEventListener("click", openPage("stats.html"));
$("stats2").addEventListener("click", openPage("stats.html"));
$("options").addEventListener("click", openPage("options.html"));
$("options2").addEventListener("click", openPage("options.html"));

// ---------- Daten laden & live mitlaufen ----------

$("version").textContent = "v" + chrome.runtime.getManifest().version;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? LSS_DEFAULTS[k];
  if (area === "local" && changes.liveStatus) live = changes.liveStatus.newValue;
  render();
});

(async () => {
  settings = await lssLoadSettings();
  live = (await chrome.storage.local.get("liveStatus")).liveStatus || null;
  gameTabs = await chrome.tabs.query({ url: "https://www.leitstellenspiel.de/*" });
  render();
})();
