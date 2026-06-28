// ─── DevJam · Recorder Page ───────────────────────────────────────────────
'use strict';

// ── Estado ────────────────────────────────────────────────────────────────
let targetTabId   = null;   // tab que se va a grabar
let captureStream = null;   // stream del canvas
let mediaRecorder = null;
let recordChunks  = [];
let recTimer      = null;
let totalSeconds  = 0;
let currentState  = 'idle'; // idle | ready | recording | paused
let recordings    = [];

// Canvas para captura por pestaña
let canvas     = null;
let ctx        = null;
let frameTimer = null;   // intervalo que llama captureVisibleTab

// Eventos
let allEvents    = [];
let activeETab   = 'all';
let epCapturing  = false;

// ── DOM ───────────────────────────────────────────────────────────────────
const btnSelect      = document.getElementById('btn-select');
const btnStart       = document.getElementById('btn-start');
const btnPause       = document.getElementById('btn-pause');
const btnStop        = document.getElementById('btn-stop');
const btnRefreshTabs = document.getElementById('btn-refresh-tabs');
const btnChangeTab   = document.getElementById('btn-change-tab');
const timerDisplay   = document.getElementById('timer-display');
const overlayTime    = document.getElementById('overlay-time');
const statusLabel    = document.getElementById('status-label');
const statusSub      = document.getElementById('status-sub');
const statusInd      = document.getElementById('status-indicator');
const tabPicker      = document.getElementById('tab-picker');
const previewWrap    = document.getElementById('preview-wrap');
const previewCanvas  = document.getElementById('preview-canvas');
const recOverlay     = document.getElementById('rec-overlay');
const pauseOverlay   = document.getElementById('pause-overlay');
const sourceName     = document.getElementById('source-name');
const sourceFavicon  = document.getElementById('source-favicon');
const recList        = document.getElementById('recordings-list');
const recCount       = document.getElementById('rec-count');
const eventsScroll   = document.getElementById('events-scroll');
const eventsEmpty    = document.getElementById('events-empty');
const epErrors       = document.getElementById('ep-errors');
const epWarns        = document.getElementById('ep-warns');
const epNet          = document.getElementById('ep-net');
const epClear        = document.getElementById('ep-clear');
const epCaptureBtn   = document.getElementById('ep-capture-toggle');
const epCaptureLabel = document.getElementById('ep-capture-label');
const selFps         = document.getElementById('sel-fps');

canvas = previewCanvas;
ctx    = canvas.getContext('2d');

// ── Inicialización ────────────────────────────────────────────────────────
(async function init() {
  const state = await bgMsg('GET_STATE');
  epCapturing = state.capturing;
  allEvents   = [
    ...state.consoleEvents.map(e => ({ ...e, _src: 'console' })),
    ...state.networkEvents.map(e => ({ ...e, _src: 'network' })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  updateCaptureBtn();
  renderEvents();
  updateCounters();
  loadTabs();
})();

// ── Escuchar eventos en tiempo real desde el background ───────────────────
browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'CONSOLE_EVENT') {
    allEvents.unshift({ ...msg.event, _src: 'console' });
    renderEvents();
    updateCounters();
  }
  if (msg.type === 'NETWORK_EVENT') {
    const e   = { ...msg.event, _src: 'network' };
    const idx = allEvents.findIndex(x => x.id === e.id && x._src === 'network');
    if (idx >= 0) allEvents[idx] = e; else allEvents.unshift(e);
    renderEvents();
    updateCounters();
  }
  // Frame pusheado por el background — dibujar directo sin round-trip
  if (msg.type === 'FRAME_DATA') {
    drawFrame(msg.dataUrl);  // sin await: el siguiente frame espera al background, no a drawFrame
  }
  // Cursor con coordenadas completas (clientX/Y + scroll + dpr)
  if (msg.type === 'CURSOR_MOVE') {
    cursor.x       = msg.x;
    cursor.y       = msg.y;
    cursor.scrollX = msg.scrollX;
    cursor.scrollY = msg.scrollY;
    cursor.dpr     = msg.dpr;
  }
});

