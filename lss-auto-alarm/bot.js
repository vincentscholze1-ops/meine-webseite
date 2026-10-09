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
    if ("running" in changes) {
      errors = 0;
      settings.running ? schedule(2000) : stop();
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
        // Alle Einsätze der Seite berücksichtigen, nicht nur die gewählten Listen
        const onPage = [...document.querySelectorAll(".missionSideBarEntry")].map(
          (el) => el.getAttribute("mission_id") || el.id.replace(/^mission_/, "")
        );
        await LssStats.markEnded(new Set(onPage));
      }
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
            LssStats.recordDispatch(mission, result.vehicles);
            budget--;
            persist();
            refreshView(); // sofort anzeigen, nicht erst nach dem Durchgang
            panel.log(`✔ ${mission.planned ? "[geplant] " : ""}${mission.caption} ← ${result.vehicles}, ${result.km} km`);
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

  async function findCandidates(missions) {
    const credits = await loadCredits();
    const words = (settings.excludeWords || []).map((w) => w.toLowerCase()).filter(Boolean);
    return missions
      .filter((m) => !m.participating && !sent[m.id] && !skipped.has(m.id))
      .filter((m) => !words.some((w) => m.caption.toLowerCase().includes(w)))
      .map((m) => ({ ...m, credits: credits[m.typeId] ?? null }))
      .filter((m) => (m.credits === null ? settings.allowUnknownCredits : m.credits >= settings.minCredits))
      .sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1)); // lukrativste zuerst
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
      out(`Diagnose: ${candidates.length} Kandidaten nach Filtern.`);
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
      creditsToday = LssStats.evaluate(data, LssStats.PERIODS.today[1]()).botCredits;
    } catch (e) {
      creditsToday = null;
    }
    refreshView();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.statsMissions) loadCreditsToday();
  });

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

  function refreshView() {
    const missions = listMissions();
    const { active, lastHour } = counts(missions);
    const byId = Object.fromEntries(missions.map((m) => [m.id, m]));
    const mine = Object.entries(sent)
      .filter(([id]) => byId[id])
      .map(([id, info]) => ({ id, ...info, state: byId[id].state }))
      .sort((a, b) => b.time - a.time);
    panel.view({ active, lastHour, mine, total: missions.length, bins: historyBins(), fleet, fleetError, fleetAt, creditsToday });
  }

  // Einsatzliste beobachten: jede Änderung im Spiel aktualisiert die Anzeige sofort
  let refreshPending = false;
  new MutationObserver((mutations) => {
    const own = document.getElementById("lss-verbands-bot");
    if (refreshPending || mutations.every((m) => own && own.contains(m.target))) return;
    refreshPending = true;
    setTimeout(() => {
      refreshPending = false;
      refreshView();
    }, 300);
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
      <div class="lssaa-head" title="Ziehen zum Verschieben · Doppelklick setzt Position und Größe zurück">
        <span class="lssaa-logo">🚒</span>
        <span class="lssaa-title">
          <strong>Verbands-Bot<span class="lssaa-version">v${chrome.runtime.getManifest().version}</span></strong>
          <span class="lssaa-state"></span>
        </span>
        <span class="lssaa-spacer"></span>
        <button type="button" class="lssaa-icon lssaa-stats-btn" title="Auswertung: Einsätze &amp; Credits">📊</button>
        <button type="button" class="lssaa-icon lssaa-settings" title="Einstellungen">⚙</button>
        <button type="button" class="lssaa-icon lssaa-collapse" title="Ein-/Ausklappen">▾</button>
      </div>
      <div class="lssaa-body">
        <div class="lssaa-warning"></div>
        <div class="lssaa-controls">
          <button type="button" class="lssaa-toggle"></button>
          <div class="lssaa-speed" role="group" aria-label="Tempo">${speedButtons}</div>
          <div class="lssaa-speed-hint"></div>
        </div>
        <div class="lssaa-grid">
          <div class="lssaa-col">
            <div class="lssaa-kpis">
              <div class="lssaa-kpi"><b class="k-active">0</b><span>Einsätze aktiv</span></div>
              <div class="lssaa-kpi"><b class="k-hour">0</b><span>alarmiert (60 min)</span></div>
              <div class="lssaa-kpi"><b class="k-credits">–</b><span>Credits heute</span></div>
              <div class="lssaa-kpi"><b class="k-next">–</b><span>nächste Prüfung</span></div>
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

    // ---- Knöpfe ----
    $(".lssaa-toggle").addEventListener("click", () => chrome.storage.sync.set({ running: !settings.running }));
    for (const b of box.querySelectorAll("[data-speed]")) {
      b.addEventListener("click", () => {
        chrome.storage.sync.set(lssSpeedValues(b.dataset.speed));
        api.log(`Tempo: ${LSS_SPEEDS[b.dataset.speed].label} (${LSS_SPEEDS[b.dataset.speed].hint})`);
      });
    }
    $(".lssaa-stats-btn").addEventListener("click", () => window.open(chrome.runtime.getURL("stats.html"), "_blank"));
    $(".lssaa-diag").addEventListener("click", () => {
      $(".lssaa-logbox").open = true;
      diagnose();
    });
    $(".lssaa-now").addEventListener("click", () => {
      if (!settings.running) return api.log("Erst „Start“ drücken.");
      if (!roundRunning) schedule(0);
    });
    $(".lssaa-settings").addEventListener("click", () => window.open(chrome.runtime.getURL("options.html"), "_blank"));

    // ---- Verschieben (am Kopf ziehen) ----
    const place = (left, top) => {
      box.style.left = left + "px";
      box.style.top = top + "px";
      box.style.bottom = "auto";
    };
    function keepInView() {
      if (!box.style.top) return;
      const r = box.getBoundingClientRect();
      place(Math.min(Math.max(0, r.left), window.innerWidth - Math.min(r.width, 120)), Math.min(Math.max(0, r.top), window.innerHeight - 48));
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
    const MIN_W = 300;
    const MIN_H = 220;
    const resize = $(".lssaa-resize");
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = box.getBoundingClientRect();
      // Beim ersten Vergrößern an der aktuellen Position verankern (statt "bottom")
      place(r.left, r.top);
      const sx = e.clientX;
      const sy = e.clientY;
      box.classList.add("resizing");
      resize.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const w = Math.min(Math.max(MIN_W, r.width + ev.clientX - sx), window.innerWidth - r.left - 4);
        const h = Math.min(Math.max(MIN_H, r.height + ev.clientY - sy), window.innerHeight - r.top - 4);
        box.style.width = w + "px";
        box.style.height = h + "px";
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

    // ---- Tooltip für Diagramme ----
    const tip = $(".lssaa-tip");
    box.addEventListener("pointermove", (e) => {
      const t = e.target.closest("[data-tip]");
      if (!t) return (tip.hidden = true);
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const r = box.getBoundingClientRect();
      const x = Math.min(e.clientX - r.left + 12, r.width - tip.offsetWidth - 6);
      tip.style.left = Math.max(6, x) + "px";
      tip.style.top = e.clientY - r.top - tip.offsetHeight - 10 + "px";
    });
    box.addEventListener("pointerleave", () => (tip.hidden = true));

    // Countdown jede Sekunde
    setInterval(() => {
      $(".k-next").textContent = roundRunning
        ? "läuft…"
        : nextRoundAt
          ? Math.max(0, Math.round((nextRoundAt - Date.now()) / 1000)) + " s"
          : "–";
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
      const badge = $(".f-badge");
      badge.textContent = label;
      badge.className = "lssaa-badge f-badge " + cls;
      const meter = $(".f-meter i");
      meter.style.width = f.busyPct + "%";
      $(".f-meter").dataset.tip = `${f.busyPct} % der einsatzbereiten Fahrzeuge sind unterwegs oder vor Ort`;

      const stack = $(".f-stack");
      stack.replaceChildren();
      const legend = $(".f-legend");
      legend.replaceChildren();
      for (const [key, name, color] of FLEET_PARTS) {
        const n = f.counts[key];
        const pct = f.total ? (n / f.total) * 100 : 0;
        if (n) {
          const seg = document.createElement("i");
          seg.className = color;
          seg.style.flexGrow = n;
          seg.dataset.tip = `${name}: ${fmt(n)} Fahrzeuge (${Math.round(pct)} %)`;
          stack.appendChild(seg);
        }
        const li = document.createElement("li");
        li.innerHTML = `<i class="${color}"></i>${name} <b>${fmt(n)}</b>`;
        legend.appendChild(li);
      }
      const age = Math.round((Date.now() - at) / 1000);
      $(".f-foot").textContent = `${fmt(f.botVehicles)} Fahrzeuge fahren gerade für den Bot · Stand vor ${age < 60 ? age + " s" : Math.round(age / 60) + " min"}`;

      // Auswahl-Fahrzeuge gegen Reserve
      const freeAfterReserve = f.presetFree - settings.reserve;
      $(".p-free").textContent = fmt(f.presetFree);
      $(".p-sub").textContent = `frei von ${fmt(f.presetTotal)} passenden Fahrzeugen · Reserve ${settings.reserve}`;
      const pBadge = $(".p-badge");
      const [pl, pc] =
        f.presetTotal === 0
          ? ["⚠ keine passenden Fahrzeuge", "warn"]
          : freeAfterReserve <= 0
            ? ["⛔ nur noch Reserve", "crit"]
            : freeAfterReserve <= 2
              ? ["⚠ wird knapp", "warn"]
              : [`✓ ${freeAfterReserve} einsetzbar`, "good"];
      pBadge.textContent = pl;
      pBadge.className = "lssaa-badge p-badge " + pc;
      const pPct = f.presetTotal ? (f.presetFree / f.presetTotal) * 100 : 0;
      $(".p-meter i").style.width = pPct + "%";
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
      const sum = bins.reduce((a, b) => a + b, 0);
      $(".h-sum").textContent = `${sum} gesamt`;
    }

    const api = {
      update() {
        const waiting = settings.running && !haveLock;
        $(".lssaa-state").textContent = waiting ? "wartet (anderer Tab)" : settings.running ? "läuft" : "gestoppt";
        box.classList.toggle("running", settings.running && !waiting);
        $(".lssaa-toggle").textContent = settings.running ? "■  Stoppen" : "▶  Starten";
        const speed = settings.speed || lssSpeedOf(settings);
        for (const b of box.querySelectorAll("[data-speed]")) b.classList.toggle("on", b.dataset.speed === speed);
        $(".lssaa-speed-hint").textContent =
          speed in LSS_SPEEDS
            ? LSS_SPEEDS[speed].hint
            : `eigenes Tempo: alle ${settings.intervalSec} s, ${settings.maxPerRound || "beliebig viele"} je Prüfung`;
      },
      view({ active, lastHour, mine, total, bins, fleet, fleetError, fleetAt, creditsToday }) {
        $(".k-active").textContent = fmt(active);
        $(".k-hour").textContent = fmt(lastHour);
        $(".k-credits").textContent = creditsToday == null ? "–" : fmt(creditsToday);
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
          info.textContent = `${m.credits != null ? fmt(m.credits) + " Cr · " : ""}vor ${mins} min`;
          meta.append(badge, info);
          li.append(a, meta);
          list.appendChild(li);
        }
      },
      log(text) {
        const li = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
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
  loadCreditsToday();
  // Fuhrpark alle 90 s neu laden (nur wenn der Tab sichtbar ist oder der Bot läuft)
  setInterval(() => {
    if (!document.hidden || settings.running) loadFleet();
  }, 90 * 1000);
  // "vor x min" und Stand-Angaben weiterzählen
  setInterval(refreshView, 30 * 1000);

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
