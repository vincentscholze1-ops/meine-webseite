// Auswertung (Daten): Welche vom Bot alarmierten Einsätze wurden abgeschlossen, und wie viele Credits
// hat das Spiel dafür tatsächlich gutgeschrieben?
//
// Grundlage ist die Credits-Übersicht des Spiels (/credits). Jede Zeile dort hat Betrag,
// Beschreibung und Zeitpunkt; Verbandseinsätze heißen "[Verband] <Einsatzname>".
//
// Ablauf:
//  1. Der Bot meldet jede Alarmierung (recordDispatch).
//  2. Solange die Spielseite offen ist, wird laufend beobachtet, ob der Einsatz noch in der Liste steht
//     (observe). Verschwindet er, ist er beendet – der Zeitpunkt ist auf Sekunden genau, auch wenn der
//     Bot gerade gestoppt ist.
//  3. Kurz danach wird die Credits-Übersicht gelesen und die Buchung zugeordnet: gleicher Einsatzname,
//     gebucht zwischen "zuletzt noch gesehen" und kurz nach dem Ende. Laufende Einsätze bekommen nie
//     eine Buchung – sonst würden sie Gutschriften anderer Einsätze gleichen Namens übernehmen.
//
// Läuft im Spiel-Tab (Abruf von /credits braucht die Spiel-Anmeldung); die Anzeige übernimmt
// die eigene Seite stats.html (stats-page.js), die nur liest.
const LssStats = (() => {
  const KEEP_DAYS = 60;
  const BEFORE_LAST_SEEN_MS = 3 * 60 * 1000; // Buchung darf kurz vor "zuletzt gesehen" liegen (Uhren, Verzögerung)
  const AFTER_END_MS = 20 * 60 * 1000; // ... und bis 20 min nach dem erkannten Ende
  const GIVE_UP_MS = 45 * 60 * 1000; // danach ohne Buchung: "ohne Credits"
  const SEEN_WRITE_MS = 60 * 1000; // "zuletzt gesehen" höchstens einmal pro Minute speichern
  const MAX_PAGES = 60;

  let syncing = null;
  let syncTimer = null;
  // Schreibzugriffe nacheinander ausführen, damit sich Bot, Beobachtung und Abgleich nicht überschreiben
  let chain = Promise.resolve();
  const exclusive = (fn) => (chain = chain.then(fn, fn));
  const inGameTab = typeof location !== "undefined" && location.hostname === "www.leitstellenspiel.de";

  // ---------- Speicher ----------

  async function load() {
    const s = await chrome.storage.local.get(["statsMissions", "statsCredits", "statsMeta"]);
    return { missions: s.statsMissions || {}, credits: s.statsCredits || [], meta: s.statsMeta || {} };
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
      const now = Date.now();
      const old = data.missions[mission.id];
      if (old && !old.endedAt) {
        // Derselbe Einsatz wurde erneut alarmiert: Eintrag behalten, nur mitzählen
        old.dispatches = (old.dispatches || 1) + 1;
        old.vehicles = [old.vehicles, vehicles].filter(Boolean).join(" + ");
        old.lastSeenAt = now;
      } else {
        data.missions[mission.id] = {
          id: mission.id,
          caption: mission.caption,
          planned: !!mission.planned,
          expected: mission.credits ?? null,
          vehicles,
          dispatches: 1,
          sentAt: now,
          lastSeenAt: now,
          endedAt: null,
          endedPrecise: false,
          status: "läuft",
          credits: null,
          creditKey: null,
          creditAt: null
        };
      }
      await store(data);
    });
  }

  // Abgleich mit den Einsätzen, die gerade auf der Seite stehen (laufend aufgerufen)
  function observe(currentIds) {
    return exclusive(async () => {
      const data = await load();
      const now = Date.now();
      let changed = false;
      let ended = 0;
      for (const m of Object.values(data.missions)) {
        if (m.endedAt) continue;
        if (currentIds.has(m.id)) {
          if (now - (m.lastSeenAt || 0) > SEEN_WRITE_MS) {
            m.lastSeenAt = now;
            changed = true;
          }
        } else {
          m.endedAt = now;
          // Genau, wenn der Einsatz vor kurzem noch zu sehen war; sonst war die Seite zwischendurch zu
          m.endedPrecise = now - (m.lastSeenAt || m.sentAt) < SEEN_WRITE_MS + 2 * 60 * 1000;
          if (m.status === "läuft") m.status = "wartet auf Credits";
          changed = true;
          ended++;
        }
      }
      if (changed) await store(data);
      // Gutschrift erscheint mit dem Einsatzende – kurz danach die Credits-Übersicht lesen
      if (ended && inGameTab) scheduleSync(45 * 1000);
      return ended;
    });
  }

  // ---------- Credits-Übersicht lesen ----------

  function parseAmount(text) {
    const m = text
      .replace(/\./g, "")
      .replace(/\s/g, "")
      .match(/[-−+]?\d+/);
    return m ? parseInt(m[0].replace("−", "-").replace("+", ""), 10) : null;
  }

  const DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  function parseTime(cell) {
    const attr = cell.getAttribute("data-logged-at") || cell.getAttribute("datetime") || "";
    if (attr) {
      const t = Date.parse(attr.replace(" ", "T").replace(/ ?([+-]\d{2}):?(\d{2})$/, "$1:$2"));
      if (!Number.isNaN(t)) return t;
      const t2 = Date.parse(attr);
      if (!Number.isNaN(t2)) return t2;
    }
    const text = (attr + " " + cell.textContent).trim();
    const m = text.match(DATE_RE);
    if (m) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return new Date(year, m[2] - 1, m[1], m[4], m[5], m[6] || 0).getTime();
    }
    const rel = text.match(/(Heute|Gestern)\D+(\d{1,2}):(\d{2})/i);
    if (rel) {
      const d = new Date();
      if (/gestern/i.test(rel[1])) d.setDate(d.getDate() - 1);
      d.setHours(Number(rel[2]), Number(rel[3]), 0, 0);
      return d.getTime();
    }
    return null;
  }

  async function fetchCreditsPage(page) {
    const res = await fetch(`/credits?page=${page}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Credits-Übersicht: HTTP ${res.status}`);
    if (/sign_in/.test(res.url)) throw new Error("Nicht eingeloggt");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const entries = [];
    const seen = new Map();
    for (const tr of doc.querySelectorAll("table tbody tr")) {
      const cells = tr.children;
      if (cells.length < 3) continue;
      const amount = parseAmount(cells[0].textContent);
      const desc = cells[1].textContent.replace(/\s+/g, " ").trim();
      const at = parseTime(cells[2]);
      if (amount === null || !at || !desc) continue;
      // Gleiche Buchung (Zeit, Betrag, Text) mehrfach in derselben Sekunde: durchnummerieren
      const base = `${at}|${amount}|${desc}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      entries.push({ key: n > 1 ? `${base}#${n}` : base, amount, desc, at });
    }
    return entries;
  }

  // Neue Buchungen holen: ab Seite 1, bis bekannte oder zu alte Buchungen kommen
  async function fetchNewCredits(knownKeys, oldestNeeded) {
    const added = [];
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const entries = await fetchCreditsPage(page);
      pages++;
      if (!entries.length) break;
      let reachedKnown = false;
      for (const e of entries) {
        if (knownKeys.has(e.key)) reachedKnown = true;
        else {
          knownKeys.add(e.key);
          added.push(e);
        }
      }
      if (reachedKnown || Math.min(...entries.map((e) => e.at)) < oldestNeeded) break;
      await new Promise((r) => setTimeout(r, 400)); // Server schonen
    }
    return { added, pages };
  }

  // ---------- Zuordnung Buchung <-> Einsatz ----------

  const norm = (t) =>
    String(t || "")
      .toLowerCase()
      .replace(/^\s*\[verband\]\s*/, "")
      .replace(/\s+-\s+(abgebrochen|fehlalarm)\s*$/, "")
      .replace(/\(brandmeldeanlage\)/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  // Gleicher Einsatz? Ein Name enthält den anderen (Buchungen tragen manchmal Zusätze)
  function sameName(missionName, creditDesc) {
    const a = norm(missionName);
    const b = norm(creditDesc);
    if (a.length < 3 || b.length < 3) return false;
    return a === b || a.startsWith(b) || b.startsWith(a) || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b));
  }

  const isAlliance = (c) => /^\s*\[Verband\]/i.test(c.desc);
  const isEvent = (c) => /Belohnung für das Verbands-Event/i.test(c.desc);
  const isCancelled = (c) => /abgebrochen\s*$/i.test(c.desc);

  function match(data) {
    const now = Date.now();
    const used = new Set(
      Object.values(data.missions)
        .map((m) => m.creditKey)
        .filter(Boolean)
    );
    // Nur beendete Einsätze, früh beendete zuerst
    const open = Object.values(data.missions)
      .filter((m) => m.endedAt && !m.creditKey)
      .sort((a, b) => a.endedAt - b.endedAt);
    for (const m of open) {
      const lo = Math.max(m.sentAt, (m.lastSeenAt || m.sentAt) - BEFORE_LAST_SEEN_MS);
      const hi = m.endedAt + AFTER_END_MS;
      const candidates = data.credits.filter(
        (c) => !used.has(c.key) && c.at >= lo && c.at <= hi && sameName(m.caption, c.desc)
      );
      // Genau erkanntes Ende: Buchung, die am nächsten am Ende liegt; sonst die früheste im Zeitfenster
      candidates.sort((a, b) =>
        m.endedPrecise ? Math.abs(a.at - m.endedAt) - Math.abs(b.at - m.endedAt) : a.at - b.at
      );
      const hit = candidates[0];
      if (hit) {
        used.add(hit.key);
        m.creditKey = hit.key;
        m.credits = hit.amount;
        m.creditAt = hit.at;
        m.status = isCancelled(hit) ? "abgebrochen" : hit.amount > 0 ? "erfolgreich" : "ohne Credits";
      } else if (now - m.endedAt > GIVE_UP_MS) {
        m.status = "ohne Credits";
      }
    }
  }

  // Alle Zuordnungen verwerfen und neu berechnen (z.B. nach einem Update)
  function rematch() {
    return exclusive(async () => {
      const data = await load();
      for (const m of Object.values(data.missions)) {
        m.creditKey = null;
        m.credits = null;
        m.creditAt = null;
        m.status = m.endedAt ? "wartet auf Credits" : "läuft";
      }
      match(data);
      await store(data);
    });
  }

  // Einmalig nach dem Update: alte (fehlerhafte) Zuordnungen verwerfen und neu berechnen
  const SCHEMA = 2;
  function migrate() {
    return exclusive(async () => {
      const data = await load();
      if (data.meta.schema === SCHEMA) return false;
      for (const m of Object.values(data.missions)) {
        m.creditKey = null;
        m.credits = null;
        m.creditAt = null;
        m.status = m.endedAt ? "wartet auf Credits" : "läuft";
        m.dispatches = m.dispatches || 1;
      }
      match(data);
      data.meta.schema = SCHEMA;
      await store(data);
      return true;
    });
  }

  function reset() {
    return exclusive(() => chrome.storage.local.remove(["statsMissions", "statsCredits", "statsMeta"]));
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      // Abrufen außerhalb der Sperre (dauert), Zusammenführen innerhalb
      const snapshot = await load();
      const oldestNeeded = Math.min(
        Date.now() - 7 * 86400000,
        ...Object.values(snapshot.missions).map((m) => m.sentAt)
      );
      const { added, pages } = await fetchNewCredits(new Set(snapshot.credits.map((c) => c.key)), oldestNeeded);
      return exclusive(async () => {
        const data = await load();
        const known = new Set(data.credits.map((c) => c.key));
        data.credits = [...added.filter((c) => !known.has(c.key)), ...data.credits].sort((a, b) => b.at - a.at);
        match(data);
        data.meta.lastSync = Date.now();
        data.meta.lastPages = pages;
        await store(data);
        return added.length;
      });
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().catch((e) => console.warn("[LSS Verbands-Bot] Credits", e)), delay);
  }

  // Regelmäßig aufgerufen: abfragen, solange noch Gutschriften erwartet werden
  async function maybeSync() {
    const data = await load();
    const waiting = Object.values(data.missions).some((m) => m.status === "wartet auf Credits");
    const stale = !data.meta.lastSync || Date.now() - data.meta.lastSync > 5 * 60 * 1000;
    if (waiting && stale) await sync();
  }

  // ---------- Auswertung berechnen ----------

  const PERIODS = {
    today: ["Heute", () => new Date().setHours(0, 0, 0, 0)],
    yesterday: ["Gestern", () => new Date().setHours(0, 0, 0, 0) - 86400000, () => new Date().setHours(0, 0, 0, 0)],
    week: ["7 Tage", () => Date.now() - 7 * 86400000],
    month: ["30 Tage", () => Date.now() - 30 * 86400000],
    all: ["Alles", () => 0]
  };

  // Zeitraum [from, to): Alarmierungen zählen nach Alarmierungszeit, Credits nach Gutschriftzeit
  function evaluate(data, from, to = Infinity) {
    const inRange = (t) => t >= from && t < to;
    const all = Object.values(data.missions);
    const mine = all.filter((m) => inRange(m.sentAt)).sort((a, b) => b.sentAt - a.sentAt);
    const finished = mine.filter((m) => ["erfolgreich", "ohne Credits", "abgebrochen"].includes(m.status));
    const successSent = finished.filter((m) => m.status === "erfolgreich");
    const credited = all.filter((m) => m.status === "erfolgreich" && m.creditAt && inRange(m.creditAt));
    const botCredits = credited.reduce((sum, m) => sum + m.credits, 0);
    const claimed = new Set(all.map((m) => m.creditKey).filter(Boolean));
    const allianceAll = data.credits.filter((c) => inRange(c.at) && isAlliance(c) && c.amount > 0 && !isCancelled(c));
    const events = data.credits.filter((c) => inRange(c.at) && isEvent(c));
    const oldestCredit = data.credits.length ? data.credits[data.credits.length - 1].at : null;
    return {
      mine,
      sent: mine.length,
      finished: finished.length,
      successOfSent: successSent.length,
      quote: finished.length ? Math.round((successSent.length / finished.length) * 100) : null,
      credited: credited.length,
      botCredits,
      avg: credited.length ? Math.round(botCredits / credited.length) : 0,
      running: mine.filter((m) => m.status === "läuft").length,
      waiting: mine.filter((m) => m.status === "wartet auf Credits").length,
      without: mine.filter((m) => m.status === "ohne Credits").length,
      cancelled: mine.filter((m) => m.status === "abgebrochen").length,
      allianceCount: allianceAll.length,
      allianceCredits: allianceAll.reduce((s, c) => s + c.amount, 0),
      manualCount: allianceAll.filter((c) => !claimed.has(c.key)).length,
      manualCredits: allianceAll.filter((c) => !claimed.has(c.key)).reduce((s, c) => s + c.amount, 0),
      eventCredits: events.reduce((s, c) => s + c.amount, 0),
      unclaimed: allianceAll.filter((c) => !claimed.has(c.key)).slice(0, 50),
      coverageFrom: oldestCredit,
      creditCount: data.credits.length,
      days: perDay(credited)
    };
  }

  function perDay(credited) {
    const days = new Map();
    for (const m of credited) {
      const d = new Date(m.creditAt);
      const t = new Date(d).setHours(0, 0, 0, 0);
      const e = days.get(t) || {
        label: d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }),
        count: 0,
        credits: 0,
        t
      };
      e.count++;
      e.credits += m.credits;
      days.set(t, e);
    }
    return [...days.values()].sort((a, b) => b.t - a.t);
  }

  return { load, recordDispatch, observe, sync, maybeSync, rematch, migrate, reset, evaluate, PERIODS, _test: { sameName, parseTime, match } };
})();
