const $ = (id) => document.getElementById(id);
let s = null;

// Schieberegler: [Schlüssel, min, max, Schritt, Titel, Erklärung, Einheit, Text für 0]
const LIMITS = [
  ["maxDistanceKm", 1, 200, 1, "Maximale Entfernung", "Weiter entfernte Einsätze werden ausgelassen. Credits gibt es nur, wenn dein Fahrzeug vor Einsatzende ankommt.", " km"],
  ["reserve", 0, 30, 1, "Reserve für eigene Einsätze", "So viele passende Fahrzeuge bleiben immer frei.", " Fzg."]
];
const FILTERS = [["minCredits", 0, 20000, 250, "Mindest-Credits", "Nur Einsätze, die im Schnitt mindestens so viel bringen.", " Cr", "alle"]];
const ADVANCED = [
  ["maxActive", 0, 100, 1, "Obergrenze gleichzeitig", "Höchstens so viele laufende Einsätze gleichzeitig. Ganz links = unbegrenzt.", "", "unbegrenzt"],
  ["maxPerRound", 0, 20, 1, "Obergrenze pro Prüfung", "Höchstens so viele neue Einsätze auf einmal. Ganz links = unbegrenzt.", "", "unbegrenzt"],
  ["maxErrors", 1, 20, 1, "Stopp nach Fehlern", "Nach so vielen Fehlern hintereinander hält der Bot an (z.B. wenn du ausgeloggt wirst).", ""]
];

// Zahlenfelder: [Schlüssel, min, max, Titel, Erklärung, Einheit, leer/0 erlaubt (= unbegrenzt)]
const TEMPO = [
  ["intervalSec", 20, 3600, "Einsätze abfragen alle", "Wie oft der Bot die Einsatzlisten prüft (mit etwas Zufall, mindestens 20 Sekunden).", "Sekunden", false],
  ["maxPerHour", 0, 1000, "Alarmierungen pro Stunde", "Höchstens so viele Einsätze pro Stunde. Leer lassen oder 0 = unbegrenzt.", "pro Stunde", true]
];

const QUICK = {
  "🚒 Löschfahrzeug": LSS_VEHICLE_GROUPS["Löschfahrzeuge"],
  "🚑 RTW": ["RTW"],
  "🚓 Streifenwagen": ["FuStW", "FuStW (DGL)"],
  "🚚 THW GKW": ["GKW"]
};

// ---------- Speichern ----------

let saveTimer = null;
let pending = {};
function save(partial) {
  Object.assign(s, partial);
  Object.assign(pending, partial);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const batch = pending;
    pending = {};
    chrome.storage.sync.set(batch, () => {
      const el = $("saved");
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 1200);
    });
  }, 250);
  renderSummary();
}

// ---------- Zusammenfassung ----------

function presetText(preset) {
  if (!preset || !preset.length) return "nichts (Auswahl ist leer!)";
  return preset
    .map((p) => {
      const t = p.types.length > 3 ? `${p.types.slice(0, 3).join("/")} und ähnliche` : p.types.join("/") || "?";
      return `${p.count}× ${t}`;
    })
    .join(" + ");
}

function renderSummary() {
  const lists = Object.keys(LSS_LISTS).filter((k) => s.lists[k]).map((k) => LSS_LISTS[k][1]);
  const parts = [];
  parts.push(
    lists.length
      ? `Alle ca. <b>${s.intervalSec} Sekunden</b> prüft der Bot: ${lists.join(", ")}.`
      : `<b>Keine Einsatzliste gewählt – der Bot tut nichts.</b>`
  );
  parts.push(`Er schickt <b>${presetText(s.preset)}</b>` + (s.presetPlanned ? `, zu geplanten Einsätzen <b>${presetText(s.presetPlanned)}</b>.` : "."));
  parts.push(s.maxPerHour > 0 ? `Höchstens <b>${s.maxPerHour}</b> Alarmierungen pro Stunde.` : `Alarmierungen pro Stunde: <b>unbegrenzt</b>.`);
  parts.push(`Nur Einsätze bis <b>${s.maxDistanceKm} km</b>, und <b>${s.reserve}</b> passende Fahrzeuge bleiben immer frei.`);
  const caps = [
    s.maxActive > 0 && `${s.maxActive} gleichzeitig`,
    s.maxPerRound > 0 && `${s.maxPerRound} pro Prüfung`
  ].filter(Boolean);
  if (caps.length) parts.push(`Obergrenzen: ${caps.join(", ")}.`);
  if (s.minCredits > 0) parts.push(`Nur Einsätze ab <b>${s.minCredits} Credits</b>.`);
  if (s.excludeWords.length) parts.push(`Übersprungen wird: ${s.excludeWords.join(", ")}.`);
  $("summary").innerHTML = parts.join(" ");
}

