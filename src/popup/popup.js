// ─── UrdReplay · Popup ───────────────────────────────────────────────────────
'use strict';

// ── Estado ────────────────────────────────────────────────────────────────
let allEvents  = [];   // array combinado ordenado por timestamp
let activeTab  = 'all';
let capturing  = false;
let recording  = false;   // refleja si la recorder page está grabando

// ── Referencias DOM ───────────────────────────────────────────────────────
const btnCapture   = document.getElementById('btn-capture');
const btnCaptureT  = document.getElementById('btn-capture-text');
const captureBadge = document.getElementById('capture-badge');
const btnRecord   = document.getElementById('btn-record');
const btnRecordT  = document.getElementById('btn-record-text');
const recordBadge = document.getElementById('record-badge');
const btnExport    = document.getElementById('btn-export');
const btnClear     = document.getElementById('btn-clear');
const eventsList   = document.getElementById('events-list');
const emptyState   = document.getElementById('empty-state');
const btnIconPlay  = document.querySelector('.btn-icon-play');
const btnIconStop  = document.querySelector('.btn-icon-stop');

const countErrors    = document.getElementById('count-errors');
const countWarns     = document.getElementById('count-warns');
const countNet       = document.getElementById('count-net');
const countNetErrors = document.getElementById('count-net-errors');

// ── Inicialización ────────────────────────────────────────────────────────
(async function init() {
  const state = await bg('GET_STATE');
  capturing   = state.capturing;

  // Combinar y ordenar eventos
  allEvents = [
    ...state.consoleEvents.map(e => ({ ...e, _source: 'console' })),
    ...state.networkEvents.map(e => ({ ...e, _source: 'network' })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  updateCaptureUI();
  renderEvents();
  updateCounters();
})();

// ── Escuchar eventos en tiempo real ───────────────────────────────────────
browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'CONSOLE_EVENT') {
    const e = { ...msg.event, _source: 'console' };
    allEvents.unshift(e);
    renderEvents();
    updateCounters();
  }
  if (msg.type === 'NETWORK_EVENT') {
    const e = { ...msg.event, _source: 'network' };
    const idx = allEvents.findIndex(x => x.id === e.id && x._source === 'network');
    if (idx >= 0) allEvents[idx] = e;
    else          allEvents.unshift(e);
    renderEvents();
    updateCounters();
  }
  if (msg.type === 'RECORDING_STATE') {
    recording = msg.value;
    updateRecordUI();
  }
});

// ── Captura toggle ────────────────────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  capturing = !capturing;
  // Obtener la pestaña activa para filtrar solo sus eventos
  let tabId = null;
  if (capturing) {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
  }
  await bg('SET_CAPTURING', { value: capturing, tabId });
  updateCaptureUI();
});

function updateCaptureUI() {
  if (capturing) {
    btnCapture.classList.add('active');
    btnCaptureT.textContent = 'Detener captura';
    btnIconPlay.style.display = 'none';
    btnIconStop.style.display = '';
    captureBadge.className    = 'badge badge-on';
    captureBadge.textContent  = 'on';
  } else {
    btnCapture.classList.remove('active');
    btnCaptureT.textContent = 'Iniciar captura';
    btnIconPlay.style.display = '';
    btnIconStop.style.display = 'none';
    captureBadge.className   = 'badge badge-off';
    captureBadge.textContent = 'off';
  }
}

function updateRecordUI() {
  if (recording) {
    btnRecord.classList.add('active');
    btnRecordT.textContent  = 'Ver grabación →';
    recordBadge.className   = 'badge badge-rec';
    recordBadge.textContent = 'rec';
  } else {
    btnRecord.classList.remove('active');
    btnRecordT.textContent  = 'Grabar pantalla';
    recordBadge.className   = 'badge badge-off';
    recordBadge.textContent = 'off';
  }
}

// ── Grabación de pantalla → abre tab dedicada ─────────────────────────────
btnRecord.addEventListener('click', openRecorder);

async function openRecorder() {
  // Si ya hay una tab del recorder abierta, la enfoca en vez de abrir otra
  const recUrl = browser.runtime.getURL('src/recorder/recorder.html');
  const tabs   = await browser.tabs.query({});
  const existing = tabs.find(t => t.url === recUrl);

  if (existing) {
    browser.tabs.update(existing.id, { active: true });
    browser.windows.update(existing.windowId, { focused: true });
  } else {
    browser.tabs.create({ url: recUrl });
  }

  window.close(); // cerrar el popup para que el usuario vea la tab
}