// ── Tab picker ────────────────────────────────────────────────────────────
btnSelect.addEventListener('click', () => showTabPicker());
btnRefreshTabs.addEventListener('click', loadTabs);
btnChangeTab.addEventListener('click', () => {
  stopCapture();
  showTabPicker();
});

function showTabPicker() {
  tabPicker.style.display    = 'flex';
  previewWrap.style.display  = 'none';
  loadTabs();
}

async function loadTabs() {
  const tabGrid = document.getElementById('tab-grid');
  tabGrid.innerHTML = '<p class="empty-hint" style="padding:24px;grid-column:1/-1">Cargando...</p>';

  const tabs = await browser.tabs.query({});
  // Filtrar la propia pestaña del recorder y pestañas sin URL
  const recUrl     = browser.runtime.getURL('src/recorder/recorder.html');
  const validTabs  = tabs.filter(t => t.url && !t.url.startsWith('about:') && t.url !== recUrl);

  if (validTabs.length === 0) {
    tabGrid.innerHTML = '<p class="empty-hint" style="grid-column:1/-1">No hay pestañas disponibles.</p>';
    return;
  }

  tabGrid.innerHTML = '';
  for (const tab of validTabs) {
    const card = buildTabCard(tab);
    tabGrid.appendChild(card);
  }
}

function buildTabCard(tab) {
  const card = document.createElement('div');
  card.className = 'tab-card';

  // Thumbnail: favicon centrado — captureTab no existe en Firefox
  const thumb = document.createElement('div');
  thumb.className = 'tab-card-thumb';
  if (tab.favIconUrl) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.style.cssText = 'width:32px;height:32px;object-fit:contain;opacity:.85';
    img.onerror = () => { thumb.textContent = '🌐'; };
    thumb.appendChild(img);
  } else {
    thumb.textContent = '🌐';
  }

  const info = document.createElement('div');
  info.className = 'tab-card-info';

  const title = document.createElement('span');
  title.className = 'tab-card-title';
  title.textContent = tab.title || tab.url;
  title.title = tab.url;
  info.appendChild(title);

  card.appendChild(thumb);
  card.appendChild(info);

  card.addEventListener('click', () => selectTab(tab));
  return card;
}

// ── Selección de pestaña → arrancar captura de frames ────────────────────
async function selectTab(tab) {
  targetTabId = tab.id;

  // Mostrar preview
  tabPicker.style.display   = 'none';
  previewWrap.style.display = 'flex';

  // Actualizar barra de info
  sourceName.textContent = tab.title || tab.url;
  if (tab.favIconUrl) {
    sourceFavicon.innerHTML = `<img src="${tab.favIconUrl}" onerror="this.remove()">`;
  }

  // Activar tracking de cursor en la pestaña objetivo desde ya (preview + grabación)
  browser.tabs.sendMessage(tab.id, { type: 'SET_RECORDING', value: true }).catch(() => {});

  // Arrancar el loop de captura de frames para el preview
  startFrameLoop();
  applyState('ready');
}

// ── Cursor ────────────────────────────────────────────────────────────────
// El content script reporta clientX/Y + scrollX/Y + devicePixelRatio.
// Acá calculamos la posición real en el canvas de captura.
let cursor = { x: -1, y: -1, scrollX: 0, scrollY: 0, dpr: 1 };

// Pre-renderizar el cursor en un OffscreenCanvas reutilizable.
// NO usar transferToImageBitmap() — transfiere la propiedad y el bitmap
// queda inválido después del primer drawImage.
const CURSOR_SIZE = 22;
const cursorOC  = new OffscreenCanvas(CURSOR_SIZE, CURSOR_SIZE);
const cursorOC2 = cursorOC.getContext('2d');
cursorOC2.beginPath();
cursorOC2.moveTo(3, 1);
cursorOC2.lineTo(3, 17);
cursorOC2.lineTo(7, 13);
cursorOC2.lineTo(10, 19);
cursorOC2.lineTo(12, 18);
cursorOC2.lineTo(9, 12);
cursorOC2.lineTo(14, 12);
cursorOC2.closePath();
cursorOC2.strokeStyle = '#000';
cursorOC2.lineWidth   = 1.5;
cursorOC2.lineJoin    = 'round';
cursorOC2.stroke();
cursorOC2.fillStyle = '#fff';
cursorOC2.fill();

