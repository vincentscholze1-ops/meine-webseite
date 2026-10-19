// Auswertung (Daten): Welche vom Bot alarmierten Einsätze wurden abgeschlossen, und wie viele Credits
// hat das Spiel dafür tatsächlich gutgeschrieben?
//
// Grundlage ist die Credits-Übersicht des Spiels (/credits). Jede Zeile dort hat Betrag,
// Beschreibung und Zeitpunkt; Verbandseinsätze heißen "[Verband] <Einsatzname>".
//
// Ablauf:
//  1. Der Bot meldet jede Alarmierung (recordDispatch).
//  2. Solange die Spielseite offen ist, wird laufend beobachtet, ob der Einsatz noch in der Liste steht
//     (observe). Verschwindet er, ist er beendet – auch wenn der Bot gerade gestoppt ist.
//  3. Danach wird die Credits-Übersicht gelesen und die Buchung zugeordnet: gleicher Einsatzname,
//     gebucht zwischen "zuletzt noch gesehen" und kurz nach dem Ende. Laufende Einsätze bekommen nie
//     eine Buchung – sonst würden sie Gutschriften anderer Einsätze gleichen Namens übernehmen.
//  4. Weichen die Zeitangaben der Credits-Übersicht um ganze Stunden ab (z.B. UTC statt Ortszeit),
//     wird der Versatz aus eindeutigen Paaren erkannt und ausgeglichen.
//
// Läuft im Spiel-Tab (Abruf von /credits braucht die Spiel-Anmeldung); die Anzeige übernimmt
// die eigene Seite stats.html (stats-page.js), die nur liest.
const LssStats = (() => {
  const KEEP_DAYS = 60;
  const BEFORE_LAST_SEEN_MS = 5 * 60 * 1000; // Buchung darf kurz vor "zuletzt gesehen" liegen
  const AFTER_END_MS = 30 * 60 * 1000; // ... und bis 30 min nach dem erkannten Ende
  const GIVE_UP_MS = 60 * 60 * 1000; // danach ohne Buchung: "ohne Credits"
  const SEEN_WRITE_MS = 60 * 1000; // "zuletzt gesehen" höchstens einmal pro Minute speichern
  const MAX_PAGES = 150;
  const OVERLAP_MS = 5 * 60 * 1000; // so weit hinter die neueste gespeicherte Buchung wird erneut gelesen

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
    for (const tr of doc.querySelectorAll("table tbody tr")) {
      const cells = tr.children;
      if (cells.length < 3) continue;
      const amount = parseAmount(cells[0].textContent);
      const desc = cells[1].textContent.replace(/\s+/g, " ").trim();
      const at = parseTime(cells[2]);
      if (amount === null || !at || !desc) continue;
      entries.push({ base: `${at}|${amount}|${desc}`, amount, desc, at });
    }
    return entries;
  }

  // Neue Buchungen lesen. Die Liste ist neueste-zuerst; gelesen wird bis kurz hinter die neueste
  // bereits gespeicherte Buchung (bzw. beim ersten Mal bis "oldestNeeded"). Doppelte Buchungen
  // (gleiche Zeit, Betrag, Text) werden gezählt statt über ihre Position erkannt – so verschieben
  // neue Buchungen zwischen zwei Abrufen nichts.
  async function fetchFrom(newestStored, oldestNeeded) {
    const stopAt = newestStored ? newestStored - OVERLAP_MS : oldestNeeded;
    const fetched = [];
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const entries = await fetchCreditsPage(page);
      pages++;
      if (!entries.length) break;
      fetched.push(...entries.filter((e) => e.at >= stopAt));
      if (Math.min(...entries.map((e) => e.at)) < stopAt) break;
      await new Promise((r) => setTimeout(r, 300)); // Server schonen
    }
    return { fetched, stopAt, pages };
  }

  function mergeCredits(stored, fetched, stopAt) {
    const have = new Map();
    for (const c of stored) if (c.at >= stopAt) have.set(c.base || c.key, (have.get(c.base || c.key) || 0) + 1);
    const seen = new Map();
    const added = [];
    for (const e of fetched) {
      const n = (seen.get(e.base) || 0) + 1;
      seen.set(e.base, n);
      if (n > (have.get(e.base) || 0)) {
        added.push({ key: n > 1 ? `${e.base}#${n}` : e.base, base: e.base, amount: e.amount, desc: e.desc, at: e.at });
      }
    }
    return added;
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

  // Zeitversatz zwischen Credits-Übersicht und Browser-Uhr erkennen (z.B. UTC statt Ortszeit):
  // Paare aus genau beobachtetem Einsatzende und der einzigen gleichnamigen Buchung im Umkreis von 14 h.
  function detectOffset(data) {
    const deltas = [];
    for (const m of Object.values(data.missions)) {
      if (!m.endedAt || !m.endedPrecise) continue;
      const near = data.credits.filter((c) => Math.abs(c.at - m.endedAt) < 14 * 3600000 && sameName(m.caption, c.desc));
      if (near.length === 1) deltas.push(near[0].at - m.endedAt);
    }
    if (deltas.length < 3) return { offset: data.meta.clockOffset || 0, samples: deltas.length };
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    // Nur ganze Viertelstunden ab 30 min ausgleichen – kleinere Abweichungen fängt das Zeitfenster ab
    const rounded = Math.round(median / 900000) * 900000;
    return { offset: Math.abs(rounded) >= 1800000 ? rounded : 0, samples: deltas.length };
  }

  function match(data) {
    const now = Date.now();
    const { offset, samples } = detectOffset(data);
    data.meta.clockOffset = offset;
    data.meta.offsetSamples = samples;
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
      const lo = Math.max(m.sentAt - 60000, (m.lastSeenAt || m.sentAt) - BEFORE_LAST_SEEN_MS);
      const hi = m.endedAt + AFTER_END_MS;
      const at = (c) => c.at - offset; // Buchungszeit auf Browser-Uhr umgerechnet
      const candidates = data.credits.filter((c) => !used.has(c.key) && at(c) >= lo && at(c) <= hi && sameName(m.caption, c.desc));
      // Genau erkanntes Ende: Buchung, die am nächsten am Ende liegt; sonst die früheste im Zeitfenster
      candidates.sort((a, b) =>
        m.endedPrecise ? Math.abs(at(a) - m.endedAt) - Math.abs(at(b) - m.endedAt) : at(a) - at(b)
      );
      const hit = candidates[0];
      if (hit) {
        used.add(hit.key);
        m.creditKey = hit.key;
        m.credits = hit.amount;
        m.creditAt = at(hit);
        m.status = isCancelled(hit) ? "abgebrochen" : hit.amount > 0 ? "erfolgreich" : "ohne Credits";
      } else if (now - m.endedAt > GIVE_UP_MS) {
        m.status = "ohne Credits";
      }
    }
  }

  function clearMatches(data) {
    for (const m of Object.values(data.missions)) {
      m.creditKey = null;
      m.credits = null;
      m.creditAt = null;
      m.status = m.endedAt ? "wartet auf Credits" : "läuft";
      m.dispatches = m.dispatches || 1;
    }
  }

  // Alle Zuordnungen verwerfen und neu berechnen (z.B. nach einem Update)
  function rematch() {
    return exclusive(async () => {
      const data = await load();
      clearMatches(data);
      match(data);
      await store(data);
    });
  }

  // Einmalig nach dem Update: alte Zuordnungen verwerfen und mit der neuen Logik neu berechnen
  const SCHEMA = 3;
  function migrate() {
    return exclusive(async () => {
      const data = await load();
      if (data.meta.schema === SCHEMA) return false;
      for (const c of data.credits) if (!c.base) c.base = c.key.replace(/#\d+$/, "");
      clearMatches(data);
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
      const newest = snapshot.credits.length ? Math.max(...snapshot.credits.map((c) => c.at)) : null;
      // Erstes Lesen: mindestens ab gestern 0 Uhr und ab der ältesten noch offenen Alarmierung
      const startYesterday = new Date().setHours(0, 0, 0, 0) - 86400000;
      const openSince = Object.values(snapshot.missions)
        .filter((m) => !m.creditKey)
        .map((m) => m.sentAt);
      const oldestNeeded = Math.min(startYesterday, ...openSince);
      const { fetched, stopAt, pages } = await fetchFrom(newest, oldestNeeded);
      return exclusive(async () => {
        const data = await load();
        const added = mergeCredits(data.credits, fetched, stopAt);
        data.credits = [...added, ...data.credits].sort((a, b) => b.at - a.at);
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

  // Regelmäßig aufgerufen: abfragen, solange noch Gutschriften erwartet werden (oder lange nicht gelesen)
  async function maybeSync() {
    const data = await load();
    const waiting = Object.values(data.missions).some((m) => m.status === "wartet auf Credits");
    const age = Date.now() - (data.meta.lastSync || 0);
    if ((waiting && age > 3 * 60 * 1000) || age > 15 * 60 * 1000) await sync();
  }

  // Durchschnittlich erhaltene Credits je Einsatzname (aus erfolgreichen Bot-Einsätzen) –
  // als Schätzung für Einsätze ohne bekannten Durchschnittswert (z.B. geplante Einsätze)
  async function learnedCredits() {
    const data = await load();
    const sums = new Map();
    for (const m of Object.values(data.missions)) {
      if (m.status !== "erfolgreich" || !m.credits) continue;
      const k = norm(m.caption);
      const e = sums.get(k) || [0, 0];
      sums.set(k, [e[0] + m.credits, e[1] + 1]);
    }
    for (const c of data.credits) {
      if (!isAlliance(c) || c.amount <= 0 || isCancelled(c)) continue;
      const k = norm(c.desc);
      if (sums.has(k)) continue; // eigene Bot-Werte haben Vorrang
      const e = sums.get("~" + k) || [0, 0];
      sums.set("~" + k, [e[0] + c.amount, e[1] + 1]);
    }
    return (caption) => {
      const k = norm(caption);
      const e = sums.get(k) || sums.get("~" + k);
      return e ? Math.round(e[0] / e[1]) : null;
    };
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
    const offset = data.meta.clockOffset || 0;
    const inRange = (t) => t >= from && t < to;
    const creditIn = (c) => inRange(c.at - offset);
    const all = Object.values(data.missions);
    const mine = all.filter((m) => inRange(m.sentAt)).sort((a, b) => b.sentAt - a.sentAt);
    const finished = mine.filter((m) => ["erfolgreich", "ohne Credits", "abgebrochen"].includes(m.status));
    const successSent = finished.filter((m) => m.status === "erfolgreich");
    const credited = all.filter((m) => m.status === "erfolgreich" && m.creditAt && inRange(m.creditAt));
    const botCredits = credited.reduce((sum, m) => sum + m.credits, 0);
    const claimed = new Set(all.map((m) => m.creditKey).filter(Boolean));
    const inPeriod = data.credits.filter(creditIn);
    const income = inPeriod.filter((c) => c.amount > 0);
    const allianceAll = income.filter((c) => isAlliance(c) && !isCancelled(c));
    const events = income.filter(isEvent);
    const sorted = data.credits.length ? data.credits.map((c) => c.at - offset).sort((a, b) => a - b) : [];
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
      // Gesamteinnahmen laut Credits-Übersicht (alles, was positiv gebucht wurde)
      incomeTotal: income.reduce((s, c) => s + c.amount, 0),
      incomeCount: income.length,
      expensesTotal: inPeriod.filter((c) => c.amount < 0).reduce((s, c) => s + c.amount, 0),
      allianceCount: allianceAll.length,
      allianceCredits: allianceAll.reduce((s, c) => s + c.amount, 0),
      manualCount: allianceAll.filter((c) => !claimed.has(c.key)).length,
      manualCredits: allianceAll.filter((c) => !claimed.has(c.key)).reduce((s, c) => s + c.amount, 0),
      eventCredits: events.reduce((s, c) => s + c.amount, 0),
      unclaimed: allianceAll.filter((c) => !claimed.has(c.key)).slice(0, 50),
      coverageFrom: sorted.length ? sorted[0] : null,
      coversPeriod: sorted.length > 0 && sorted[0] <= Math.max(from, 0) + 60000,
      creditCount: data.credits.length,
      clockOffset: offset,
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

  return {
    load,
    recordDispatch,
    observe,
    sync,
    maybeSync,
    rematch,
    migrate,
    reset,
    evaluate,
    learnedCredits,
    PERIODS,
    _test: { sameName, parseTime, match, mergeCredits, detectOffset }
  };
})();
