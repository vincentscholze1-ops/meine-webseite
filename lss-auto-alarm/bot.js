// Läuft auf der Hauptseite des Leitstellenspiels.
// Schaut regelmäßig in die Liste der Verbandseinsätze und schickt zu jedem neuen Einsatz
// die voreingestellte Fahrzeugauswahl – innerhalb der Grenzen aus den Einstellungen.
(async () => {
  if (window.top !== window) return;

  let settings = await lssLoadSettings();
  let timer = null;
  let errors = 0;
  let haveLock = false;
  let lastSummary = "";
  const skipped = new Map(); // missionId -> Zeitpunkt, bis wann übersprungen wird
  const panel = createPanel();
  panel.log(`Geladen – ${listMissions().length} Verbandseinsätze in der Liste gefunden.`);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue === undefined ? LSS_DEFAULTS[key] : newValue;
    }
    if ("running" in changes) {
      errors = 0;
      settings.running ? schedule(2000) : stop();
    }
    panel.update();
  });

  // ---------- Hilfsfunktionen ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);

  function schedule(ms) {
    clearTimeout(timer);
    if (settings.running && haveLock) timer = setTimeout(round, ms);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
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

  function listMissions() {
    return [...document.querySelectorAll(settings.listSelector)].map((el) => {
      const id = el.getAttribute("mission_id") || el.id.replace(/^mission_/, "");
      const marker = el.querySelector(`#mission_participant_${id}`);
      const caption = el.querySelector(`#mission_caption_${id}`) || el.querySelector("a[id^=mission_caption_]");
      return {
        id,
        typeId: el.getAttribute("mission_type_id"),
        caption: (caption ? caption.textContent : "Einsatz " + id).replace(/\s+/g, " ").trim(),
        participating: !!marker && !marker.classList.contains("hidden")
      };
    });
  }

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
        const type = tr.getAttribute("vehicle_type") || LSS_TYPE_IDS[cb.getAttribute("vehicle_type_id")] || "";
        return { cb, type: type.trim(), km: parseKm(tr) };
      });

    if (!rows.length) return { ok: false, reason: "keine freien Fahrzeuge in der Einsatzseite gefunden" };

    const chosen = [];
    for (const item of settings.preset) {
      const fitting = rows.filter((r) => item.types.includes(r.type) && !chosen.includes(r));
      if (fitting.length < item.count) {
        const seen = [...new Set(rows.map((r) => r.type || "?"))].slice(0, 6).join(", ");
        return { ok: false, reason: `nicht genug freie ${item.types[0]} o.ä. (frei: ${seen})` };
      }
      chosen.push(...fitting.slice(0, item.count));
    }
    if (!chosen.length) return { ok: false, reason: "Auswahl ist leer" };

    const allTypes = new Set(settings.preset.flatMap((p) => p.types));
    const freeAfter = rows.filter((r) => allTypes.has(r.type)).length - chosen.length;
    if (freeAfter < settings.reserve) {
      return { ok: false, reason: `Reserve: nur noch ${freeAfter} frei` };
    }

    const farthest = Math.max(...chosen.map((r) => r.km ?? 0));
    if (farthest > settings.maxDistanceKm) {
      return { ok: false, reason: `zu weit (${farthest} km)` };
    }

    if (dryRun) {
      return {
        ok: true,
        dry: true,
        vehicles: chosen.map((r) => r.type).join(", "),
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
    return { ok: true, vehicles: chosen.map((r) => r.type).join(", "), km: farthest };
  }

  // ---------- Ein Durchgang ----------

  async function round() {
    if (!settings.running) return;
    const now = Date.now();
    try {
      const store = await chrome.storage.local.get(["sent", "history"]);
      const sent = store.sent || {};
      const history = (store.history || []).filter((t) => now - t < 3600 * 1000);
      const missions = listMissions();
      const inList = new Set(missions.map((m) => m.id));
      for (const id of Object.keys(sent)) if (!inList.has(id)) delete sent[id];
      for (const [id, until] of skipped) if (until < now || !inList.has(id)) skipped.delete(id);

      const active = missions.filter((m) => m.participating || sent[m.id]).length;
      let budget = Math.min(
        settings.maxPerRound,
        settings.maxActive - active,
        settings.maxPerHour - history.length
      );
      panel.status(`aktiv ${active}/${settings.maxActive} · letzte Stunde ${history.length}/${settings.maxPerHour}`);

      if (budget <= 0) {
        summarize(
          `Grenze erreicht (aktiv ${active}/${settings.maxActive}, Stunde ${history.length}/${settings.maxPerHour}) – warte.`
        );
      } else {
        const candidates = await findCandidates(missions, sent);
        if (!candidates.length) {
          const open = missions.filter((m) => !m.participating && !sent[m.id]).length;
          summarize(
            missions.length
              ? `Nichts zu tun: ${missions.length} Verbandseinsätze, ${missions.length - open} schon beteiligt, ` +
                  `${open} offen (gefiltert oder kürzlich übersprungen).`
              : "Keine Verbandseinsätze in der Liste gefunden."
          );
        }

        for (const mission of candidates) {
          if (budget <= 0 || !settings.running) break;
          const result = await dispatch(mission);
          if (result.ok) {
            sent[mission.id] = Date.now();
            history.push(Date.now());
            budget--;
            panel.log(`✔ ${mission.caption} (${mission.credits ?? "?"} Cr) ← ${result.vehicles}, ${result.km} km`);
          } else {
            skipped.set(mission.id, Date.now() + 10 * 60 * 1000);
            panel.log(`– ${mission.caption}: ${result.reason}`);
          }
          await sleep(jitter(3000));
        }
      }

      await chrome.storage.local.set({ sent, history });
      panel.status(
        `aktiv ${missions.filter((m) => m.participating || sent[m.id]).length}/${settings.maxActive}` +
          ` · letzte Stunde ${history.length}/${settings.maxPerHour}`
      );
      errors = 0;
    } catch (e) {
      errors++;
      panel.log(`⚠ ${e.message}`);
      console.warn("[LSS Auto-Alarm]", e);
      if (errors >= settings.maxErrors) {
        panel.log(`Gestoppt nach ${errors} Fehlern.`);
        chrome.storage.sync.set({ running: false });
        return;
      }
    }
    schedule(jitter(settings.intervalSec * 1000));
  }

  async function findCandidates(missions, sent) {
    const credits = await loadCredits();
    const exclude = settings.excludeMatch ? new RegExp(settings.excludeMatch, "i") : null;
    return missions
      .filter((m) => !m.participating && !sent[m.id] && !skipped.has(m.id))
      .filter((m) => !exclude || !exclude.test(m.caption))
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
      out(
        `Diagnose: ${missions.length} Verbandseinsätze, davon ${missions.filter((m) => m.participating).length} beteiligt` +
          ` · Lock: ${haveLock ? "ja" : "nein"} · Bot ${settings.running ? "läuft" : "gestoppt"}`
      );
      const { sent = {} } = await chrome.storage.local.get("sent");
      const candidates = await findCandidates(missions, sent);
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
    if (msg && msg.type === "lssaa-diagnose") {
      diagnose().then((lines) => sendResponse({ lines, panel: !!document.getElementById("lss-auto-alarm") }));
      return true;
    }
  });

  // ---------- Panel ----------

  function createPanel() {
    const box = document.createElement("div");
    box.id = "lss-auto-alarm";
    box.innerHTML = `
      <div class="lssaa-head">
        <span>Verbands-Bot <span class="lssaa-state"></span></span>
        <span>
          <button type="button" class="lssaa-diag" title="Probelauf ohne Alarmierung">Diagnose</button>
          <button type="button" class="lssaa-toggle"></button>
        </span>
      </div>
      <div class="lssaa-status"></div>
      <ul class="lssaa-log"></ul>`;
    document.body.appendChild(box);
    const state = box.querySelector(".lssaa-state");
    const toggle = box.querySelector(".lssaa-toggle");
    const statusEl = box.querySelector(".lssaa-status");
    const logEl = box.querySelector(".lssaa-log");
    toggle.addEventListener("click", () => chrome.storage.sync.set({ running: !settings.running }));
    box.querySelector(".lssaa-diag").addEventListener("click", () => diagnose());

    const api = {
      update() {
        const waiting = settings.running && !haveLock;
        state.textContent = waiting ? "(wartet – läuft in anderem Tab)" : settings.running ? "● läuft" : "○ gestoppt";
        state.className = "lssaa-state " + (settings.running ? "on" : "off");
        toggle.textContent = settings.running ? "Stopp" : "Start";
      },
      status(text) {
        statusEl.textContent = text;
      },
      log(text) {
        const li = document.createElement("li");
        li.textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " " + text;
        logEl.prepend(li);
        while (logEl.children.length > 8) logEl.lastChild.remove();
      }
    };
    api.update();
    return api;
  }

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