// ── Frame loop ────────────────────────────────────────────────────────────
// El background pushea frames directamente via FRAME_DATA para eliminar
// el round-trip de mensajes del loop anterior.

function startFrameLoop() {
  stopFrameLoop();
  const fps = parseInt(selFps.value, 10) || 24;
  // Decirle al background que empiece a pushear frames a este fps
  bgMsg('START_FRAME_PUSH', { tabId: targetTabId, fps });
  frameTimer = { stop: () => bgMsg('STOP_FRAME_PUSH') };
}

function stopFrameLoop() {
  if (frameTimer) { frameTimer.stop(); frameTimer = null; }
}

async function drawFrame(dataUrl) {
  // Convertir dataUrl a Blob sin fetch (fetch falla con CSP en extensiones).
  // atob + Uint8Array es síncrono y más rápido.
  let bitmap;
  try {
    const parts  = dataUrl.split(',');
    const mime   = parts[0].match(/:(.*?);/)[1];
    const binary = atob(parts[1]);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    bitmap = await createImageBitmap(blob);
  } catch { return; }

  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Cursor: clientX/Y son relativas al viewport.
  // captureVisibleTab captura exactamente el viewport (no la página completa),
  // así que NO sumar scroll — el bitmap ya empieza donde está el scroll.
  // Solo escalar por dpr para mapear píxeles CSS a píxeles del bitmap.
  if (cursor.x >= 0 && cursor.y >= 0) {
    const dpr = cursor.dpr || 1;
    const cx  = cursor.x * dpr;
    const cy  = cursor.y * dpr;
    if (cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height) {
      ctx.drawImage(cursorOC, cx, cy, CURSOR_SIZE * dpr, CURSOR_SIZE * dpr);
    }
  }
}

function stopCapture() {
  stopFrameLoop();
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
  targetTabId = null;
  applyState('idle');
}

// ── Grabación ─────────────────────────────────────────────────────────────
btnStart.addEventListener('click', startRecording);

async function startRecording() {
  if (!targetTabId) return;

  // Capturar el canvas como stream de video
  const fps = parseInt(selFps.value, 10) || 24;
  captureStream = canvas.captureStream(fps);

  // Micrófono opcional
  const chkMic = document.getElementById('chk-mic');
  if (chkMic.checked) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream.getAudioTracks().forEach(t => captureStream.addTrack(t));
    } catch { /* sin micro, continuar */ }
  }

  const format = document.getElementById('sel-format').value;
  const mime   = pickMime(format);

  recordChunks = [];
  try {
    mediaRecorder = new MediaRecorder(captureStream, { mimeType: mime });
  } catch {
    mediaRecorder = new MediaRecorder(captureStream);
  }

  mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recordChunks.push(e.data); };
  mediaRecorder.onstop = finalizeRecording;
  mediaRecorder.start(500);

  totalSeconds = 0;
  startTimer();
  applyState('recording');
}

// ── Pausar / reanudar ─────────────────────────────────────────────────────
btnPause.addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (currentState === 'recording') {
    mediaRecorder.pause();
    stopTimer();
    stopFrameLoop();   // pausar también la captura de frames
    btnPause.innerHTML = svgPlay() + ' Reanudar';
    applyState('paused');
  } else if (currentState === 'paused') {
    mediaRecorder.resume();
    startTimer();
    startFrameLoop();  // reanudar captura de frames
    btnPause.innerHTML = svgPause() + ' Pausar';
    applyState('recording');
  }
});

// ── Detener ───────────────────────────────────────────────────────────────
btnStop.addEventListener('click', stopAndSave);

