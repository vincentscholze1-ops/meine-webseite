// Läuft auf der Hauptseite des Leitstellenspiels.
// Schaut regelmäßig in die gewählten Einsatzlisten (Verband, Events, geplante Einsätze) und
// schickt zu jedem neuen Einsatz die voreingestellte Fahrzeugauswahl – innerhalb der Grenzen.
(async () => {
  if (window.top !== window) return;

  let settings = await lssLoadSettings();
  let timer = null;
  let nextRoundAt = null;
  let roundRunning = false;
  let errors = 0;
  let haveLock = false;
  let lastSummary = "";
  const loadedAt = Date.now();
  const logLines = []; // letzte Protokollzeilen, auch für das Popup
  const isPaused = () => settings.pausedUntil > Date.now();
  const skipped = new Map(); // missionId -> Zeitpunkt, bis wann übersprungen wird

  // Vom Bot alarmierte Einsätze und Alarmierungen der letzten Stunde – im Speicher gehalten,
  // damit die Anzeige sofort stimmt, und zusätzlich gesichert für Neuladen der Seite.
  const stored = await chrome.storage.local.get(["sent", "history"]);
  const sent = {};
  for (const [id, v] of Object.entries(stored.sent || {})) {
    sent[id] = typeof v === "number" ? { time: v, caption: "Einsatz " + id } : v;
  }
  let history = stored.history || [];
  const persist = () => chrome.storage.local.set({ sent, history });

  const panel = createPanel();
  panel.log(`Geladen – ${listMissions().length} Einsätze in den gewählten Listen gefunden.`);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue === undefined ? LSS_DEFAULTS[key] : newValue;
    }
    if ("running" in changes || "pausedUntil" in changes) {
      errors = 0;
      settings.running ? schedule(isPaused() ? settings.pausedUntil - Date.now() + 500 : 2000) : stop();
    } else if ("intervalSec" in changes && nextRoundAt && !roundRunning) {
      // Neues Intervall sofort übernehmen, nicht erst nach dem alten Countdown
      schedule(jitter(settings.intervalSec * 1000));
    }
    panel.update();
    refreshView();
  });

  // ---------- Hilfsfunktionen ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);

  function schedule(ms) {
    clearTimeout(timer);
    nextRoundAt = null;
    if (settings.running && haveLock) {
      nextRoundAt = Date.now() + ms;
      timer = setTimeout(round, ms);
    }
    panel.update();
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    nextRoundAt = null;
  }

  async function loadCredits() {
    const { missionCredits } = await chrome.storage.local.get("missionCredits");
    if (missionCredits && Date.now() - missionCredits.time < 24 * 3600 * 1000) return missionCredits.byId;
    const res = await fetch("/einsaetze.json", { credentials: "include" });
    if (!res.ok) throw new Error("einsaetze.json: HTTP " + res.status);
    const byId = {};
    for (const m of await res.json()) byId[m.id] = m.average_credits ?? null;
    await chrome.storage.local.set({ missionCredits: { time: Date.now(), byId } });
    return byId;
  }

  function activeListKeys() {
    return Object.keys(LSS_LISTS).filter((k) => settings.lists && settings.lists[k]);
  }

  function listMissions() {
    const missions = [];
    for (const key of activeListKeys()) {
      const [elementId, , planned] = LSS_LISTS[key];
      for (const el of document.querySelectorAll(`#${elementId} .missionSideBarEntry`)) {
        const id = el.getAttribute("mission_id") || el.id.replace(/^mission_/, "");
        const marker = el.querySelector(`#mission_participant_${id}`);
        const caption = el.querySelector(`#mission_caption_${id}`) || el.querySelector("a[id^=mission_caption_]");
        const panelEl = el.querySelector(`#mission_panel_${id}`) || el;
        const cls = panelEl.className || "";
        missions.push({
          id,
          list: key,
          planned,
          typeId: el.getAttribute("mission_type_id"),
          overlay: el.getAttribute("data-overlay-index"),
          additive: el.getAttribute("data-additive-overlays"),
          caption: (caption ? caption.textContent : "Einsatz " + id).replace(/\s+/g, " ").trim(),
          participating: !!marker && !marker.classList.contains("hidden"),
          state: /green/.test(cls) ? "vor Ort" : /yellow/.test(cls) ? "Anfahrt" : "offen"
        });
      }
    }
    return missions;
  }

  function presetFor(mission) {
    return mission.planned && settings.presetPlanned ? settings.presetPlanned : settings.preset;
  }

  const typeName = (id) => (id === null ? "unbekannter Typ" : LSS_TYPE_NAMES[id] || `Typ-ID ${id}`);

  // Entfernung zellenweise lesen, sonst verschmilzt z.B. "LF 20" + "2,5 km" zu "202,5 km"
  function parseKm(row) {
    for (const cell of row.querySelectorAll("td")) {
      const m = cell.textContent.trim().match(/^(\d+(?:[.,]\d+)?)\s*km$/);
      if (m) return parseFloat(m[1].replace(",", "."));
    }
    return null;
  }

  // ---------- Einen Einsatz alarmieren ----------

  async function dispatch(mission, dryRun = false) {
    const res = await fetch(`/missions/${mission.id}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Einsatz ${mission.id}: HTTP ${res.status}`);
    if (/sign_in/.test(res.url)) throw new Error("Nicht eingeloggt");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");

    const form =
      doc.querySelector("#mission-form") ||
      [...doc.querySelectorAll("form")].find((f) => f.querySelector(".vehicle_checkbox"));
    if (!form) return { ok: false, reason: "kein Alarmformular (Einsatz evtl. beendet)" };

    // Tabellenreihenfolge = nach Entfernung sortiert, nächstes Fahrzeug zuerst
    const rows = [...form.querySelectorAll("input.vehicle_checkbox")]
      .filter((cb) => !cb.disabled)
      .map((cb) => {
        const tr = cb.closest("tr") || cb;
        // Feste Typ-ID statt angezeigtem Namen – umbenannte Fahrzeuge/Typen spielen keine Rolle
        const raw = cb.getAttribute("vehicle_type_id") ?? tr.getAttribute("vehicle_type_id");
        const typeId = raw === null || raw === "" ? null : Number(raw);
        return { cb, typeId, name: typeName(typeId), km: parseKm(tr) };
      });

    if (!rows.length) return { ok: false, reason: "keine freien Fahrzeuge in der Einsatzseite gefunden" };

    const preset = presetFor(mission);
    const chosen = [];
    for (const item of preset.filter((p) => p.typeIds && p.typeIds.length)) {
      const fitting = rows.filter((r) => item.typeIds.includes(r.typeId) && !chosen.includes(r));
      if (fitting.length < item.count) {
        const seen = [...new Set(rows.map((r) => r.name))].slice(0, 6).join(", ");
        return { ok: false, reason: `nicht genug freie ${typeName(item.typeIds[0])} o.ä. (frei: ${seen})` };
      }
      chosen.push(...fitting.slice(0, item.count));
    }
    if (!chosen.length) return { ok: false, reason: "Fahrzeugauswahl ist leer" };

    const allTypes = new Set(preset.flatMap((p) => p.typeIds || []));
    const freeAfter = rows.filter((r) => allTypes.has(r.typeId)).length - chosen.length;
    if (freeAfter < settings.reserve) {
      return { ok: false, reason: `Reserve: nur noch ${freeAfter} frei` };
    }

    const farthest = Math.max(...chosen.map((r) => r.km ?? 0));
    if (farthest > settings.maxDistanceKm) {
      return { ok: false, reason: `zu weit (${farthest} km)` };
    }

    const vehicles = chosen.map((r) => r.name).join(", ");
    if (dryRun) {
      return {
        ok: true,
        vehicles,
        km: farthest,
        info: `${rows.length} freie Fahrzeuge, Entfernung ${chosen.some((r) => r.km !== null) ? "lesbar" : "nicht lesbar"}`
      };
    }

    // Formular so nachbauen, wie der Browser es beim Klick auf "Alarmieren" senden würde
    const body = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.classList.contains("vehicle_checkbox")) continue;
      if (["submit", "button", "image", "reset"].includes(el.type)) continue;
      if (["checkbox", "radio"].includes(el.type) && !el.checked) continue;
      body.append(el.name, el.value);
    }
    for (const r of chosen) body.append(r.cb.name || "vehicle_ids[]", r.cb.value);
    const button = form.querySelector("#mission_alarm_btn");
    if (button && button.name) body.append(button.name, button.value);

    const post = await fetch(form.getAttribute("action") || `/missions/${mission.id}/alarm`, {
      method: (form.getAttribute("method") || "post").toUpperCase(),
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!post.ok) throw new Error(`Alarmieren ${mission.id}: HTTP ${post.status}`);
    return { ok: true, vehicles, km: farthest };
  }

  // ---------- Ein Durchgang ----------

  function counts(missions) {
    const hourAgo = Date.now() - 3600 * 1000;
    history = history.filter((t) => t > hourAgo);
    return {
      active: missions.filter((m) => m.participating || sent[m.id]).length,
      lastHour: history.length
    };
  }

  async function round() {
    if (!settings.running || roundRunning) return;
    if (isPaused()) return schedule(settings.pausedUntil - Date.now() + 500);
    roundRunning = true;
    nextRoundAt = null;
    panel.update();
    const now = Date.now();
    try {
      const missions = listMissions();
      const inList = new Set(missions.map((m) => m.id));
      // Erledigte Einsätze verschwinden aus der Liste – dann auch hier vergessen
      if (missions.length || !document.querySelector(".missionSideBarEntry")) {
        for (const id of Object.keys(sent)) if (!inList.has(id)) delete sent[id];
      }
      await observeStats();
      for (const [id, until] of skipped) if (until < now || !inList.has(id)) skipped.delete(id);

      const { active, lastHour } = counts(missions);
      const cap = (limit, used) => (limit > 0 ? limit - used : Infinity); // 0 = unbegrenzt
      let budget = Math.min(cap(settings.maxPerRound, 0), cap(settings.maxActive, active), cap(settings.maxPerHour, lastHour));

      if (budget <= 0) {
        summarize(`Obergrenze aus den erweiterten Einstellungen erreicht (${active} aktiv, ${lastHour} in der letzten Stunde) – warte.`);
      } else {
        const candidates = await findCandidates(missions);
        if (!candidates.length) {
          const open = missions.filter((m) => !m.participating && !sent[m.id]).length;
          summarize(
            missions.length
              ? `Nichts zu tun: ${missions.length} Einsätze, ${missions.length - open} schon beteiligt, ` +
                  `${open} offen (gefiltert oder kürzlich übersprungen).`
              : "Keine Einsätze in den gewählten Listen."
          );
        }

        for (const mission of candidates) {
          if (budget <= 0 || !settings.running) break;
          const result = await dispatch(mission);
          if (result.ok) {
            sent[mission.id] = {
              time: Date.now(),
              caption: mission.caption,
              credits: mission.credits,
              vehicles: result.vehicles,
              planned: mission.planned
            };
            history.push(Date.now());
            await LssStats.recordDispatch(mission, result.vehicles);
            budget--;
            persist();
            refreshView(); // sofort anzeigen, nicht erst nach dem Durchgang
            panel.log(
              `✔ ${mission.planned ? "[geplant] " : ""}${mission.caption}` +
                `${mission.credits != null ? ` (~${mission.credits.toLocaleString("de-DE")} Cr)` : ""} ← ${result.vehicles}, ${result.km} km`
            );
          } else {
            skipped.set(mission.id, Date.now() + 10 * 60 * 1000);
            panel.log(`– ${mission.caption}: ${result.reason}`);
          }
          await sleep(jitter((settings.pauseSec ?? 3) * 1000));
        }
      }
      await persist();
      errors = 0;
      LssStats.maybeSync().catch((e) => console.warn("[LSS Auto-Alarm] Auswertung", e));
    } catch (e) {
      errors++;
      panel.log(`⚠ ${e.message}`);
      console.warn("[LSS Auto-Alarm]", e);
      if (errors >= settings.maxErrors) {
        panel.log(`Gestoppt nach ${errors} Fehlern.`);
        roundRunning = false;
        chrome.storage.sync.set({ running: false });
        return;
      }
    } finally {
      roundRunning = false;
      refreshView();
      loadFleet(); // Auslastung nach jeder Prüfung auffrischen
    }
    schedule(jitter(settings.intervalSec * 1000));
  }

  // Durchschnitts-Credits eines Einsatzes. Varianten (Overlays, z.B. mit Verletzten) haben eigene
  // Einträge in einsaetze.json ("123-1", "123-1/A") und bringen oft deutlich mehr als der Grundtyp.
  const known = (v) => v !== null && v !== undefined && v !== "" && v !== "null";
  function averageCredits(m, byId) {
    if (!known(m.typeId)) return null;
    const keys = [];
    if (known(m.overlay) && known(m.additive)) keys.push(`${m.typeId}-${m.overlay}/${m.additive}`);
    if (known(m.overlay)) keys.push(`${m.typeId}-${m.overlay}`);
    if (known(m.additive)) keys.push(`${m.typeId}/${m.additive}`);
    keys.push(String(m.typeId));
    for (const k of keys) if (byId[k] != null) return byId[k];
    return null;
  }

  // Kandidaten nach Credits sortiert – über alle Listen hinweg, geplante Einsätze eingeschlossen.
  // Ohne Durchschnittswert (häufig bei geplanten Einsätzen) zählen die Credits, die gleichnamige
  // Einsätze laut Credits-Übersicht tatsächlich gebracht haben.
  async function findCandidates(missions) {
    const byId = await loadCredits();
    const learned = await LssStats.learnedCredits().catch(() => () => null);
    const words = (settings.excludeWords || []).map((w) => w.toLowerCase()).filter(Boolean);
    return missions
      .filter((m) => !m.participating && !sent[m.id] && !skipped.has(m.id))
      .filter((m) => !words.some((w) => m.caption.toLowerCase().includes(w)))
      .map((m) => {
        const avg = averageCredits(m, byId);
        const est = avg ?? learned(m.caption);
        return { ...m, credits: est, creditsSource: avg != null ? "Ø" : est != null ? "erfahren" : null };
      })
      .filter((m) => (m.credits === null ? settings.allowUnknownCredits : m.credits >= settings.minCredits))
      .sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1)); // lukrativste zuerst, unbekannte zuletzt
  }

  // Gleiche Statusmeldung nicht jede Runde neu ins Protokoll schreiben
  function summarize(text) {
    if (text !== lastSummary) panel.log(text);
    lastSummary = text;
  }

  // Probelauf ohne zu alarmieren: zeigt, was der Bot sieht
  async function diagnose() {
    const lines = [];
    const out = (text) => {
      lines.push(text);
      panel.log(text);
    };
    try {
      const missions = listMissions();
      const perList = activeListKeys()
        .map((k) => `${LSS_LISTS[k][1]}: ${missions.filter((m) => m.list === k).length}`)
        .join(", ");
      out(`Diagnose: ${perList || "keine Liste gewählt"} · Lock: ${haveLock ? "ja" : "nein"} · Bot ${settings.running ? "läuft" : "gestoppt"}`);
      const candidates = await findCandidates(missions);
      out(
        `Diagnose: ${candidates.length} Kandidaten nach Filtern` +
          (candidates.length
            ? ` – Reihenfolge: ` +
              candidates
                .slice(0, 5)
                .map((c) => `${c.planned ? "📅 " : ""}${c.caption} (${c.credits != null ? c.credits.toLocaleString("de-DE") + " Cr" : "? Cr"})`)
                .join(" › ")
            : ".")
      );
      const target = candidates[0] || missions[0];
      if (target) {
        const result = await dispatch(target, true);
        out(
          `Diagnose „${target.caption}“: ` +
            (result.ok ? `würde ${result.vehicles} schicken (${result.km} km) – ${result.info}` : result.reason)
        );
      }
    } catch (e) {
      out(`Diagnose-Fehler: ${e.message}`);
    }
    return lines;
  }

  // Diagnose auch aus dem Popup der Erweiterung heraus
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Auswertungsseite bittet um Abruf der Credits-Übersicht (geht nur hier im Spiel-Tab)
    if (msg && msg.type === "lssaa-sync") {
      LssStats.sync()
        .then((added) => sendResponse({ added }))
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    // Popup: sofort prüfen
    if (msg && msg.type === "lssaa-now") {
      if (!settings.running) sendResponse({ ok: false, reason: "Bot ist gestoppt" });
      else if (isPaused()) sendResponse({ ok: false, reason: "Bot ist pausiert" });
      else {
        if (!roundRunning) schedule(0);
        sendResponse({ ok: true });
      }
      return;
    }
    if (msg && msg.type === "lssaa-diagnose") {
      diagnose().then((lines) => sendResponse({ lines, panel: !!document.getElementById("lss-verbands-bot") }));
      return true;
    }
  });

  // ---------- Live-Anzeige ----------

  // Fuhrpark aus /api/vehicles: Funkstatus (FMS) je Fahrzeug -> Auslastung
  let fleet = null;
  let fleetError = null;
  let fleetAt = 0;
  let creditsToday = null;
  let incomeToday = null; // { total, alliance } laut Credits-Übersicht

  const FMS_GROUP = { 1: "free", 2: "free", 3: "drive", 4: "scene", 5: "scene", 7: "transport", 8: "transport" };

  async function loadFleet() {
    try {
      const res = await fetch("/api/vehicles", { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const vehicles = Array.isArray(json) ? json : json.vehicles || json.result || [];
      const c = { free: 0, drive: 0, scene: 0, transport: 0, na: 0 };
      const presetIds = new Set(
        [...(settings.preset || []), ...(settings.presetPlanned || [])].flatMap((p) => p.typeIds || [])
      );
      let presetFree = 0;
      let presetTotal = 0;
      let botVehicles = 0;
      for (const v of vehicles) {
        const group = FMS_GROUP[v.fms_real] || "na";
        c[group]++;
        if (presetIds.has(v.vehicle_type) && group !== "na") {
          presetTotal++;
          if (group === "free") presetFree++;
        }
        if (v.target_type === "mission" && sent[String(v.target_id)]) botVehicles++;
      }
      const available = vehicles.length - c.na;
      fleet = {
        counts: c,
        total: vehicles.length,
        busyPct: available ? Math.round(((available - c.free) / available) * 100) : 0,
        presetFree,
        presetTotal,
        botVehicles
      };
      fleetError = null;
    } catch (e) {
      fleetError = e.message;
    }
    fleetAt = Date.now();
    refreshView();
  }

  async function loadCreditsToday() {
    try {
      const data = await LssStats.load();
      const r = LssStats.evaluate(data, LssStats.PERIODS.today[1]());
      creditsToday = r.botCredits;
      incomeToday = r.creditCount ? { total: r.incomeTotal, alliance: r.allianceCredits } : null;
    } catch (e) {
      creditsToday = null;
      incomeToday = null;
    }
    refreshView();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.statsMissions || changes.statsCredits)) loadCreditsToday();
  });

  // Einsatzende für die Auswertung erkennen – laufend, auch wenn der Bot gestoppt ist.
  // Direkt nach dem Laden der Seite ist die Einsatzliste evtl. noch leer: dann kurz warten,
  // sonst würden alle laufenden Einsätze fälschlich als beendet gelten.
  function observeStats() {
    const entries = document.querySelectorAll(".missionSideBarEntry");
    if (!entries.length && Date.now() - loadedAt < 20000) return Promise.resolve(0);
    const ids = new Set([...entries].map((el) => el.getAttribute("mission_id") || el.id.replace(/^mission_/, "")));
    return LssStats.observe(ids).catch((e) => console.warn("[LSS Verbands-Bot] Auswertung", e));
  }

  // Alarmierungen der letzten 60 Minuten in 12 Abschnitten à 5 Minuten
  function historyBins() {
    const now = Date.now();
    const bins = Array(12).fill(0);
    for (const t of history) {
      const age = now - t;
      if (age >= 0 && age < 3600000) bins[11 - Math.floor(age / 300000)]++;
    }
    return bins;
  }

  // Kurzfassung für Popup und Symbol-Badge (gedrosselt gespeichert)
  let liveTimer = null;
  let liveData = null;
  function publishLive(data) {
    liveData = data;
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      const d = liveData;
      chrome.storage.local.set({
        liveStatus: {
          at: Date.now(),
          version: chrome.runtime.getManifest().version,
          running: settings.running,
          pausedUntil: settings.pausedUntil || 0,
          haveLock,
          active: d.active,
          lastHour: d.lastHour,
          nextRoundAt,
          roundRunning,
          creditsToday: d.creditsToday,
          incomeToday,
          fleet: d.fleet
            ? {
                busyPct: d.fleet.busyPct,
                free: d.fleet.counts.free,
                total: d.fleet.total,
                presetFree: d.fleet.presetFree,
                presetTotal: d.fleet.presetTotal,
                botVehicles: d.fleet.botVehicles
              }
            : null,
          mine: d.mine.slice(0, 5).map((m) => ({ id: m.id, caption: m.caption, state: m.state, planned: !!m.planned })),
          log: logLines.slice(0, 6)
        }
      });
    }, 1500);
  }

  function refreshView() {
    const missions = listMissions();
    const { active, lastHour } = counts(missions);
    const byId = Object.fromEntries(missions.map((m) => [m.id, m]));
    const mine = Object.entries(sent)
      .filter(([id]) => byId[id])
      .map(([id, info]) => ({ id, ...info, state: byId[id].state }))
      .sort((a, b) => b.time - a.time);
    const data = { active, lastHour, mine, total: missions.length, bins: historyBins(), fleet, fleetError, fleetAt, creditsToday };
    panel.view(data);
    publishLive(data);
  }

  // Einsatzliste beobachten: jede Änderung im Spiel aktualisiert Anzeige und Auswertung sofort
  let refreshPending = false;
  new MutationObserver((mutations) => {
    const own = document.getElementById("lss-verbands-bot");
    if (refreshPending || mutations.every((m) => own && own.contains(m.target))) return;
    refreshPending = true;
    setTimeout(() => {
      refreshPending = false;
      refreshView();
      observeStats();
    }, 400);
  }).observe(document.getElementById("missions-panel-body") || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });

  // ---------- Panel ----------

  function createPanel() {
    const box = document.createElement("div");
    box.id = "lss-verbands-bot";
    const speedButtons = Object.entries(LSS_SPEEDS)
      .map(([key, v]) => `<button type="button" data-speed="${key}" title="${v.hint}">${v.icon} ${v.label}</button>`)
      .join("");
    box.innerHTML = `
      <div class="lssaa-progress"><i></i></div>
      <div class="lssaa-head" title="Ziehen zum Verschieben · Doppelklick setzt Position und Größe zurück">
        <span class="lssaa-logo">🚒</span>
        <span class="lssaa-title">
          <strong>Verbands-Bot <span class="lssaa-version">v${chrome.runtime.getManifest().version}</span></strong>
          <span class="lssaa-state"></span>
        </span>
        <span class="lssaa-mini"><b class="m-active">0</b> aktiv · <b class="m-next">–</b></span>
        <span class="lssaa-spacer"></span>
        <button type="button" class="lssaa-icon lssaa-stats-btn" title="Auswertung: Einsätze &amp; Credits">📊</button>
        <button type="button" class="lssaa-icon lssaa-settings" title="Einstellungen">⚙</button>
        <button type="button" class="lssaa-icon lssaa-collapse" title="Ein-/Ausklappen">▾</button>
      </div>
      <div class="lssaa-body">
        <div class="lssaa-warning"></div>
        <div class="lssaa-controls">
          <div class="lssaa-mainrow">
            <button type="button" class="lssaa-toggle"></button>
            <button type="button" class="lssaa-pausebtn" title="Pause einlegen">❚❚</button>
          </div>
          <div class="lssaa-pausemenu" hidden>
            <span>Pause für</span>
            <button type="button" data-pause="15">15 min</button>
            <button type="button" data-pause="30">30 min</button>
            <button type="button" data-pause="60">1 h</button>
            <button type="button" data-pause="180">3 h</button>
          </div>
          <div class="lssaa-speed" role="group" aria-label="Tempo">${speedButtons}</div>
          <div class="lssaa-speed-hint"></div>
        </div>
        <div class="lssaa-grid">
          <div class="lssaa-col">
            <div class="lssaa-kpis">
              <div class="lssaa-kpi"><span class="ico">🚨</span><b class="k-active">0</b><span>Einsätze aktiv</span></div>
              <div class="lssaa-kpi"><span class="ico">📤</span><b class="k-hour">0</b><span>alarmiert (60 min)</span></div>
              <div class="lssaa-kpi"><span class="ico">💰</span><b class="k-credits">–</b><span>Credits heute (Bot)</span></div>
              <div class="lssaa-kpi"><span class="ico">⏱</span><b class="k-next">–</b><span>nächste Prüfung</span></div>
            </div>

            <section class="lssaa-card">
              <div class="lssaa-card-head"><span>Fuhrpark-Auslastung</span><span class="lssaa-badge f-badge"></span></div>
              <div class="lssaa-hero"><b class="f-pct">–</b><span class="f-sub">lade Fahrzeugdaten …</span></div>
              <div class="lssaa-meter f-meter"><i></i></div>
              <div class="lssaa-stack f-stack"></div>
              <ul class="lssaa-legend f-legend"></ul>
              <div class="lssaa-foot f-foot"></div>
            </section>

            <section class="lssaa-card">
              <div class="lssaa-card-head"><span>Deine Fahrzeugauswahl</span><span class="lssaa-badge p-badge"></span></div>
              <div class="lssaa-hero"><b class="p-free">–</b><span class="p-sub"></span></div>
              <div class="lssaa-meter p-meter"><i></i><em class="p-reserve" title="Reserve"></em></div>
            </section>

            <section class="lssaa-card">
              <div class="lssaa-card-head"><span>Alarmierungen · 60 min</span><span class="lssaa-muted h-sum"></span></div>
              <div class="lssaa-cols h-cols"></div>
              <div class="lssaa-axis"><span>−60 min</span><span>−30</span><span>jetzt</span></div>
            </section>
          </div>

          <div class="lssaa-col">
            <div class="lssaa-actions">
              <button type="button" class="lssaa-now">⟳ Jetzt prüfen</button>
              <button type="button" class="lssaa-diag" title="Probelauf ohne Alarmierung">🔍 Diagnose</button>
            </div>
            <div class="lssaa-section">Vom Bot alarmiert <span class="lssaa-count"></span></div>
            <ul class="lssaa-mine"></ul>
            <details class="lssaa-logbox"><summary>Protokoll</summary><ul class="lssaa-log"></ul></details>
          </div>
        </div>
      </div>
      <div class="lssaa-tip" hidden></div>
      <div class="lssaa-resize" title="Größe ändern"></div>`;
    document.body.appendChild(box);
    const $ = (sel) => box.querySelector(sel);
    const logEl = $(".lssaa-log");
    const store = (key, value) => {
      try {
        value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
      } catch (e) {}
    };
    const load = (key) => {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    };
    const fmt = (n) => (n ?? 0).toLocaleString("de-DE");
    const clock = (t) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

    // ---- Aktionen (von Panel und Leisten-Menü gemeinsam genutzt) ----
    const actions = {
      toggle() {
        // Pausiert: Klick setzt fort; sonst Start/Stopp
        if (settings.running && isPaused()) chrome.storage.sync.set({ pausedUntil: 0 });
        else chrome.storage.sync.set({ running: !settings.running, pausedUntil: 0 });
      },
      pause(minutes) {
        const until = Date.now() + minutes * 60000;
        chrome.storage.sync.set({ running: true, pausedUntil: until });
        api.log(`Pause bis ${clock(until)} Uhr.`);
      },
      speed(key) {
        chrome.storage.sync.set(lssSpeedValues(key));
        api.log(`Tempo: ${LSS_SPEEDS[key].label} (${LSS_SPEEDS[key].hint})`);
      },
      now() {
        if (!settings.running) return api.log("Erst „Starten“ drücken.");
        if (isPaused()) return api.log("Bot ist pausiert – zum Fortsetzen auf „Fortsetzen“ klicken.");
        if (!roundRunning) schedule(0);
      },
      diagnose() {
        setHidden(false);
        $(".lssaa-logbox").open = true;
        diagnose();
      },
      stats: () => window.open(chrome.runtime.getURL("stats.html"), "_blank"),
      settings: () => window.open(chrome.runtime.getURL("options.html"), "_blank")
    };

    $(".lssaa-toggle").addEventListener("click", actions.toggle);
    $(".lssaa-pausebtn").addEventListener("click", () => ($(".lssaa-pausemenu").hidden = !$(".lssaa-pausemenu").hidden));
    for (const b of box.querySelectorAll("[data-pause]")) {
      b.addEventListener("click", () => {
        actions.pause(Number(b.dataset.pause));
        $(".lssaa-pausemenu").hidden = true;
      });
    }
    for (const b of box.querySelectorAll("[data-speed]")) b.addEventListener("click", () => actions.speed(b.dataset.speed));
    $(".lssaa-stats-btn").addEventListener("click", actions.stats);
    $(".lssaa-diag").addEventListener("click", actions.diagnose);
    $(".lssaa-now").addEventListener("click", actions.now);
    $(".lssaa-settings").addEventListener("click", actions.settings);

    // ---- Verschieben (am Kopf ziehen) ----
    const place = (left, top) => {
      box.style.left = left + "px";
      box.style.top = top + "px";
      box.style.bottom = "auto";
    };
    // Panel immer vollständig im Fenster halten: Größe begrenzen, dann Position nachschieben.
    // Greift beim Laden, bei Fenstergrößen-Änderung, beim Aus-/Einklappen und wenn der Inhalt wächst.
    const MARGIN = 8;
    function keepInView() {
      if (box.classList.contains("lssaa-hidden")) return;
      const maxW = window.innerWidth - 2 * MARGIN;
      const maxH = window.innerHeight - 2 * MARGIN;
      if (box.style.width && parseFloat(box.style.width) > maxW) box.style.width = maxW + "px";
      if (box.style.height && parseFloat(box.style.height) > maxH) box.style.height = maxH + "px";
      if (!box.style.top) return; // Standardplatz unten links: CSS begrenzt die Höhe
      const r = box.getBoundingClientRect();
      const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - r.width - MARGIN);
      const top = Math.min(Math.max(MARGIN, r.top), window.innerHeight - r.height - MARGIN);
      if (Math.round(left) !== Math.round(r.left) || Math.round(top) !== Math.round(r.top)) {
        place(Math.max(MARGIN, left), Math.max(MARGIN, top));
      }
    }
    const head = $(".lssaa-head");
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      box.classList.add("dragging");
      head.setPointerCapture(e.pointerId);
      const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        box.classList.remove("dragging");
        keepInView();
        store("lssaa-pos", JSON.stringify({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) }));
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      e.preventDefault();
    });

    // ---- Größe ändern (Griff unten rechts) ----
    const MIN_W = 320;
    const MIN_H = 240;
    const resize = $(".lssaa-resize");
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = box.getBoundingClientRect();
      place(r.left, r.top); // an der aktuellen Position verankern (statt "bottom")
      const sx = e.clientX;
      const sy = e.clientY;
      box.classList.add("resizing");
      resize.setPointerCapture(e.pointerId);
      const move = (ev) => {
        box.style.width = Math.min(Math.max(MIN_W, r.width + ev.clientX - sx), window.innerWidth - r.left - 4) + "px";
        box.style.height = Math.min(Math.max(MIN_H, r.height + ev.clientY - sy), window.innerHeight - r.top - 4) + "px";
      };
      const up = () => {
        resize.removeEventListener("pointermove", move);
        resize.removeEventListener("pointerup", up);
        box.classList.remove("resizing");
        store("lssaa-size", JSON.stringify({ w: parseFloat(box.style.width), h: parseFloat(box.style.height) }));
        store("lssaa-pos", JSON.stringify({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) }));
      };
      resize.addEventListener("pointermove", move);
      resize.addEventListener("pointerup", up);
      e.preventDefault();
      e.stopPropagation();
    });

    head.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      store("lssaa-pos", null);
      store("lssaa-size", null);
      box.style.left = box.style.top = box.style.bottom = box.style.width = box.style.height = "";
    });
    window.addEventListener("resize", keepInView);

    const setCollapsed = (c) => {
      box.classList.toggle("collapsed", c);
      $(".lssaa-collapse").textContent = c ? "▸" : "▾";
      store("lssaa-collapsed", c ? "1" : null);
      keepInView();
    };
    $(".lssaa-collapse").addEventListener("click", () => setCollapsed(!box.classList.contains("collapsed")));

    try {
      const pos = JSON.parse(load("lssaa-pos"));
      if (pos) place(pos.left, pos.top);
      const size = JSON.parse(load("lssaa-size"));
      if (size) {
        box.style.width = Math.max(MIN_W, size.w) + "px";
        box.style.height = Math.max(MIN_H, size.h) + "px";
      }
    } catch (e) {}
    setCollapsed(!!load("lssaa-collapsed"));
    keepInView();
    new ResizeObserver(() => keepInView()).observe(box);

    // ---- Einbindung in die Leiste oben (wie andere Erweiterungen) ----
    const navbar =
      document.querySelector("#main_navbar .navbar-right") ||
      document.querySelector(".navbar-default .navbar-right") ||
      document.querySelector("#navbar-main-collapse > ul");
    let nav = null;
    // Panel ein-/ausblenden; mit Leiste standardmäßig ausgeblendet (alles Wichtige ist im Menü)
    function setHidden(h) {
      box.classList.toggle("lssaa-hidden", h);
      store("lssaa-hidden", h ? "1" : "0");
      if (nav) nav.querySelector(".n-panel").textContent = h ? "🗔  Großes Panel anzeigen" : "🗔  Großes Panel ausblenden";
      if (!h) keepInView();
    }
    if (navbar) {
      nav = document.createElement("li");
      nav.id = "lssaa-nav";
      nav.className = "dropdown";
      nav.innerHTML = `
        <a href="#" class="dropdown-toggle lssaa-nav-toggle" role="button" title="Verbands-Bot">
          <span class="lssaa-nav-dot"></span>🚒 <span class="lssaa-nav-label">Bot</span>
          <span class="lssaa-nav-count"></span> <span class="caret"></span>
        </a>
        <div class="dropdown-menu lssaa-nav-menu">
          <div class="n-head"><b>Verbands-Bot</b> <span class="n-version">v${chrome.runtime.getManifest().version}</span><span class="n-state"></span></div>
          <div class="n-row">
            <button type="button" class="n-toggle"></button>
            <button type="button" class="n-now" title="Jetzt prüfen">⟳</button>
          </div>
          <div class="n-chips"><span>❚❚ Pause</span>
            <button type="button" data-npause="15">15 min</button><button type="button" data-npause="30">30 min</button>
            <button type="button" data-npause="60">1 h</button><button type="button" data-npause="180">3 h</button>
          </div>
          <div class="n-speed">${Object.entries(LSS_SPEEDS)
            .map(([k, v]) => `<button type="button" data-nspeed="${k}" title="${v.hint}">${v.icon} ${v.label}</button>`)
            .join("")}</div>
          <div class="n-kpis">
            <div><b class="n-active">0</b><span>aktiv</span></div>
            <div><b class="n-next">–</b><span>nächste Prüfung</span></div>
            <div><b class="n-credits">–</b><span>Credits heute (Bot)</span></div>
            <div><b class="n-load">–</b><span>Auslastung</span></div>
          </div>
          <div class="n-links">
            <button type="button" class="n-panel"></button>
            <button type="button" class="n-stats">📊  Auswertung</button>
            <button type="button" class="n-diag">🔍  Diagnose</button>
            <button type="button" class="n-settings">⚙  Einstellungen</button>
          </div>
        </div>`;
      navbar.insertBefore(nav, navbar.firstChild);
      const n = (sel) => nav.querySelector(sel);
      const close = () => nav.classList.remove("open");
      n(".lssaa-nav-toggle").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        nav.classList.toggle("open");
      });
      n(".lssaa-nav-menu").addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", close);
      document.addEventListener("keydown", (e) => e.key === "Escape" && close());
      n(".n-toggle").addEventListener("click", actions.toggle);
      n(".n-now").addEventListener("click", actions.now);
      for (const b of nav.querySelectorAll("[data-npause]")) b.addEventListener("click", () => actions.pause(Number(b.dataset.npause)));
      for (const b of nav.querySelectorAll("[data-nspeed]")) b.addEventListener("click", () => actions.speed(b.dataset.nspeed));
      n(".n-panel").addEventListener("click", () => {
        setHidden(!box.classList.contains("lssaa-hidden"));
        close();
      });
      n(".n-stats").addEventListener("click", () => (actions.stats(), close()));
      n(".n-diag").addEventListener("click", () => (actions.diagnose(), close()));
      n(".n-settings").addEventListener("click", () => (actions.settings(), close()));
      setHidden(load("lssaa-hidden") !== "0");
    } else {
      setHidden(false);
    }

    // ---- Tooltip für Diagramme ----
    const tip = $(".lssaa-tip");
    box.addEventListener("pointermove", (e) => {
      const t = e.target.closest("[data-tip]");
      if (!t) return (tip.hidden = true);
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const r = box.getBoundingClientRect();
      tip.style.left = Math.max(6, Math.min(e.clientX - r.left + 12, r.width - tip.offsetWidth - 6)) + "px";
      tip.style.top = e.clientY - r.top - tip.offsetHeight - 10 + "px";
    });
    box.addEventListener("pointerleave", () => (tip.hidden = true));

    // Countdown + Fortschrittslinie oben jede Sekunde
    let cycleStart = Date.now();
    let cycleEnd = null;
    setInterval(() => {
      if (nextRoundAt !== cycleEnd) {
        cycleEnd = nextRoundAt;
        cycleStart = Date.now();
      }
      const text = roundRunning
        ? "läuft…"
        : isPaused()
          ? "Pause"
          : nextRoundAt
            ? Math.max(0, Math.round((nextRoundAt - Date.now()) / 1000)) + " s"
            : "–";
      $(".k-next").textContent = text;
      $(".m-next").textContent = text;
      if (nav) nav.querySelector(".n-next").textContent = text;
      const pct = roundRunning ? 100 : nextRoundAt ? ((Date.now() - cycleStart) / Math.max(1, nextRoundAt - cycleStart)) * 100 : 0;
      $(".lssaa-progress i").style.width = Math.min(100, Math.max(0, pct)) + "%";
      box.classList.toggle("busy", roundRunning);
    }, 1000);

    // ---- Diagramm-Bausteine ----
    const FLEET_PARTS = [
      ["free", "Frei", "s1"],
      ["drive", "Anfahrt", "s2"],
      ["scene", "Vor Ort", "s3"],
      ["transport", "Transport", "s4"],
      ["na", "Nicht verfügbar", "s0"]
    ];
    const loadLevel = (pct) =>
      pct >= 85 ? ["⛔ am Limit", "crit"] : pct >= 60 ? ["⚠ ausgelastet", "warn"] : ["✓ entspannt", "good"];

    function renderFleet(f, error, at) {
      if (!f) {
        $(".f-sub").textContent = error ? `Fahrzeugdaten nicht abrufbar (${error})` : "lade Fahrzeugdaten …";
        return;
      }
      const [label, cls] = loadLevel(f.busyPct);
      $(".f-pct").textContent = f.busyPct + " %";
      $(".f-sub").textContent = `im Einsatz · ${fmt(f.total - f.counts.na - f.counts.free)} von ${fmt(f.total - f.counts.na)} Fahrzeugen`;
      $(".f-badge").textContent = label;
      $(".f-badge").className = "lssaa-badge f-badge " + cls;
      $(".f-meter i").style.width = f.busyPct + "%";
      $(".f-meter").dataset.tip = `${f.busyPct} % der einsatzbereiten Fahrzeuge sind unterwegs oder vor Ort`;

      const stack = $(".f-stack");
      stack.replaceChildren();
      const legend = $(".f-legend");
      legend.replaceChildren();
      for (const [key, name, color] of FLEET_PARTS) {
        const n = f.counts[key];
        if (n) {
          const seg = document.createElement("i");
          seg.className = color;
          seg.style.flexGrow = n;
          seg.dataset.tip = `${name}: ${fmt(n)} Fahrzeuge (${Math.round(f.total ? (n / f.total) * 100 : 0)} %)`;
          stack.appendChild(seg);
        }
        const li = document.createElement("li");
        li.innerHTML = `<i class="${color}"></i>${name} <b>${fmt(n)}</b>`;
        legend.appendChild(li);
      }
      const age = Math.round((Date.now() - at) / 1000);
      $(".f-foot").textContent = `${fmt(f.botVehicles)} Fahrzeuge fahren gerade für den Bot · Stand vor ${age < 60 ? age + " s" : Math.round(age / 60) + " min"}`;

      const freeAfterReserve = f.presetFree - settings.reserve;
      $(".p-free").textContent = fmt(f.presetFree);
      $(".p-sub").textContent = `frei von ${fmt(f.presetTotal)} passenden Fahrzeugen · Reserve ${settings.reserve}`;
      const [pl, pc] =
        f.presetTotal === 0
          ? ["⚠ keine passenden Fahrzeuge", "warn"]
          : freeAfterReserve <= 0
            ? ["⛔ nur noch Reserve", "crit"]
            : freeAfterReserve <= 2
              ? ["⚠ wird knapp", "warn"]
              : [`✓ ${freeAfterReserve} einsetzbar`, "good"];
      $(".p-badge").textContent = pl;
      $(".p-badge").className = "lssaa-badge p-badge " + pc;
      $(".p-meter i").style.width = (f.presetTotal ? (f.presetFree / f.presetTotal) * 100 : 0) + "%";
      $(".p-meter").dataset.tip = `${f.presetFree} von ${f.presetTotal} Fahrzeugen deiner Auswahl sind frei`;
      const reserve = $(".p-reserve");
      reserve.style.left = f.presetTotal ? Math.min(100, (settings.reserve / f.presetTotal) * 100) + "%" : "0";
      reserve.hidden = !f.presetTotal;
    }

    function renderBins(bins) {
      const cols = $(".h-cols");
      cols.replaceChildren();
      const max = Math.max(1, ...bins);
      bins.forEach((n, i) => {
        const c = document.createElement("i");
        c.style.height = n ? Math.max(6, (n / max) * 100) + "%" : "2px";
        c.className = n ? "" : "zero";
        const from = 60 - i * 5;
        c.dataset.tip = `vor ${from}–${from - 5} min: ${n} Alarmierung${n === 1 ? "" : "en"}`;
        cols.appendChild(c);
      });
      $(".h-sum").textContent = `${bins.reduce((a, b) => a + b, 0)} gesamt`;
    }

    const api = {
      update() {
        const waiting = settings.running && !haveLock;
        const paused = settings.running && isPaused();
        const state = $(".lssaa-state");
        state.textContent = waiting
          ? "wartet (anderer Tab)"
          : paused
            ? `pausiert bis ${clock(settings.pausedUntil)}`
            : settings.running
              ? "läuft"
              : "gestoppt";
        box.classList.toggle("running", settings.running && !waiting && !paused);
        box.classList.toggle("paused", paused);
        $(".lssaa-toggle").textContent = paused ? "▶  Fortsetzen" : settings.running ? "■  Stoppen" : "▶  Starten";
        const speed = settings.speed || lssSpeedOf(settings);
        for (const b of box.querySelectorAll("[data-speed]")) b.classList.toggle("on", b.dataset.speed === speed);
        $(".lssaa-speed-hint").textContent =
          speed in LSS_SPEEDS
            ? LSS_SPEEDS[speed].hint
            : `eigenes Tempo: alle ${settings.intervalSec} s, ${settings.maxPerRound || "beliebig viele"} je Prüfung`;
        if (nav) {
          nav.classList.toggle("running", settings.running && !waiting && !paused);
          nav.classList.toggle("paused", paused);
          nav.querySelector(".n-state").textContent = state.textContent;
          nav.querySelector(".n-toggle").textContent = $(".lssaa-toggle").textContent;
          for (const b of nav.querySelectorAll("[data-nspeed]")) b.classList.toggle("on", b.dataset.nspeed === speed);
        }
      },
      view({ active, lastHour, mine, total, bins, fleet, fleetError, fleetAt, creditsToday }) {
        $(".k-active").textContent = fmt(active);
        $(".m-active").textContent = fmt(active);
        $(".k-hour").textContent = fmt(lastHour);
        $(".k-credits").textContent = creditsToday == null ? "–" : fmt(creditsToday);
        $(".k-credits").parentElement.dataset.tip = incomeToday
          ? `Heute laut Credits-Übersicht: ${fmt(incomeToday.total)} Credits gesamt, davon ${fmt(incomeToday.alliance)} aus Verbandseinsätzen, ${fmt(creditsToday)} durch den Bot`
          : "Credits, die heute für vom Bot alarmierte Einsätze gutgeschrieben wurden";
        if (nav) {
          nav.querySelector(".n-active").textContent = fmt(active);
          nav.querySelector(".lssaa-nav-count").textContent = settings.running ? fmt(active) : "";
          nav.querySelector(".n-credits").textContent = creditsToday == null ? "–" : fmt(creditsToday);
          nav.querySelector(".n-load").textContent = fleet ? fleet.busyPct + " %" : "–";
        }
        renderFleet(fleet, fleetError, fleetAt);
        renderBins(bins);

        $(".lssaa-count").textContent = mine.length ? mine.length : "";
        const list = $(".lssaa-mine");
        list.replaceChildren();
        if (!mine.length) {
          const li = document.createElement("li");
          li.className = "empty";
          li.textContent = total ? `Noch keine – ${total} Einsätze in den Listen.` : "Noch keine.";
          list.appendChild(li);
        }
        for (const m of mine) {
          const li = document.createElement("li");
          const cls = m.state === "vor Ort" ? "green" : m.state === "Anfahrt" ? "yellow" : "red";
          li.className = cls;
          const a = document.createElement("a");
          a.href = `/missions/${m.id}`;
          a.className = "lightbox-open";
          a.textContent = (m.planned ? "📅 " : "") + m.caption;
          const meta = document.createElement("div");
          meta.className = "meta";
          const badge = document.createElement("span");
          badge.className = "lssaa-state-pill " + cls;
          badge.textContent = m.state;
          const info = document.createElement("span");
          const mins = Math.round((Date.now() - m.time) / 60000);
          info.textContent = `${m.credits != null ? "~" + fmt(m.credits) + " Cr · " : ""}vor ${mins} min`;
          meta.append(badge, info);
          li.append(a, meta);
          list.appendChild(li);
        }
      },
      log(text) {
        logLines.unshift({ t: Date.now(), text });
        logLines.length = Math.min(logLines.length, 40);
        const li = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = clock(Date.now());
        li.append(time, " " + text);
        logEl.prepend(li);
        while (logEl.children.length > 40) logEl.lastChild.remove();
      }
    };

    // Ältere Version noch installiert? Die legt ein Panel mit der alten ID an.
    const checkOld = () => {
      if (document.getElementById("lss-auto-alarm")) {
        $(".lssaa-warning").textContent =
          "⚠ Eine ältere Version des Bots ist noch installiert und läuft parallel. " +
          "Bitte unter chrome://extensions die alte Version entfernen und die Seite neu laden.";
      }
    };
    setTimeout(checkOld, 3000);
    setTimeout(checkOld, 10000);

    api.update();
    return api;
  }

  refreshView();
  loadFleet();
  LssStats.migrate()
    .then((changed) => changed && panel.log("Auswertung: Zuordnung der Credits nach dem Update neu berechnet."))
    .catch(() => {})
    .then(loadCreditsToday);
  // Fuhrpark alle 90 s neu laden (nur wenn der Tab sichtbar ist oder der Bot läuft)
  setInterval(() => {
    if (!document.hidden || settings.running) loadFleet();
  }, 90 * 1000);
  // Anzeige, Einsatzende und Pausen-Ende regelmäßig prüfen
  setInterval(() => {
    refreshView();
    observeStats();
    panel.update();
  }, 30 * 1000);
  // Credits-Übersicht lesen, solange Gutschriften erwartet werden (auch bei gestopptem Bot)
  setTimeout(() => LssStats.maybeSync().catch(() => {}), 25 * 1000);
  setInterval(() => LssStats.maybeSync().catch(() => {}), 5 * 60 * 1000);

  function takeLock() {
    haveLock = true;
    panel.update();
    schedule(3000);
  }

  // Nur ein Tab darf gleichzeitig alarmieren
  if (navigator.locks) {
    navigator.locks.request("lss-auto-alarm-bot", () => {
      takeLock();
      return new Promise(() => {}); // Lock halten, solange der Tab offen ist
    });
  } else {
    takeLock();
  }
})();
