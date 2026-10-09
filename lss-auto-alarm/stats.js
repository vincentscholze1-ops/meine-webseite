// Auswertung: Welche vom Bot alarmierten Einsätze wurden abgeschlossen, und wie viele Credits
// hat das Spiel dafür tatsächlich gutgeschrieben?
//
// Grundlage ist die Credits-Übersicht des Spiels (/credits). Jede Zeile dort hat Betrag,
// Beschreibung und Zeitpunkt; Verbandseinsätze heißen "[Verband] <Einsatzname>".
// Die Buchungen werden zwischengespeichert und den alarmierten Einsätzen über Name und
// Zeitraum zugeordnet.
const LssStats = (() => {
  const KEEP_DAYS = 60;
  const MATCH_AFTER_END_MS = 20 * 60 * 1000; // Buchung darf bis 20 min nach Verschwinden kommen
  const GIVE_UP_MS = 45 * 60 * 1000; // danach gilt der Einsatz als "ohne Credits"
  const MAX_PAGES = 40;

  let syncing = null;
  // Schreibzugriffe nacheinander ausführen, damit sich Bot und Abgleich nicht überschreiben
  let chain = Promise.resolve();
  const exclusive = (fn) => (chain = chain.then(fn, fn));
  let modal = null;
  let period = "today";

  // ---------- Speicher ----------

  async function load() {
    const s = await chrome.storage.local.get(["statsMissions", "statsCredits", "statsMeta"]);
    return {
      missions: s.statsMissions || {},
      credits: s.statsCredits || [],
      meta: s.statsMeta || {}
    };
  }

  async function store(data) {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const [id, m] of Object.entries(data.missions)) if (m.sentAt < cutoff) delete data.missions[id];
    data.credits = data.credits.filter((c) => c.at >= cutoff);
    await chrome.storage.local.set({ statsMissions: data.missions, statsCredits: data.credits, statsMeta: data.meta });
  }

  // ---------- Aufzeichnung durch den Bot ----------

  function recordDispatch(mission, vehicles) {
    return exclusive(async () => {
      const data = await load();
      data.missions[mission.id] = {
        id: mission.id,
        caption: mission.caption,
        planned: !!mission.planned,
        expected: mission.credits ?? null,
        vehicles,
        sentAt: Date.now(),
        endedAt: null,
        status: "läuft",
        credits: null,
        creditKey: null
      };
      await store(data);
    });
  }

  // Einsätze, die aus der Liste verschwunden sind, gelten als beendet
  function markEnded(currentIds) {
    return exclusive(async () => {
      const data = await load();
      let changed = false;
      for (const m of Object.values(data.missions)) {
        if (!m.endedAt && !currentIds.has(m.id)) {
          m.endedAt = Date.now();
          if (m.status === "läuft") m.status = "wartet auf Credits";
          changed = true;
        }
      }
      if (changed) await store(data);
      return changed;
    });
  }

  // ---------- Credits-Übersicht lesen ----------

  function parseAmount(text) {
    const m = text
      .replace(/\./g, "")
      .replace(/\s/g, "")
      .match(/[-−]?\d+/);
    return m ? parseInt(m[0].replace("−", "-"), 10) : null;
  }

  function parseTime(cell) {
    const attr = cell.getAttribute("data-logged-at");
    if (attr) {
      const t = Date.parse(attr);
      if (!Number.isNaN(t)) return t;
    }
    const m = cell.textContent.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})\D+(\d{1,2}):(\d{2})/);
    if (m) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return new Date(year, m[2] - 1, m[1], m[4], m[5]).getTime();
    }
    return null;
  }

  async function fetchCreditsPage(page) {
    const res = await fetch(`/credits?page=${page}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Credits-Übersicht: HTTP ${res.status}`);
    if (/sign_in/.test(res.url)) throw new Error("Nicht eingeloggt");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const entries = [];
    for (const tr of doc.querySelectorAll("table tbody tr")) {
      const cells = tr.children;
      if (cells.length < 3) continue;
      const amount = parseAmount(cells[0].textContent);
      const desc = cells[1].textContent.replace(/\s+/g, " ").trim();
      const at = parseTime(cells[2]);
      if (amount === null || !at) continue;
      entries.push({ key: `${at}|${amount}|${desc}`, amount, desc, at });
    }
    return entries;
  }

  // Neue Buchungen holen: ab Seite 1, bis bekannte oder zu alte Buchungen kommen
  async function fetchNewCredits(data) {
    const known = new Set(data.credits.map((c) => c.key));
    const oldestNeeded = Math.min(Date.now() - 7 * 86400000, ...Object.values(data.missions).map((m) => m.sentAt));
    const added = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const entries = await fetchCreditsPage(page);
      if (!entries.length) break;
      let reachedKnown = false;
      for (const e of entries) {
        if (known.has(e.key)) reachedKnown = true;
        else {
          known.add(e.key);
          added.push(e);
        }
      }
      const oldest = Math.min(...entries.map((e) => e.at));
      if (reachedKnown || oldest < oldestNeeded) break;
      await new Promise((r) => setTimeout(r, 400)); // Server schonen
    }
    data.credits = [...added, ...data.credits].sort((a, b) => b.at - a.at);
    return added.length;
  }

  // ---------- Zuordnung Buchung <-> Einsatz ----------

  const norm = (t) =>
    t
      .toLowerCase()
      .replace(/^\s*\[verband\]\s*/, "")
      .replace(/\s+-\s+(abgebrochen|fehlalarm)\s*$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const isAlliance = (c) => /^\s*\[Verband\]/i.test(c.desc);
  const isEvent = (c) => /Belohnung für das Verbands-Event/i.test(c.desc);

  function match(data) {
    const used = new Set(
      Object.values(data.missions)
        .map((m) => m.creditKey)
        .filter(Boolean)
    );
    const now = Date.now();
    const open = Object.values(data.missions)
      .filter((m) => !m.creditKey)
      .sort((a, b) => a.sentAt - b.sentAt);
    for (const m of open) {
      const name = norm(m.caption);
      const until = (m.endedAt || now) + MATCH_AFTER_END_MS;
      const hit = data.credits
        .filter((c) => !used.has(c.key) && c.at >= m.sentAt - 60000 && c.at <= until)
        .filter((c) => {
          const d = norm(c.desc);
          return d && name && (d.startsWith(name) || name.startsWith(d));
        })
        .sort((a, b) => a.at - b.at)[0];
      if (hit) {
        used.add(hit.key);
        m.creditKey = hit.key;
        m.credits = hit.amount;
        m.creditAt = hit.at;
        m.status = /abgebrochen\s*$/i.test(hit.desc) ? "abgebrochen" : hit.amount > 0 ? "erfolgreich" : "ohne Credits";
      } else if (m.endedAt && now - m.endedAt > GIVE_UP_MS) {
        m.status = "ohne Credits";
      }
    }
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      // Abrufen außerhalb der Sperre (dauert), Zusammenführen innerhalb
      const snapshot = await load();
      const before = new Set(snapshot.credits.map((c) => c.key));
      const added = await fetchNewCredits(snapshot);
      const fresh = snapshot.credits.filter((c) => !before.has(c.key));
      return exclusive(async () => {
        const data = await load();
        const known = new Set(data.credits.map((c) => c.key));
        data.credits = [...fresh.filter((c) => !known.has(c.key)), ...data.credits].sort((a, b) => b.at - a.at);
        match(data);
        data.meta.lastSync = Date.now();
        await store(data);
        return added;
      });
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }

  // Vom Bot regelmäßig aufgerufen: nur abfragen, wenn noch Credits erwartet werden
  async function maybeSync() {
    const data = await load();
    const waiting = Object.values(data.missions).some((m) => m.status === "wartet auf Credits");
    const stale = !data.meta.lastSync || Date.now() - data.meta.lastSync > 10 * 60 * 1000;
    if (waiting && stale) await sync();
  }

  // ---------- Auswertung berechnen ----------

  const PERIODS = {
    today: ["Heute", () => new Date().setHours(0, 0, 0, 0)],
    week: ["7 Tage", () => Date.now() - 7 * 86400000],
    month: ["30 Tage", () => Date.now() - 30 * 86400000],
    all: ["Alles", () => 0]
  };

  function evaluate(data, from) {
    const mine = Object.values(data.missions)
      .filter((m) => m.sentAt >= from)
      .sort((a, b) => b.sentAt - a.sentAt);
    const by = (st) => mine.filter((m) => m.status === st);
    const success = by("erfolgreich");
    const botCredits = success.reduce((sum, m) => sum + m.credits, 0);
    const allianceAll = data.credits.filter((c) => c.at >= from && isAlliance(c) && c.amount > 0);
    const events = data.credits.filter((c) => c.at >= from && isEvent(c));
    return {
      mine,
      sent: mine.length,
      success: success.length,
      running: mine.filter((m) => m.status === "läuft" || m.status === "wartet auf Credits").length,
      without: by("ohne Credits").length,
      cancelled: by("abgebrochen").length,
      botCredits,
      avg: success.length ? Math.round(botCredits / success.length) : 0,
      allianceCount: allianceAll.length,
      allianceCredits: allianceAll.reduce((s, c) => s + c.amount, 0),
      eventCredits: events.reduce((s, c) => s + c.amount, 0),
      days: perDay(success, from)
    };
  }

  function perDay(success, from) {
    const days = new Map();
    for (const m of success) {
      const d = new Date(m.creditAt || m.sentAt);
      const key = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
      const e = days.get(key) || { label: key, count: 0, credits: 0, t: d.setHours(0, 0, 0, 0) };
      e.count++;
      e.credits += m.credits;
      days.set(key, e);
    }
    return [...days.values()].filter((d) => d.t >= new Date(from).setHours(0, 0, 0, 0)).sort((a, b) => b.t - a.t);
  }

  // ---------- Fenster ----------

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
    if (!modal) return;
    const data = await load();
    const r = evaluate(data, PERIODS[period][1]());
    const body = modal.querySelector(".lssst-content");
    body.replaceChildren();

    const tabs = el("div", "lssst-tabs");
    for (const [key, [label]] of Object.entries(PERIODS)) {
      const b = el("button", key === period ? "on" : "", label);
      b.type = "button";
      b.addEventListener("click", () => {
        period = key;
        render();
      });
      tabs.appendChild(b);
    }
    body.appendChild(tabs);

    const kpis = el("div", "lssst-kpis");
    const kpi = (value, label, cls) => {
      const k = el("div", "lssst-kpi " + (cls || ""));
      k.append(el("b", "", value), el("span", "", label));
      kpis.appendChild(k);
    };
    kpi(fmt(r.sent), "vom Bot alarmiert");
    kpi(
      fmt(r.success),
      `erfolgreich abgeschlossen${r.sent ? ` (${Math.round((r.success / r.sent) * 100)} %)` : ""}`,
      "ok"
    );
    kpi(fmt(r.botCredits), "Credits erhalten", "money");
    kpi(fmt(r.avg), "Ø Credits je Einsatz");
    body.appendChild(kpis);

    const states = el("div", "lssst-states");
    states.append(
      el("span", "run", `⏳ ${r.running} laufen noch / warten auf Credits`),
      el("span", "bad", `✖ ${r.without} ohne Credits`),
      el("span", "bad", `⊘ ${r.cancelled} abgebrochen`)
    );
    body.appendChild(states);

    const all = el("div", "lssst-note");
    all.innerHTML =
      `<b>Alle Verbandseinsätze mit deiner Beteiligung</b> laut Credits-Übersicht (auch von Hand alarmierte): ` +
      `<b>${fmt(r.allianceCount)}</b> Einsätze, <b>${fmt(r.allianceCredits)}</b> Credits` +
      (r.eventCredits ? ` · Verbands-Event-Belohnungen: <b>${fmt(r.eventCredits)}</b> Credits` : "");
    body.appendChild(all);

    if (r.days.length > 1) {
      body.appendChild(el("h4", "", "Pro Tag (vom Bot)"));
      const t = el("table", "lssst-table");
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

    body.appendChild(el("h4", "", "Einsätze"));
    if (!r.mine.length) {
      body.appendChild(el("p", "lssst-empty", "In diesem Zeitraum hat der Bot noch nichts alarmiert."));
    } else {
      const t = el("table", "lssst-table");
      t.innerHTML = "<thead><tr><th>Alarmiert</th><th>Einsatz</th><th>Status</th><th>Credits</th></tr></thead>";
      const tb = el("tbody");
      for (const m of r.mine.slice(0, 100)) {
        const tr = el("tr");
        const name = el("td", "name", (m.planned ? "📅 " : "") + m.caption);
        name.title = m.vehicles ? "Geschickt: " + m.vehicles : "";
        tr.append(
          el("td", "", time(m.sentAt)),
          name,
          el("td", "", ""),
          el("td", "num", m.credits != null ? fmt(m.credits) : m.expected ? `~${fmt(m.expected)}` : "–")
        );
        tr.children[2].appendChild(el("span", "lssst-pill " + (STATUS_CLASS[m.status] || ""), m.status));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      body.appendChild(t);
      if (r.mine.length > 100) body.appendChild(el("p", "lssst-empty", `… und ${r.mine.length - 100} weitere`));
    }

    modal.querySelector(".lssst-sync").textContent =
      message || (data.meta.lastSync ? `Credits-Stand: ${ago(data.meta.lastSync)}` : "Credits noch nicht abgefragt");
  }

  async function refresh() {
    const btn = modal && modal.querySelector(".lssst-refresh");
    if (btn) btn.disabled = true;
    render("Lese Credits-Übersicht …");
    try {
      const added = await sync();
      await render();
      if (added) modal.querySelector(".lssst-sync").textContent += ` · ${added} neue Buchungen`;
    } catch (e) {
      render("⚠ " + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function open() {
    if (modal) return refresh();
    modal = el("div");
    modal.id = "lss-verbands-bot-stats";
    modal.innerHTML = `
      <div class="lssst-backdrop"></div>
      <div class="lssst-window" role="dialog" aria-label="Auswertung">
        <div class="lssst-head">
          <span>📊</span><strong>Auswertung Verbands-Bot</strong>
          <span class="lssst-spacer"></span>
          <button type="button" class="lssst-refresh">⟳ Credits abrufen</button>
          <button type="button" class="lssst-close" title="Schließen">✕</button>
        </div>
        <div class="lssst-sync"></div>
        <div class="lssst-content"></div>
        <div class="lssst-foot">„Erfolgreich“ heißt: Für den Einsatz ist in deiner Credits-Übersicht eine Gutschrift eingegangen.
          Die Zuordnung erfolgt über Einsatzname und Zeitraum.</div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => {
      modal.remove();
      modal = null;
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    modal.querySelector(".lssst-close").addEventListener("click", close);
    modal.querySelector(".lssst-backdrop").addEventListener("click", close);
    modal.querySelector(".lssst-refresh").addEventListener("click", refresh);
    refresh();
  }

  return { recordDispatch, markEnded, sync, maybeSync, open };
})();