function stopAndSave() {
  if (!mediaRecorder) return;
  if (currentState !== 'recording' && currentState !== 'paused') return;
  stopTimer();
  stopFrameLoop();
  mediaRecorder.stop();
}

function finalizeRecording() {
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }

  if (recordChunks.length === 0) { applyState('ready'); return; }

  const mime     = mediaRecorder?.mimeType ?? 'video/webm';
  const blob     = new Blob(recordChunks, { type: mime });
  const url      = URL.createObjectURL(blob);
  const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `devjam-${ts}.${ext}`;

  // Capturar snapshot de eventos ocurridos durante esta grabación
  const recStartTs = Date.now() - (totalSeconds * 1000);
  const recEndTs   = Date.now();
  const sessionEvents = allEvents.filter(e =>
    e.timestamp >= recStartTs && e.timestamp <= recEndTs
  );

  recordings.unshift({
    name:      filename,
    url,
    duration:  totalSeconds,
    size:      blob.size,
    startTs:   recStartTs,
    endTs:     recEndTs,
    events:    [...sessionEvents],   // snapshot en el momento de parar
  });
  renderRecordings();

  // Reiniciar frame loop para que el canvas siga vivo después de grabar
  startFrameLoop();
  applyState('ready');
}

// ── Timer ─────────────────────────────────────────────────────────────────
function startTimer() {
  clearInterval(recTimer);
  recTimer = setInterval(() => {
    totalSeconds++;
    const d = fmt(totalSeconds);
    timerDisplay.textContent = d;
    overlayTime.textContent  = d;
  }, 1000);
}
function stopTimer() { clearInterval(recTimer); recTimer = null; }

// ── Máquina de estados ────────────────────────────────────────────────────
function applyState(newState) {
  currentState = newState;

  btnStart.style.display = 'flex';
  btnPause.style.display = 'none';
  btnStop.style.display  = 'none';
  btnStart.disabled      = true;
  recOverlay.style.display   = 'none';
  pauseOverlay.style.display = 'none';
  timerDisplay.className     = 'timer-display';
  statusInd.className        = 'status-indicator';

  switch (newState) {
    case 'idle':
      setStatus('Sin fuente', 'Elegí una pestaña para empezar', '');
      timerDisplay.textContent = '0:00:00';
      overlayTime.textContent  = '0:00:00';
      break;
    case 'ready':
      setStatus('Listo', 'Podés iniciar la grabación', 'ready');
      btnStart.disabled = false;
      break;
    case 'recording':
      setStatus('Grabando', 'Captura activa', 'recording');
      btnStart.style.display   = 'none';
      btnPause.style.display   = 'flex';
      btnStop.style.display    = 'flex';
      recOverlay.style.display = 'flex';
      timerDisplay.className   = 'timer-display recording';
      break;
    case 'paused':
      setStatus('Pausado', 'Grabación en pausa', 'paused');
      btnStart.style.display     = 'none';
      btnPause.style.display     = 'flex';
      btnStop.style.display      = 'flex';
      pauseOverlay.style.display = 'flex';
      timerDisplay.className     = 'timer-display paused';
      break;
  }

  notifyBg(newState === 'recording' || newState === 'paused');
}

function setStatus(label, sub, cls) {
  statusLabel.textContent = label;
  statusSub.textContent   = sub;
  statusInd.className     = 'status-indicator' + (cls ? ' ' + cls : '');
}

// ── Captura toggle desde el panel de eventos ──────────────────────────────
epCaptureBtn.addEventListener('click', async () => {
  epCapturing = !epCapturing;
  // Filtrar captura a la pestaña seleccionada (targetTabId) o todas si no hay ninguna
  await bgMsg('SET_CAPTURING', { value: epCapturing, tabId: epCapturing ? targetTabId : null });
  updateCaptureBtn();
});

function updateCaptureBtn() {
  epCaptureBtn.dataset.active   = epCapturing;
  epCaptureLabel.textContent    = epCapturing ? 'Capturando' : 'Captura off';
}