// ── Exportar JSON ─────────────────────────────────────────────────────────
btnExport.addEventListener('click', async () => {
  const { data } = await bg('EXPORT_JSON');
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href     = url;
  a.download = `devjam-${ts}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ── Limpiar ───────────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  await bg('CLEAR_EVENTS');
  allEvents = [];
  renderEvents();
  updateCounters();
});

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    renderEvents();
  });
});

// ── Renderizado ───────────────────────────────────────────────────────────
function renderEvents() {
  const filtered = filterEvents(allEvents);

  if (filtered.length === 0) {
    eventsList.innerHTML = '';
    eventsList.appendChild(emptyState);
    emptyState.querySelector('p').textContent =
      allEvents.length === 0
        ? 'Inicia la captura para ver eventos.'
        : 'No hay eventos en esta categoría.';
    return;
  }

  const MAX_RENDER = 100;
  const rows = filtered.slice(0, MAX_RENDER).map(buildRow).join('');
  eventsList.innerHTML = rows;
}

function filterEvents(events) {
  switch (activeTab) {
    case 'error':
      return events.filter(e =>
        e.severity === 'error' || e.level === 'error' || e.level === 'assert');
    case 'network':
      return events.filter(e => e._source === 'network');
    case 'console':
      return events.filter(e => e._source === 'console');
    default:
      return events;
  }
}

function buildRow(event) {
  if (event._source === 'network') return buildNetworkRow(event);
  return buildConsoleRow(event);
}

function buildConsoleRow(e) {
  const sev   = severityClass(e.level);
  const time  = formatTime(e.timestamp);
  const label = (e.level || 'log').toUpperCase();
  const msg   = escHtml(e.message ?? '');
  return `
  <div class="event-row">
    <div class="event-severity ${sev}"></div>
    <div class="event-body">
      <div class="event-meta">
        <span class="event-type">${label}</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-message">${msg}</div>
    </div>
  </div>`;
}

function buildNetworkRow(e) {
  const sev       = e.severity === 'error' ? 'sev-error'
                  : e.severity === 'warn'  ? 'sev-warn'
                  : 'sev-ok';
  const statusCls = e.status >= 500 ? 'status-error'
                  : e.status >= 400 ? 'status-warn'
                  : e.status === 0  ? 'status-error'
                  : 'status-ok';
  const statusTxt = e.error ?? (e.status || '---');
  const time      = formatTime(e.timestamp);
  const url       = escHtml(shortUrl(e.url ?? ''));
  const dur       = e.duration ? `${e.duration}ms` : '';
  return `
  <div class="event-row">
    <div class="event-severity ${sev}"></div>
    <div class="event-body">
      <div class="event-meta">
        <span class="event-method">${e.method ?? 'GET'}</span>
        <span class="event-status ${statusCls}">${statusTxt}</span>
        <span class="event-duration">${dur}</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-url">${url}</div>
    </div>
  </div>`;
}

// ── Contadores ────────────────────────────────────────────────────────────
function updateCounters() {
  const errors    = allEvents.filter(e => e.level === 'error' || e.level === 'assert' || (e._source === 'network' && e.status >= 500)).length;
  const warns     = allEvents.filter(e => e.level === 'warn'  || (e._source === 'network' && e.status >= 400 && e.status < 500)).length;
  const net       = allEvents.filter(e => e._source === 'network').length;
  const netErrors = allEvents.filter(e => e._source === 'network' && (e.status === 0 || e.status >= 400)).length;

  countErrors.textContent    = errors;
  countWarns.textContent     = warns;
  countNet.textContent       = net;
  countNetErrors.textContent = netErrors;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function severityClass(level) {
  switch (level) {
    case 'error':
    case 'assert': return 'sev-error';
    case 'warn':   return 'sev-warn';
    case 'info':   return 'sev-info';
    case 'debug':  return 'sev-debug';
    default:       return 'sev-log';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 60) + (u.pathname.length > 60 ? '…' : '');
  } catch {
    return url.slice(0, 70);
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function bg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}