// ---------- Einsatzlisten ----------

function renderLists() {
  const box = $("lists");
  box.replaceChildren();
  const hints = {
    alliance: "Normale Einsätze deiner Verbandsmitglieder.",
    alliance_event: "Große Lagen und Event-Einsätze im Verband.",
    sicherheitswache: "Deine geplanten Einsätze. Fahrzeuge werden schon vor Beginn hingeschickt.",
    sicherheitswache_alliance: "Geplante Einsätze, die im Verband freigegeben sind."
  };
  for (const [key, [, label]] of Object.entries(LSS_LISTS)) {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox"><span>${label}<small>${hints[key] || ""}</small></span>`;
    const cb = l.querySelector("input");
    cb.checked = !!s.lists[key];
    cb.addEventListener("change", () => save({ lists: { ...s.lists, [key]: cb.checked } }));
    box.appendChild(l);
  }
}

// ---------- Fahrzeugauswahl ----------

function renderPreset(containerId, key) {
  const box = $(containerId);
  box.replaceChildren();
  const preset = s[key];
  const commit = () => {
    save({ [key]: preset });
    renderPreset(containerId, key);
  };

  preset.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "vrow";
    el.innerHTML = `
      <div class="vrow-head">
        <span class="stepper"><button type="button" data-d="-1">−</button><span>${row.count}</span><button type="button" data-d="1">+</button></span>
        <span class="chosen">${row.types.length ? "aus: <b>" + row.types.join(", ") + "</b>" : "<b>noch kein Typ gewählt</b>"}</span>
        ${preset.length > 1 ? '<button type="button" class="icon" title="Zeile entfernen">✕ entfernen</button>' : ""}
      </div>
      <details class="types"${row.types.length ? "" : " open"}><summary>Fahrzeugtypen wählen</summary></details>`;
    for (const b of el.querySelectorAll(".stepper button")) {
      b.addEventListener("click", () => {
        row.count = Math.max(1, Math.min(20, row.count + Number(b.dataset.d)));
        commit();
      });
    }
    const rm = el.querySelector(".icon");
    if (rm) rm.addEventListener("click", () => {
      preset.splice(i, 1);
      commit();
    });

    const details = el.querySelector("details");
    const quick = document.createElement("div");
    quick.className = "quick";
    for (const [label, types] of Object.entries(QUICK)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = label;
      b.title = types.join(", ");
      b.addEventListener("click", () => {
        row.types = [...types];
        commit();
      });
      quick.appendChild(b);
    }
    details.appendChild(quick);

    const known = new Set(Object.values(LSS_VEHICLE_GROUPS).flat());
    const groups = { ...LSS_VEHICLE_GROUPS };
    const custom = row.types.filter((t) => !known.has(t));
    if (custom.length) groups["Eigene"] = custom;
    for (const [g, types] of Object.entries(groups)) {
      const gEl = document.createElement("div");
      gEl.className = "group";
      gEl.innerHTML = `<div class="group-title">${g}</div><div class="chips"></div>`;
      for (const t of types) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "chip" + (row.types.includes(t) ? " on" : "");
        c.textContent = t;
        c.addEventListener("click", () => {
          row.types = row.types.includes(t) ? row.types.filter((x) => x !== t) : [...row.types, t];
          save({ [key]: preset });
          c.classList.toggle("on");
          el.querySelector(".chosen").innerHTML = row.types.length
            ? "aus: <b>" + row.types.join(", ") + "</b>"
            : "<b>noch kein Typ gewählt</b>";
        });
        gEl.querySelector(".chips").appendChild(c);
      }
      details.appendChild(gEl);
    }
    const own = document.createElement("div");
    own.className = "group";
    own.innerHTML = `<div class="group-title">Typ fehlt? Genau wie im Spiel eintippen und Enter drücken</div><input type="text" placeholder="z.B. AB-Rüst">`;
    own.querySelector("input").addEventListener("keydown", (e) => {
      const v = e.target.value.trim();
      if (e.key !== "Enter" || !v) return;
      if (!row.types.includes(v)) row.types.push(v);
      commit();
    });
    details.appendChild(own);
    box.appendChild(el);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "+ weitere Fahrzeugzeile";
  add.addEventListener("click", () => {
    preset.push({ count: 1, types: [] });
    commit();
  });
  box.appendChild(add);
}