epClear.addEventListener('click', async () => {
  await bgMsg('CLEAR_EVENTS');
  allEvents = [];
  renderEvents();
  updateCounters();
});

// ── Tabs de eventos ───────────────────────────────────────────────────────
document.querySelectorAll('.etab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.etab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeETab = tab.dataset.etab;
    renderEvents();
  });
});

// ── Renderizado de eventos ────────────────────────────────────────────────
function renderEvents() {
  const filtered = filterEvents(allEvents).slice(0, 200);

  if (filtered.length === 0) {
    eventsScroll.innerHTML = '';
    eventsScroll.appendChild(eventsEmpty);
    eventsEmpty.querySelector('p').textContent = allEvents.length === 0
      ? 'Activá la captura para ver eventos.'
      : 'No hay eventos en esta categoría.';
    return;
  }

  eventsScroll.innerHTML = filtered.map(e =>
    e._src === 'network' ? buildNetRow(e) : buildConRow(e)
  ).join('');
}

function filterEvents(evs) {
  switch (activeETab) {
    case 'error':   return evs.filter(e => e.severity === 'error' || e.level === 'error' || e.level === 'assert');
    case 'network': return evs.filter(e => e._src === 'network');
    case 'console': return evs.filter(e => e._src === 'console');
    default:        return evs;
  }
}

function buildConRow(e) {
  const sev  = { error:'ev-sev-error', assert:'ev-sev-error', warn:'ev-sev-warn', info:'ev-sev-info', debug:'ev-sev-debug' }[e.level] ?? 'ev-sev-log';
  return `<div class="ev-row" data-ts="${e.timestamp ?? 0}">
    <div class="ev-sev ${sev}"></div>
    <div class="ev-body">
      <div class="ev-meta">
        <span class="ev-type">${esc(e.level || 'log').toUpperCase()}</span>
        <span class="ev-time">${fmtTime(e.timestamp)}</span>
      </div>
      <div class="ev-msg">${esc(e.message ?? '')}</div>
    </div>
  </div>`;
}

