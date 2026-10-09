// Auswertungsseite (stats.html). Liest die gespeicherten Daten direkt; zum Abruf neuer
// Credits wird der offene Leitstellenspiel-Tab gebeten, die Credits-Übersicht zu lesen.
const $ = (sel) => document.querySelector(sel);
let period = "today";

const fmt = (n) => (n ?? 0).toLocaleString("de-DE");
const ago = (t) => {
  const min = Math.round((Date.now() - t) / 60000);
  return min < 1 ? "gerade eben" : min < 60 ? `vor ${min} min` : `vor ${Math.round(min / 60)} h`;
};
const time = (t) =>
  new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const STATUS_CLASS = {
  erfolgreich: "ok",
  "ohne Credits": "bad",
  abgebrochen: "bad",
  läuft: "run",
  "wartet auf Credits": "run"
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function render(message) {
  const data = await LssStats.load();
  const r = LssStats.evaluate(data, LssStats.PERIODS[period][1]());
  const body = $("#content");
  body.replaceChildren();

  const tabs = el("div", "tabs");
  for (const [key, [label]] of Object.entries(LssStats.PERIODS)) {
    const b = el("button", key === period ? "on" : "", label);
    b.type = "button";
    b.addEventListener("click", () => {
      period = key;
      render();
    });
    tabs.appendChild(b);
  }
  body.appendChild(tabs);

  const kpis = el("div", "kpis");
  const kpi = (value, label, cls) => {
    const k = el("div", "kpi " + (cls || ""));
    k.append(el("b", "", value), el("span", "", label));
    kpis.appendChild(k);
  };
  kpi(fmt(r.sent), "vom Bot alarmiert");
  kpi(fmt(r.success), `erfolgreich abgeschlossen${r.sent ? ` (${Math.round((r.success / r.sent) * 100)} %)` : ""}`, "ok");
  kpi(fmt(r.botCredits), "Credits erhalten", "money");
  kpi(fmt(r.avg), "Ø Credits je Einsatz");
  body.appendChild(kpis);

  const states = el("div", "states");
  states.append(
    el("span", "", `⏳ ${r.running} laufen noch / warten auf Credits`),
    el("span", "", `✖ ${r.without} ohne Credits`),
    el("span", "", `⊘ ${r.cancelled} abgebrochen`)
  );
  body.appendChild(states);

  const all = el("div", "note");
  all.innerHTML =
    `<b>Alle Verbandseinsätze mit deiner Beteiligung</b> laut Credits-Übersicht (auch von Hand alarmierte): ` +
    `<b>${fmt(r.allianceCount)}</b> Einsätze, <b>${fmt(r.allianceCredits)}</b> Credits` +
    (r.eventCredits ? ` · Verbands-Event-Belohnungen: <b>${fmt(r.eventCredits)}</b> Credits` : "");
  body.appendChild(all);

  if (r.days.length > 1) {
    body.appendChild(el("h2", "", "Pro Tag (vom Bot)"));
    const t = el("table");
    t.innerHTML = "<thead><tr><th>Tag</th><th>Einsätze</th><th>Credits</th></tr></thead>";
    const tb = el("tbody");
    for (const d of r.days) {
      const tr = el("tr");
      tr.append(el("td", "", d.label), el("td", "num", fmt(d.count)), el("td", "num", fmt(d.credits)));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);
  }

  body.appendChild(el("h2", "", "Einsätze"));
  if (!r.mine.length) {
    body.appendChild(el("p", "empty", "In diesem Zeitraum hat der Bot noch nichts alarmiert."));
  } else {
    const t = el("table");
    t.innerHTML = "<thead><tr><th>Alarmiert</th><th>Einsatz</th><th>Status</th><th>Credits</th></tr></thead>";
    const tb = el("tbody");
    for (const m of r.mine.slice(0, 200)) {
      const tr = el("tr");
      const name = el("td", "name", (m.planned ? "📅 " : "") + m.caption);
      name.title = m.vehicles ? "Geschickt: " + m.vehicles : "";
      tr.append(
        el("td", "when", time(m.sentAt)),
        name,
        el("td", "", ""),
        el("td", "num", m.credits != null ? fmt(m.credits) : m.expected ? `~${fmt(m.expected)}` : "–")
      );
      tr.children[2].appendChild(el("span", "pill " + (STATUS_CLASS[m.status] || ""), m.status));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);
    if (r.mine.length > 200) body.appendChild(el("p", "empty", `… und ${r.mine.length - 200} weitere`));
  }

  $("#sync").textContent =
    message || (data.meta.lastSync ? `Credits-Stand: ${ago(data.meta.lastSync)}` : "Credits noch nicht abgerufen");
}

// Offenen Spiel-Tab finden und dort die Credits-Übersicht lesen lassen
async function refresh() {
  const btn = $("#refresh");
  btn.disabled = true;
  await render("Lese Credits-Übersicht …");
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.leitstellenspiel.de/*" });
    let res = null;
    let lastError = null;
    for (const tab of tabs) {
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: "lssaa-sync" });
        if (res) break;
      } catch (e) {
        lastError = e; // Tab ohne Bot (z.B. Einsatzfenster) – nächsten versuchen
      }
    }
    if (!res) {
      await render(
        tabs.length
          ? "⚠ Der Bot ist im Spiel-Tab nicht geladen – Hauptseite des Leitstellenspiels mit F5 neu laden."
          : "⚠ Zum Abrufen der Credits muss die Hauptseite des Leitstellenspiels in einem Tab offen sein. Angezeigt wird der letzte Stand."
      );
      if (lastError) console.warn(lastError);
    } else if (res.error) {
      await render("⚠ " + res.error);
    } else {
      await render();
      if (res.added) $("#sync").textContent += ` · ${res.added} neue Buchungen`;
    }
  } finally {
    btn.disabled = false;
  }
}

$("#refresh").addEventListener("click", refresh);
$("#version").textContent = "v" + chrome.runtime.getManifest().version;
// Live mitlaufen, wenn der Bot neue Daten speichert
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.statsMissions || changes.statsCredits)) render();
});
refresh();