// ---------- Schieberegler ----------

function renderSliders(containerId, specs) {
  const box = $(containerId);
  box.replaceChildren();
  for (const [key, min, max, step, title, hint, unit, zeroText] of specs) {
    const el = document.createElement("div");
    el.className = "slider";
    el.innerHTML = `<label for="sl-${key}">${title}</label><output></output>
      <input type="range" id="sl-${key}" min="${min}" max="${max}" step="${step}"><small>${hint}</small>`;
    const input = el.querySelector("input");
    const out = el.querySelector("output");
    input.value = s[key];
    const show = () => (out.textContent = zeroText && +input.value === 0 ? zeroText : input.value + unit);
    show();
    input.addEventListener("input", () => {
      show();
      save({ [key]: Number(input.value) });
    });
    box.appendChild(el);
  }
}

// ---------- Zahlenfelder ----------

function renderNumbers(containerId, specs) {
  const box = $(containerId);
  box.replaceChildren();
  for (const [key, min, max, title, hint, unit, zeroAllowed] of specs) {
    const el = document.createElement("div");
    el.className = "number";
    el.innerHTML = `<label for="nr-${key}">${title}</label>
      <span class="number-input"><input type="number" id="nr-${key}" min="${min}" max="${max}" step="1"
        ${zeroAllowed ? 'placeholder="unbegrenzt"' : ""}><span>${unit}</span></span>
      <small>${hint}</small><small class="error" hidden></small>`;
    const input = el.querySelector("input");
    const error = el.querySelector(".error");
    input.value = zeroAllowed && !s[key] ? "" : s[key];
    const check = (final) => {
      const raw = input.value.trim();
      let value = raw === "" && zeroAllowed ? 0 : Math.round(Number(raw));
      let msg = "";
      if (raw === "" && !zeroAllowed) msg = "Bitte eine Zahl eingeben.";
      else if (!Number.isFinite(value)) msg = "Bitte eine ganze Zahl eingeben.";
      else if (!(zeroAllowed && value === 0) && (value < min || value > max)) msg = `Erlaubt: ${min}–${max}.`;
      if (msg && final) {
        // beim Verlassen des Feldes auf den nächsten gültigen Wert setzen
        value = Number.isFinite(value) && raw !== "" ? Math.min(max, Math.max(min, value)) : s[key];
        input.value = zeroAllowed && !value ? "" : value;
        msg = "";
      }
      error.hidden = !msg;
      error.textContent = msg;
      if (!msg && value !== s[key]) save({ [key]: value });
    };
    input.addEventListener("input", () => check(false));
    input.addEventListener("change", () => check(true));
    box.appendChild(el);
  }
}

// ---------- Aufbau ----------

function render() {
  if (!Array.isArray(s.excludeWords)) s.excludeWords = [];
  s.lists = { ...LSS_DEFAULTS.lists, ...(s.lists || {}) };
  renderLists();
  renderPreset("preset", "preset");
  $("plannedOwn").checked = !!s.presetPlanned;
  $("presetPlannedBox").hidden = !s.presetPlanned;
  if (s.presetPlanned) renderPreset("presetPlanned", "presetPlanned");
  renderNumbers("tempo", TEMPO);
  renderSliders("limits", LIMITS);
  renderSliders("filters", FILTERS);
  renderSliders("advanced", ADVANCED);
  $("allowUnknownCredits").checked = s.allowUnknownCredits;
  $("excludeWords").value = s.excludeWords.join(", ");
  renderSummary();
}

$("plannedOwn").addEventListener("change", (e) => {
  const value = e.target.checked ? JSON.parse(JSON.stringify(s.preset)) : null;
  save({ presetPlanned: value });
  $("presetPlannedBox").hidden = !value;
  if (value) renderPreset("presetPlanned", "presetPlanned");
});
$("allowUnknownCredits").addEventListener("change", (e) => save({ allowUnknownCredits: e.target.checked }));
$("excludeWords").addEventListener("input", (e) =>
  save({ excludeWords: e.target.value.split(",").map((w) => w.trim()).filter(Boolean) })
);
$("reset").addEventListener("click", () => {
  if (!confirm("Alle Einstellungen auf Standard zurücksetzen?")) return;
  const running = s.running;
  chrome.storage.sync.clear(() => {
    chrome.storage.sync.set({ running });
    s = JSON.parse(JSON.stringify({ ...LSS_DEFAULTS, running }));
    render();
  });
});

lssLoadSettings().then((loaded) => {
  s = loaded;
  render();
});
