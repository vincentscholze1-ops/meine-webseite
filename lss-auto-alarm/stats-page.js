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
  "wartet auf Credits": "wait"
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function table(head, rows) {
  const t = el("table");
  t.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const tb = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    for (const c of cells) tr.appendChild(c instanceof Node ? c : el("td", "", c));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return t;
}

async function render(message) {
  const data = await LssStats.load();
  const [, fromFn, toFn] = LssStats.PERIODS[period];
  const r = LssStats.evaluate(data, fromFn(), toFn ? toFn() : Infinity);
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

  // Kennzahlen
  const kpis = el("div", "kpis");
  const kpi = (icon, value, label, sub, cls) => {
    const k = el("div", "kpi " + (cls || ""));
    k.append(el("span", "ico", icon), el("b", "", value), el("span", "label", label));
    if (sub) k.appendChild(el("span", "sub", sub));
    kpis.appendChild(k);
  };
  kpi("💰", fmt(r.botCredits), "Credits erhalten", `für ${fmt(r.credited)} ${r.credited === 1 ? "Einsatz" : "Einsätze"} · Ø ${fmt(r.avg)}`, "money");
  kpi("📤", fmt(r.sent), "vom Bot alarmiert", "Einsätze im Zeitraum");
  kpi(
    "✅",
    r.quote == null ? "–" : r.quote + " %",
    "Erfolgsquote",
    r.finished ? `${fmt(r.successOfSent)} von ${fmt(r.finished)} beendeten mit Credits` : "noch kein Einsatz beendet",
    "ok"
  );
  kpi("⏳", fmt(r.running + r.waiting), "laufen noch", `${fmt(r.waiting)} warten auf die Gutschrift`);
  body.appendChild(kpis);

  const states = el("div", "states");
  states.append(
    el("span", "pill ok", `✓ ${r.successOfSent} erfolgreich`),
    el("span", "pill bad", `✖ ${r.without} ohne Credits`),
    el("span", "pill bad", `⊘ ${r.cancelled} abgebrochen`),
    el("span", "pill run", `▶ ${r.running} laufen`),
    el("span", "pill wait", `… ${r.waiting} warten auf Gutschrift`)
  );
  body.appendChild(states);

  const note = el("div", "note");
  note.innerHTML =
    `<div><b>Alle Verbandseinsätze mit deiner Beteiligung</b> laut Credits-Übersicht: ` +
    `<b>${fmt(r.allianceCount)}</b> Einsätze · <b>${fmt(r.allianceCredits)}</b> Credits</div>` +
    `<div class="muted">davon vom Bot: ${fmt(r.allianceCount - r.manualCount)} · ohne Bot (z.B. von Hand): ${fmt(r.manualCount)} Einsätze, ${fmt(r.manualCredits)} Credits` +
    (r.eventCredits ? ` · Verbands-Event-Belohnungen: ${fmt(r.eventCredits)} Credits` : "") +
    `</div>`;
  body.appendChild(note);

  if (r.days.length > 1) {
    body.appendChild(el("h2", "", "Credits pro Tag (vom Bot)"));
    body.appendChild(
      table(
        ["Tag", "Einsätze", "Credits"],
        r.days.map((d) => [d.label, el("td", "num", fmt(d.count)), el("td", "num", fmt(d.credits))])
      )
    );
  }

  body.appendChild(el("h2", "", "Einsätze"));
  if (!r.mine.length) {
    body.appendChild(el("p", "empty", "In diesem Zeitraum hat der Bot noch nichts alarmiert."));
  } else {
    body.appendChild(
      table(
        ["Alarmiert", "Einsatz", "Beendet", "Status", "Credits"],
        r.mine.slice(0, 300).map((m) => {
          const name = el("td", "name", (m.planned ? "📅 " : "") + m.caption + (m.dispatches > 1 ? ` (${m.dispatches}× alarmiert)` : ""));
          name.title = m.vehicles ? "Geschickt: " + m.vehicles : "";
          const st = el("td");
          st.appendChild(el("span", "pill " + (STATUS_CLASS[m.status] || ""), m.status));
          const cr = el("td", "num", m.credits != null ? fmt(m.credits) : "–");
          if (m.credits == null && m.expected) cr.title = `erwartet ca. ${fmt(m.expected)} Credits`;
          return [el("td", "when", time(m.sentAt)), name, el("td", "when", m.endedAt ? time(m.endedAt) : "–"), st, cr];
        })
      )
    );
    if (r.mine.length > 300) body.appendChild(el("p", "empty", `… und ${r.mine.length - 300} weitere`));
  }

  // Prüfbereich: woher die Zahlen kommen
  const check = el("details", "check");
  check.innerHTML = `<summary>🔎 Zahlen nachprüfen</summary>`;
  const info = el("div", "muted");
  info.textContent =
    `${fmt(r.creditCount)} Buchungen aus der Credits-Übersicht gespeichert` +
    (r.coverageFrom ? ` (seit ${time(r.coverageFrom)})` : "") +
    (data.meta.lastSync ? ` · zuletzt gelesen ${ago(data.meta.lastSync)}` : "") +
    ". Ältere Zeiträume können nur ausgewertet werden, soweit Buchungen gespeichert sind.";
  check.appendChild(info);
  check.appendChild(el("h3", "", "Verbands-Buchungen ohne Bot-Einsatz in diesem Zeitraum"));
  check.appendChild(
    r.unclaimed.length
      ? table(
          ["Gebucht", "Beschreibung", "Credits"],
          r.unclaimed.map((c) => [el("td", "when", time(c.at)), el("td", "name", c.desc), el("td", "num", fmt(c.amount))])
        )
      : el("p", "empty", "Keine – alle Verbands-Buchungen gehören zu Bot-Einsätzen.")
  );
  const tools = el("div", "tools");
  const rematch = el("button", "btn", "Zuordnung neu berechnen");
  rematch.addEventListener("click", async () => {
    await LssStats.rematch();
    render("Zuordnung neu berechnet.");
  });
  const reset = el("button", "btn danger", "Auswertung zurücksetzen");
  reset.addEventListener("click", async () => {
    if (!confirm("Alle gespeicherten Auswertungsdaten löschen? (Der Bot läuft normal weiter.)")) return;
    await LssStats.reset();
    render("Auswertung zurückgesetzt.");
  });
  tools.append(rematch, reset);
  check.appendChild(tools);
  body.appendChild(check);

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
    for (const tab of tabs) {
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: "lssaa-sync" });
        if (res) break;
      } catch (e) {
        // Tab ohne Bot (z.B. Einsatzfenster) – nächsten versuchen
      }
    }
    if (!res) {
      await render(
        tabs.length
          ? "⚠ Der Bot ist im Spiel-Tab nicht geladen – Hauptseite des Leitstellenspiels mit F5 neu laden."
          : "⚠ Zum Abrufen der Credits muss die Hauptseite des Leitstellenspiels in einem Tab offen sein. Angezeigt wird der letzte Stand."
      );
    } else if (res.error) {
      await render("⚠ " + res.error);
    } else {
      await render(`Credits-Stand: gerade eben${res.added ? ` · ${res.added} neue Buchungen` : ""}`);
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
