/**
 * popup.js
 * UI del popup: arrancar/parar grabación, mostrar pasos en vivo,
 * listar casos guardados y exportarlos a JSON (uno o todos).
 */

const STORAGE_KEY = "recorderState";

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),

  setupView: document.getElementById("setupView"),
  recordingView: document.getElementById("recordingView"),

  titleInput: document.getElementById("titleInput"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),

  recordingTitle: document.getElementById("recordingTitle"),
  recordingScope: document.getElementById("recordingScope"),
  liveSteps: document.getElementById("liveSteps"),

  casesList: document.getElementById("casesList"),
  emptyMsg: document.getElementById("emptyMsg"),
  exportAllBtn: document.getElementById("exportAllBtn"),

  caseCardTemplate: document.getElementById("caseCardTemplate")
};

const scopeLabels = { tab: "Esta pestaña", window: "Toda la ventana" };

// ---------- Render ----------

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function buildResultsSummary(ev) {
  const r = ev.results;
  if (!r) return null;
  const parts = [];
  if (r.network && r.network.length) {
    const withError = r.network.filter((n) => n.error || (n.statusCode && n.statusCode >= 400)).length;
    parts.push(`🌐 ${r.network.length} petición${r.network.length === 1 ? "" : "es"}${withError ? ` (${withError} con error)` : ""}`);
  }
  if (r.console && r.console.length) {
    const warnErr = r.console.filter((c) => c.level === "error" || c.level === "warn").length;
    parts.push(`🖥 ${r.console.length} consola${warnErr ? ` (${warnErr} aviso/err)` : ""}`);
  }
  if (r.errors && r.errors.length) {
    parts.push(`⚠ ${r.errors.length} error${r.errors.length === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function renderStepItem(ev) {
  const li = document.createElement("li");
  li.className = "step-item";

  const num = document.createElement("span");
  num.className = "step-num";
  num.textContent = ev.step + ".";

  const body = document.createElement("div");
  body.className = "step-body";

  const descRow = document.createElement("div");
  descRow.className = "step-desc-row";

  const desc = document.createElement("span");
  desc.className = "step-desc";
  desc.textContent = ev.description;
  if (ev.masked) desc.classList.add("masked");

  const time = document.createElement("span");
  time.className = "step-time";
  time.textContent = formatTime(ev.timestamp);

  descRow.appendChild(desc);
  descRow.appendChild(time);
  body.appendChild(descRow);

  const summary = buildResultsSummary(ev);
  if (summary) {
    const sumEl = document.createElement("span");
    sumEl.className = "step-results-summary";
    sumEl.textContent = summary;
    body.appendChild(sumEl);
  }

  li.appendChild(num);
  li.appendChild(body);
  return li;
}

function renderLiveSteps(currentCase) {
  els.liveSteps.innerHTML = "";
  if (!currentCase) return;
  currentCase.events.forEach((ev) => {
    els.liveSteps.appendChild(renderStepItem(ev));
  });
  els.liveSteps.scrollTop = els.liveSteps.scrollHeight;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function renderCasesList(savedCases) {
  els.casesList.querySelectorAll(".case-card").forEach((n) => n.remove());
  els.emptyMsg.style.display = savedCases.length === 0 ? "block" : "none";

  // Más recientes primero
  [...savedCases].reverse().forEach((c) => {
    const node = els.caseCardTemplate.content.cloneNode(true);
    const card = node.querySelector(".case-card");
    card.dataset.caseId = c.id;

    node.querySelector(".case-title").textContent = c.title;
    node.querySelector(".case-meta").textContent =
      `${c.events.length} pasos · ${scopeLabels[c.scope] || c.scope} · ${formatDate(c.startedAt)}`;

    const stepsEl = node.querySelector(".case-steps");
    c.events.forEach((ev) => stepsEl.appendChild(renderStepItem(ev)));

    node.querySelector(".view-btn").addEventListener("click", () => {
      stepsEl.classList.toggle("hidden");
    });

    node.querySelector(".export-btn").addEventListener("click", () => {
      exportCasesToFile([c], slug(c.title));
    });

    node.querySelector(".delete-btn").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar el caso "${c.title}"?`)) return;
      await browser.runtime.sendMessage({ action: "DELETE_CASE", caseId: c.id });
      await refresh();
    });

    els.casesList.appendChild(node);
  });
}

function renderAll(state) {
  const recording = !!state.isRecording;

  els.statusDot.classList.toggle("active", recording);
  els.statusText.textContent = recording ? "Grabando" : "Inactivo";

  els.setupView.classList.toggle("hidden", recording);
  els.recordingView.classList.toggle("hidden", !recording);

  if (recording && state.currentCase) {
    els.recordingTitle.textContent = state.currentCase.title;
    els.recordingScope.textContent = scopeLabels[state.scope] || state.scope;
    renderLiveSteps(state.currentCase);
  }

  renderCasesList(state.savedCases || []);
}

// ---------- Acciones ----------

async function refresh() {
  // console.log('refresh antes de mandar sendMessage');
  const state = await browser.runtime.sendMessage({ action: "GET_FULL_STATE" });
  renderAll(state);
  return state;
}

els.startBtn.addEventListener("click", async () => {
  const title = els.titleInput.value.trim();
  if (!title) {
    els.titleInput.focus();
    els.titleInput.style.borderColor = "var(--accent-rec)";
    return;
  }
  const scope = document.querySelector('input[name="scope"]:checked').value;

  els.startBtn.disabled = true;
  try {
    console.log('se envia a start recording');
    await browser.runtime.sendMessage({ action: "START_RECORDING", payload: { title, scope } });
    els.titleInput.value = "";
    await refresh();
  } finally {
    els.startBtn.disabled = false;
  }
});

els.stopBtn.addEventListener("click", async () => {
  els.stopBtn.disabled = true;
  try {
    await browser.runtime.sendMessage({ action: "STOP_RECORDING" });
    await refresh();
  } finally {
    els.stopBtn.disabled = false;
  }
});

els.exportAllBtn.addEventListener("click", async () => {
  const state = await refresh();
  if (!state.savedCases || state.savedCases.length === 0) {
    // alert("No hay casos guardados todavía.");
    return;
  }
  exportCasesToFile(state.savedCases, "casos-de-uso");
});

// ---------- Exportación a JSON ----------

function slug(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "caso";
}

function exportCasesToFile(casesArray, filenameBase) {
  // Cada caso queda claramente separado por su propio "title" dentro del JSON.
  const payload = {
    exportedAt: new Date().toISOString(),
    totalCases: casesArray.length,
    cases: casesArray.map((c) => ({
      title: c.title,
      scope: c.scope,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      totalSteps: c.events.length,
      steps: c.events.map((ev) => ({
        step: ev.step,
        type: ev.type,
        description: ev.description,
        value: ev.value !== undefined ? ev.value : null,
        masked: !!ev.masked,
        selector: ev.selector || null,
        url: ev.url || null,
        timestamp: ev.timestamp,
        results: {
          network: (ev.results && ev.results.network) || [],
          console: (ev.results && ev.results.console) || [],
          errors: (ev.results && ev.results.errors) || []
        }
      }))
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Sincronización en vivo mientras el popup está abierto ----------

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  renderAll(changes[STORAGE_KEY].newValue);
});

refresh();
