// Läuft im Einsatzfenster (/missions/<id>) des Leitstellenspiels.
// Ablauf:
//   1. Bedarf ermitteln – aus der Fehlmeldung im Einsatz, sonst aus /einsaetze.json,
//      sonst aus der Standard-Einstellung.
//   2. Passende freie Fahrzeuge (nächste zuerst) anhaken.
//   3. Alarmiert wird erst, wenn du Alt+A drückst oder im Panel auf "Alarmieren" klickst.
(async () => {
  if (!document.querySelector(".vehicle_checkbox, #vehicle_show_table_all")) return;

  const settings = await lssLoadSettings();
  if (!settings.enabled) return;

  const categories = settings.categories.map((c) => ({ ...c, re: new RegExp(c.match, "i") }));
  const categoryById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const panel = createPanel();

  // ---------- Bedarf ermitteln ----------

  function parseMissingText() {
    const el = document.querySelector("#missing_text");
    if (!el || el.offsetParent === null) return null;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    const colon = text.indexOf(":");
    if (colon === -1) return null;

    const demand = [];
    const unknown = [];
    for (const part of text.slice(colon + 1).split(/,|\bund\b/)) {
      const m = part.trim().replace(/\.$/, "").match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const cat = categories.find((c) => c.re.test(m[2]));
      if (cat) demand.push({ category: cat.id, count: Number(m[1]) });
      else unknown.push(m[0]);
    }
    return { demand, unknown };
  }

  function getMissionTypeId() {
    const help = document.querySelector("#mission_help");
    const m = help && help.getAttribute("href").match(/einsaetze\/(\d+)/);
    return m ? m[1] : null;
  }

  async function loadRequirements(missionTypeId) {
    const cacheKey = "missionRequirements";
    const cached = await chrome.storage.local.get(cacheKey);
    let entry = cached[cacheKey];
    if (!entry || Date.now() - entry.time > 24 * 3600 * 1000) {
      const res = await fetch("/einsaetze.json", { credentials: "include" });
      if (!res.ok) throw new Error("einsaetze.json: HTTP " + res.status);
      const list = await res.json();
      const byId = {};
      for (const mission of list) byId[mission.id] = mission.requirements || {};
      entry = { time: Date.now(), byId };
      await chrome.storage.local.set({ [cacheKey]: entry });
    }
    return entry.byId[missionTypeId] || null;
  }

  function vehiclesAlreadyAssigned() {
    return document.querySelectorAll(
      "#mission_vehicle_driving tbody tr, #mission_vehicle_at_mission tbody tr"
    ).length;
  }

  async function determineDemand() {
    const missing = parseMissingText();
    if (missing) return { source: "Fehlmeldung im Einsatz", ...missing };

    // Ohne Fehlmeldung, aber mit Fahrzeugen auf Anfahrt: lieber nichts nachschicken.
    if (vehiclesAlreadyAssigned() > 0) {
      return { source: "Fahrzeuge bereits unterwegs – warte auf Rückmeldung", demand: [], unknown: [] };
    }

    const typeId = getMissionTypeId();
    if (typeId) {
      try {
        const req = await loadRequirements(typeId);
        if (req) {
          const demand = [];
          const unknown = [];
          for (const [key, count] of Object.entries(req)) {
            const catId = settings.requirementMap[key];
            if (!count) continue;
            if (catId && categoryById[catId]) demand.push({ category: catId, count: Number(count) });
            else unknown.push(`${count}× ${key}`);
          }
          if (demand.length) return { source: "Einsatzanforderung", demand, unknown };
        }
      } catch (e) {
        console.warn("[LSS Auto-Alarm]", e);
      }
    }
    return { source: "Standard", demand: settings.fallback, unknown: [] };
  }

  // ---------- Fahrzeuge auswählen ----------

  function vehicleRows() {
    const boxes = document.querySelectorAll("#vehicle_show_table_all input.vehicle_checkbox, input.vehicle_checkbox");
    const seen = new Set();
    const rows = [];
    for (const cb of boxes) {
      if (seen.has(cb)) continue;
      seen.add(cb);
      const tr = cb.closest("tr");
      const type =
        (tr && tr.getAttribute("vehicle_type")) ||
        cb.getAttribute("vehicle_type") ||
        LSS_TYPE_IDS[cb.getAttribute("vehicle_type_id")] ||
        "";
      rows.push({ cb, tr, type: type.trim() });
    }
    return rows; // Reihenfolge der Tabelle = nach Entfernung sortiert
  }

  function select(demand) {
    const rows = vehicleRows();
    const used = new Set();
    const result = [];

    // Bereits angehakte Fahrzeuge (z.B. per AAO) werden angerechnet.
    const preChecked = rows.filter((r) => r.cb.checked);

    for (const { category, count } of demand) {
      const cat = categoryById[category];
      if (!cat) continue;
      let have = 0;

      for (const r of preChecked) {
        if (have >= count) break;
        if (!used.has(r.cb) && cat.types.includes(r.type)) {
          used.add(r.cb);
          have++;
        }
      }
      // Nach Wunsch-Reihenfolge der Typen, innerhalb eines Typs das nächste Fahrzeug
      for (const type of cat.types) {
        for (const r of rows) {
          if (have >= count) break;
          if (used.has(r.cb) || r.cb.checked || r.cb.disabled || r.type !== type) continue;
          r.cb.click(); // click() statt checked=true, damit das Spiel seine Zähler aktualisiert
          used.add(r.cb);
          have++;
        }
      }
      result.push({ label: cat.label, count, have });
    }
    return result;
  }

  function clearOwnSelection() {
    for (const cb of document.querySelectorAll("input.vehicle_checkbox[data-lss-auto]")) {
      if (cb.checked) cb.click();
      cb.removeAttribute("data-lss-auto");
    }
  }

  async function run() {
    clearOwnSelection();
    const before = new Set(vehicleRows().filter((r) => r.cb.checked).map((r) => r.cb));
    const { source, demand, unknown } = await determineDemand();
    const result = select(demand);
    for (const r of vehicleRows()) {
      if (r.cb.checked && !before.has(r.cb)) r.cb.setAttribute("data-lss-auto", "1");
    }
    panel.render(source, result, unknown);
  }

  // ---------- Alarmieren ----------

  function alarm() {
    const selector = settings.alarmAndNext
      ? ".alert_next, #alert_next_btn, #mission_alarm_btn"
      : "#mission_alarm_btn, input[type=submit][value*='Alarmieren']";
    const btn = document.querySelector(selector);
    if (btn) btn.click();
    else panel.flash("Alarmieren-Knopf nicht gefunden");
  }

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest("input[type=text], textarea, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if (key === settings.alarmKey) {
      e.preventDefault();
      alarm();
    } else if (key === settings.reselectKey) {
      e.preventDefault();
      run();
    }
  });

  // ---------- Panel ----------

  function createPanel() {
    const box = document.createElement("div");
    box.id = "lss-auto-alarm";
    box.innerHTML = `
      <div class="lssaa-head">Auto-Alarmierung <span class="lssaa-src"></span></div>
      <ul class="lssaa-list"></ul>
      <div class="lssaa-msg"></div>
      <div class="lssaa-actions">
        <button type="button" class="lssaa-reselect" title="Alt+${settings.reselectKey.toUpperCase()}">Neu berechnen</button>
        <button type="button" class="lssaa-alarm" title="Alt+${settings.alarmKey.toUpperCase()}">Alarmieren</button>
      </div>`;
    document.body.appendChild(box);
    box.querySelector(".lssaa-reselect").addEventListener("click", run);
    box.querySelector(".lssaa-alarm").addEventListener("click", alarm);

    const list = box.querySelector(".lssaa-list");
    const msg = box.querySelector(".lssaa-msg");
    return {
      render(source, result, unknown) {
        box.querySelector(".lssaa-src").textContent = `(${source})`;
        list.replaceChildren();
        for (const r of result) {
          const li = document.createElement("li");
          li.className = r.have >= r.count ? "ok" : "missing";
          li.textContent = `${r.have}/${r.count} ${r.label}`;
          list.appendChild(li);
        }
        for (const u of unknown) {
          const li = document.createElement("li");
          li.className = "unknown";
          li.textContent = `? ${u} (keine Kategorie)`;
          list.appendChild(li);
        }
        msg.textContent = result.length || unknown.length ? "" : "Nichts zu alarmieren.";
      },
      flash(text) {
        msg.textContent = text;
      }
    };
  }

  if (settings.autoSelect) run();
  else panel.flash("Automatisches Anhaken ist aus – Alt+" + settings.reselectKey.toUpperCase() + " zum Auswählen.");
})();