function buildNetRow(e) {
  const sev = e.severity === 'error' ? 'ev-sev-error' : e.severity === 'warn' ? 'ev-sev-warn' : 'ev-sev-ok';
  const stc = e.status >= 500 ? 'ev-st-error' : e.status >= 400 ? 'ev-st-warn' : e.status === 0 ? 'ev-st-error' : 'ev-st-ok';
  const id  = 'net-' + Math.random().toString(36).slice(2);

  // Preview del response body (primeros 200 chars)
  let preview = '';
  if (e.responseBody && typeof e.responseBody === 'string' && !e.responseBody.startsWith('[binary')) {
    try {
      // Intentar formatear JSON
      preview = JSON.stringify(JSON.parse(e.responseBody), null, 2).slice(0, 300);
    } catch {
      preview = e.responseBody.slice(0, 300);
    }
  }

  const hasDetail = preview || e.requestBody || e.responseHeaders || e.requestHeaders;

  return `<div class="ev-row ev-row-net" id="${id}" data-ts="${e.timestamp ?? 0}">
    <div class="ev-sev ${sev}"></div>
    <div class="ev-body">
      <div class="ev-meta">
        <span class="ev-method">${esc(e.method ?? 'GET')}</span>
        <span class="ev-status ${stc}">${esc(String(e.error ?? e.status ?? '---'))}</span>
        ${e.duration ? `<span class="ev-dur">${e.duration}ms</span>` : ''}
        ${e.contentType ? `<span class="ev-ct">${esc(e.contentType.split(';')[0])}</span>` : ''}
        <span class="ev-time">${fmtTime(e.timestamp)}</span>
        ${hasDetail ? `<button class="ev-expand" data-detail-id="${id}">▶</button>` : ''}
      </div>
      <div class="ev-url">${esc(shortUrl(e.url ?? ''))}</div>
      ${hasDetail ? `<div class="ev-detail" id="${id}-detail" style="display:none">
        ${e.requestHeaders && Object.keys(e.requestHeaders).length ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Request Headers</span>
            <pre class="ev-pre">${esc(Object.entries(e.requestHeaders).map(([k,v]) => k+': '+v).join('\n'))}</pre>
          </div>` : ''}
        ${e.requestBody ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Request Body</span>
            <pre class="ev-pre">${esc(e.requestBody)}</pre>
          </div>` : ''}
        ${e.responseHeaders && Object.keys(e.responseHeaders).length ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Response Headers</span>
            <pre class="ev-pre">${esc(Object.entries(e.responseHeaders).map(([k,v]) => k+': '+v).join('\n'))}</pre>
          </div>` : ''}
        ${preview ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Response Preview</span>
            <pre class="ev-pre">${esc(preview)}</pre>
          </div>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

function updateCounters() {
  epErrors.textContent = allEvents.filter(e => e.level === 'error' || e.level === 'assert' || (e._src === 'network' && e.status >= 500)).length;
  epWarns.textContent  = allEvents.filter(e => e.level === 'warn'  || (e._src === 'network' && e.status >= 400 && e.status < 500)).length;
  epNet.textContent    = allEvents.filter(e => e._src === 'network').length;
}

// ── Grabaciones — lista en sidebar ───────────────────────────────────────
function renderRecordings() {
  recCount.textContent = recordings.length;
  if (recordings.length === 0) {
    recList.innerHTML = '<p class="empty-hint">Las grabaciones aparecerán aquí.</p>';
    return;
  }
  recList.innerHTML = recordings.map((r, i) => `
    <div class="rec-item" data-rec-index="${i}">
      <div class="rec-item-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="8" cy="8" r="2.5" fill="currentColor"/>
        </svg>
      </div>
      <div class="rec-item-info">
        <div class="rec-item-name">${esc(r.name)}</div>
        <div class="rec-item-meta">${fmt(r.duration)} · ${fmtSize(r.size)} · ${r.events?.length ?? 0} eventos</div>
      </div>
      <div class="rec-item-actions">
        <button class="rec-btn-view" data-rec-index="${i}" title="Ver sesión">⬡</button>
        <a class="rec-item-dl" href="${r.url}" download="${esc(r.name)}" title="Descargar">↓</a>
      </div>
    </div>`).join('');
}

// ── Vista de sesión de grabación ──────────────────────────────────────────
recList.addEventListener('click', e => {
  const btn = e.target.closest('.rec-btn-view');
  if (!btn) return;
  const idx = parseInt(btn.dataset.recIndex, 10);
  openSession(recordings[idx]);
});

function openSession(rec) {
  // Crear la pantalla de sesión sobre todo el layout
  const existing = document.getElementById('session-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'session-overlay';
  overlay.className = 'session-overlay';
  overlay.innerHTML = buildSessionHTML(rec);
  document.body.appendChild(overlay);

  // Conectar video
  const video = overlay.querySelector('#session-video');
  video.src   = rec.url;

  // Sincronizar eventos con el tiempo del video
  video.addEventListener('timeupdate', () => {
    const currentTs = rec.startTs + Math.round(video.currentTime * 1000);
    highlightCurrentEvent(overlay, rec.events, currentTs);
  });

  // Cerrar
  overlay.querySelector('.session-close').addEventListener('click', () => overlay.remove());

  // Tabs de filtro
  overlay.querySelectorAll('.sess-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.sess-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSessionEvents(overlay, rec.events, tab.dataset.tab);
    });
  });

  // Delegación expand en session
  overlay.querySelector('.sess-events-scroll').addEventListener('click', e => {
    const btn = e.target.closest('.ev-expand');
    if (!btn) return;
    const id     = btn.dataset.detailId;
    const detail = document.getElementById(id + '-detail');
    if (!detail) return;
    const open = detail.style.display === 'none';
    detail.style.display = open ? 'block' : 'none';
    btn.textContent      = open ? '▼' : '▶';
  });

  // Render inicial
  renderSessionEvents(overlay, rec.events, 'all');
}

function buildSessionHTML(rec) {
  const date = new Date(rec.startTs).toLocaleString('es');
  return `
  <div class="session-panel">
    <div class="session-header">
      <div class="session-title">
        <span class="session-name">${esc(rec.name)}</span>
        <span class="session-meta">${date} · ${fmt(rec.duration)} · ${fmtSize(rec.size)}</span>
      </div>
      <button class="session-close">✕</button>
    </div>
    <div class="session-body">
      <!-- Video -->
      <div class="session-video-col">
        <video id="session-video" class="session-video" controls></video>
        <div class="session-video-meta">
          <span>${rec.events?.length ?? 0} eventos capturados durante la grabación</span>
          <a href="${rec.url}" download="${esc(rec.name)}" class="sess-dl-btn">↓ Descargar video</a>
        </div>
      </div>
      <!-- Panel de eventos -->
      <div class="session-events-col">
        <div class="sess-tabs">
          <button class="sess-tab active" data-tab="all">Todo</button>
          <button class="sess-tab" data-tab="error">Errores</button>
          <button class="sess-tab" data-tab="network">Red</button>
          <button class="sess-tab" data-tab="console">Consola</button>
        </div>
        <div class="sess-events-scroll" id="sess-events-scroll"></div>
      </div>
    </div>
  </div>`;
}

function renderSessionEvents(overlay, events, tab) {
  const scroll  = overlay.querySelector('.sess-events-scroll');
  const filtered = filterSessionEvents(events, tab);

  if (filtered.length === 0) {
    scroll.innerHTML = '<div class="events-empty"><p>Sin eventos en esta categoría.</p></div>';
    return;
  }
  scroll.innerHTML = filtered.map(e =>
    e._src === 'network' ? buildNetRow(e) : buildConRow(e)
  ).join('');
}

function filterSessionEvents(events, tab) {
  switch (tab) {
    case 'error':   return events.filter(e => e.severity === 'error' || e.level === 'error' || e.level === 'assert');
    case 'network': return events.filter(e => e._src === 'network');
    case 'console': return events.filter(e => e._src === 'console');
    default:        return events;
  }
}

// Marcar el evento más cercano al tiempo actual del video
function highlightCurrentEvent(overlay, events, currentTs) {
  const rows = overlay.querySelectorAll('.ev-row[data-ts]');
  let closest = null, minDiff = Infinity;
  rows.forEach(row => {
    const diff = Math.abs(parseInt(row.dataset.ts, 10) - currentTs);
    if (diff < minDiff) { minDiff = diff; closest = row; }
  });
  rows.forEach(r => r.classList.remove('ev-current'));
  if (closest && minDiff < 3000) closest.classList.add('ev-current');
}

// ── Background messaging ──────────────────────────────────────────────────
function bgMsg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}

function notifyBg(isRecording) {
  bgMsg('SET_RECORDING', { value: isRecording }).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────
function pickMime(format) {
  const c = format === 'mp4'
    ? ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return c.find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
}

function fmt(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtSize(b) {
  return b < 1048576 ? `${(b/1024).toFixed(0)} KB` : `${(b/1048576).toFixed(1)} MB`;
}

function shortUrl(url) {
  try { const u = new URL(url); return u.hostname + u.pathname.slice(0, 50); } catch { return url.slice(0, 60); }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function svgPlay()  { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><polygon points="3,2 14,8 3,14" fill="currentColor"/></svg>`; }
function svgPause() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>`; }

// ── Expandir/colapsar detalle — delegación de eventos (CSP-safe) ─────────
eventsScroll.addEventListener('click', e => {
  const btn = e.target.closest('.ev-expand');
  if (!btn) return;
  const id     = btn.dataset.detailId;
  const detail = document.getElementById(id + '-detail');
  if (!detail) return;
  const open = detail.style.display === 'none';
  detail.style.display    = open ? 'block' : 'none';
  btn.textContent         = open ? '▼' : '▶';
});

// ── Init ──────────────────────────────────────────────────────────────────
applyState('idle');
