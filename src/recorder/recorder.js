// ─── DevJam · Recorder Page ───────────────────────────────────────────────
'use strict';

// ── Estado ────────────────────────────────────────────────────────────────
// captureMode: 'tab1' | 'tab2' | 'window' | 'screen'
let captureMode = 'tab1';
let sourceTabA = null;   // tab seleccionada en slot A
let sourceTabB = null;   // tab seleccionada en slot B (solo tab2)
let displayStream = null;   // stream de getDisplayMedia (window/screen)
let captureStream = null;   // stream del canvas (tab1/tab2) o display
let mediaRecorder = null;
let recordChunks = [];
let recTimer = null;
let totalSeconds = 0;
let currentState = 'idle';
let recordings = [];

// Dos canvas: uno por slot de pestaña
let canvases = [];   // [canvasA, canvasB]
let ctxs = [];   // [ctxA, ctxB]
let frameTimer = null;

// Slot activo en el picker (para tab2)
let pickerSlot = 'A';  // 'A' | 'B'

// Eventos
let allEvents = [];
let activeETab = 'all';
let epCapturing = false;

// ── DOM ───────────────────────────────────────────────────────────────────
const btnChangeSource = document.getElementById('btn-change-source');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const btnRefreshTabs = document.getElementById('btn-refresh-tabs');
const btnConfirm = document.getElementById('btn-confirm-source');
const timerDisplay = document.getElementById('timer-display');
const overlayTime = document.getElementById('overlay-time');
const statusLabel = document.getElementById('status-label');
const statusSub = document.getElementById('status-sub');
const statusInd = document.getElementById('status-indicator');
const sourcePicker = document.getElementById('source-picker');
const previewWrap = document.getElementById('preview-wrap');
const recOverlay = document.getElementById('rec-overlay');
const pauseOverlay = document.getElementById('pause-overlay');
const sourceName = document.getElementById('source-name');
const canvasGrid = document.getElementById('canvas-grid');
const previewVideo = document.getElementById('preview-video');
const recList = document.getElementById('recordings-list');
const recCount = document.getElementById('rec-count');
const eventsScroll = document.getElementById('events-scroll');
const eventsEmpty = document.getElementById('events-empty');
const epErrors = document.getElementById('ep-errors');
const epWarns = document.getElementById('ep-warns');
const epNet = document.getElementById('ep-net');
const epClear = document.getElementById('ep-clear');
const epCaptureBtn = document.getElementById('ep-capture-toggle');
const epCaptureLabel = document.getElementById('ep-capture-label');
const selFps = document.getElementById('sel-fps');
const slotBWrap = document.getElementById('slot-b-wrap');
const tabGridA = document.getElementById('tab-grid-a');
const tabGridB = document.getElementById('tab-grid-b');
const tabPickerSub = document.getElementById('tab-picker-sub');
const tabPickerSec = document.getElementById('tab-picker-section');

canvases = [document.getElementById('canvas-a'), document.getElementById('canvas-b')];
ctxs = canvases.map(c => c.getContext('2d'));

// ── Inicialización ────────────────────────────────────────────────────────
(async function init() {
  const state = await bgMsg('GET_STATE');
  epCapturing = state.capturing;
  allEvents = [
    ...state.consoleEvents.map(e => ({ ...e, _src: 'console' })),
    ...state.networkEvents.map(e => ({ ...e, _src: 'network' })),
  ].sort((a, b) => b.timestamp - a.timestamp);
  updateCaptureBtn();
  renderEvents();
  updateCounters();
  showPicker();
})();

// ── Escuchar mensajes del background ─────────────────────────────────────
browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'CONSOLE_EVENT') {
    allEvents.unshift({ ...msg.event, _src: 'console' });
    renderEvents(); updateCounters();
  }
  if (msg.type === 'NETWORK_EVENT') {
    const e = { ...msg.event, _src: 'network' };
    const i = allEvents.findIndex(x => x.id === e.id && x._src === 'network');
    if (i >= 0) allEvents[i] = e; else allEvents.unshift(e);
    renderEvents(); updateCounters();
  }
  if (msg.type === 'FRAME_DATA') {
    // idx indica qué canvas actualizar (0=A, 1=B)
    const idx = msg.idx ?? 0;
    if (ctxs[idx]) drawFrame(msg.dataUrl, ctxs[idx], canvases[idx]);
  }
  if (msg.type === 'CURSOR_MOVE') {
    cursor.x = msg.x; cursor.y = msg.y; cursor.dpr = msg.dpr;
  }
});

// ── Selector de modo ──────────────────────────────────────────────────────
document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('mode-card-active'));
    card.classList.add('mode-card-active');
    captureMode = card.dataset.mode;
    applyModeUI();
  });
});

function applyModeUI() {
  const isTab = captureMode === 'tab1' || captureMode === 'tab2';
  tabPickerSec.style.display = isTab ? 'flex' : 'none';
  slotBWrap.style.display = captureMode === 'tab2' ? 'block' : 'none';
  tabPickerSub.textContent = captureMode === 'tab2'
    ? 'Elegí la primera pestaña (izquierda)'
    : 'Elegí la pestaña a grabar';

  // Para window/screen habilitar confirmar sin selección de tab
  if (!isTab) {
    sourceTabA = null; sourceTabB = null;
    btnConfirm.disabled = false;
  } else {
    btnConfirm.disabled = !sourceTabA;
  }
  loadTabs();
}

// ── Tab picker ────────────────────────────────────────────────────────────
btnRefreshTabs.addEventListener('click', loadTabs);
btnChangeSource.addEventListener('click', () => { stopCapture(); showPicker(); });

function showPicker() {
  sourcePicker.style.display = 'flex';
  previewWrap.style.display = 'none';
  sourceTabA = null; sourceTabB = null;
  btnConfirm.disabled = true;
  applyModeUI();
}

async function loadTabs() {
  if (captureMode !== 'tab1' && captureMode !== 'tab2') return;
  const recUrl = browser.runtime.getURL('src/recorder/recorder.html');
  const allTabs = await browser.tabs.query({});
  const validTabs = allTabs.filter(t => t.url && !t.url.startsWith('about:') && t.url !== recUrl);

  [tabGridA, tabGridB].forEach(grid => {
    grid.innerHTML = '';
    if (validTabs.length === 0) {
      grid.innerHTML = '<p class="empty-hint" style="grid-column:1/-1">Sin pestañas disponibles.</p>';
      return;
    }
    validTabs.forEach(tab => grid.appendChild(buildTabCard(tab, grid === tabGridA ? 'A' : 'B')));
  });
}

function buildTabCard(tab, slot) {
  const card = document.createElement('div');
  card.className = 'tab-card';
  if ((slot === 'A' && sourceTabA?.id === tab.id) ||
    (slot === 'B' && sourceTabB?.id === tab.id)) {
    card.classList.add('tab-card-selected');
  }

  const thumb = document.createElement('div');
  thumb.className = 'tab-card-thumb';
  if (tab.favIconUrl) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.style.cssText = 'width:28px;height:28px;object-fit:contain;opacity:.85';
    img.onerror = () => { thumb.textContent = '🌐'; };
    thumb.appendChild(img);
  } else { thumb.textContent = '🌐'; }

  const info = document.createElement('div');
  info.className = 'tab-card-info';
  const title = document.createElement('span');
  title.className = 'tab-card-title';
  title.textContent = tab.title || tab.url;
  title.title = tab.url;
  info.appendChild(title);

  card.appendChild(thumb);
  card.appendChild(info);
  card.addEventListener('click', () => selectTabForSlot(tab, slot));
  return card;
}

function selectTabForSlot(tab, slot) {
  if (slot === 'A') {
    sourceTabA = tab;
    tabPickerSub.textContent = captureMode === 'tab2'
      ? 'Elegí la segunda pestaña (derecha)'
      : 'Elegí la pestaña a grabar';
  } else {
    sourceTabB = tab;
  }

  // Resaltar selección visualmente
  const grid = slot === 'A' ? tabGridA : tabGridB;
  grid.querySelectorAll('.tab-card').forEach(c => c.classList.remove('tab-card-selected'));
  event.currentTarget.classList.add('tab-card-selected');

  // Habilitar confirmar cuando hay suficiente selección
  const needsB = captureMode === 'tab2';
  btnConfirm.disabled = !sourceTabA || (needsB && !sourceTabB);
}

// ── Confirmar fuente y arrancar preview ───────────────────────────────────
btnConfirm.addEventListener('click', confirmSource);

async function confirmSource() {
  sourcePicker.style.display = 'none';
  previewWrap.style.display = 'flex';

  if (captureMode === 'tab1' || captureMode === 'tab2') {
    await startTabPreview();
  } else {
    await startDisplayPreview();
  }
  applyState('ready');
}

async function startTabPreview() {
  // Mostrar canvas(es) correcto(s)
  canvases[0].style.display = 'block';
  previewVideo.style.display = 'none';
  canvasGrid.dataset.mode = captureMode;

  if (captureMode === 'tab2') {
    canvases[1].style.display = 'block';
  } else {
    canvases[1].style.display = 'none';
  }

  // Activar cursor tracking en la(s) pestaña(s)
  const tabs = [sourceTabA, captureMode === 'tab2' ? sourceTabB : null].filter(Boolean);
  tabs.forEach(t => {
    browser.tabs.sendMessage(t.id, { type: 'SET_RECORDING', value: true }).catch(() => { });
  });

  // Nombre en source bar
  sourceName.textContent = captureMode === 'tab2'
    ? `${sourceTabA.title || 'Tab A'} | ${sourceTabB.title || 'Tab B'}`
    : (sourceTabA.title || sourceTabA.url);

  startFrameLoop();
}

async function startDisplayPreview() {
  // Para ventana y pantalla usamos getDisplayMedia
  canvases.forEach(c => c.style.display = 'none');
  previewVideo.style.display = 'block';

  const constraints = {
    video: {
      displaySurface: captureMode === 'window' ? 'window' : 'monitor',
      frameRate: parseInt(selFps.value, 10) || 24,
    },
    audio: false,
  };

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    previewVideo.srcObject = displayStream;
    sourceName.textContent = captureMode === 'window' ? 'Ventana del navegador' : 'Pantalla completa';

    // Si el usuario cierra el stream desde la barra del browser
    displayStream.getVideoTracks()[0].addEventListener('ended', () => {
      stopCapture(); showPicker();
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      setStatus('Error', err.message, '');
    }
    showPicker();
  }
}

// ── Cursor ────────────────────────────────────────────────────────────────
let cursor = { x: -1, y: -1, scrollX: 0, scrollY: 0, dpr: 1 };

const CURSOR_SIZE = 22;
const cursorOC = new OffscreenCanvas(CURSOR_SIZE, CURSOR_SIZE);
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
cursorOC2.lineWidth = 1.5;
cursorOC2.lineJoin = 'round';
cursorOC2.stroke();
cursorOC2.fillStyle = '#fff';
cursorOC2.fill();

// ── Frame loop (USANDO captureTab SIN PARPADEO) ──────────────────────────
function startFrameLoop() {
  stopFrameLoop();
  const fps = parseInt(selFps.value, 10) || 24;
  const sources = [];

  if (sourceTabA) sources.push({ type: 'tab', tabId: sourceTabA.id, slot: 0 });
  if (sourceTabB) sources.push({ type: 'tab', tabId: sourceTabB.id, slot: 1 });

  if (sources.length > 0) {
    // Iniciar captura usando captureTab en lugar de chrome.tabCapture
    const interval = 1000 / fps;

    // Capturar frames periódicamente
    frameTimer = setInterval(async () => {
      for (const source of sources) {
        try {
          // ⚡ USAR captureTab - NO requiere foco, NO causa parpadeo
          const dataUrl = await browser.tabs.captureTab(source.tabId, {
            format: 'jpeg',
            quality: 90
          });

          // Enviar frame al canvas correspondiente
          if (ctxs[source.slot]) {
            drawFrame(dataUrl, ctxs[source.slot], canvases[source.slot]);
          }
        } catch (error) {
          console.error(`Error capturando tab ${source.tabId}:`, error);
        }
      }
    }, interval);
  }
}

function stopFrameLoop() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

async function drawFrame(dataUrl, targetCtx, targetCanvas) {
  let bitmap;
  try {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  } catch { return; }

  if (targetCanvas.width !== bitmap.width || targetCanvas.height !== bitmap.height) {
    targetCanvas.width = bitmap.width;
    targetCanvas.height = bitmap.height;
  }
  targetCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Cursor solo sobre el canvas A (pestaña principal)
  if (targetCtx === ctxs[0] && cursor.x >= 0 && cursor.y >= 0) {
    const dpr = cursor.dpr || 1;
    const cx = cursor.x * dpr;
    const cy = cursor.y * dpr;
    if (cx >= 0 && cy >= 0 && cx < targetCanvas.width && cy < targetCanvas.height) {
      targetCtx.drawImage(cursorOC, cx, cy, CURSOR_SIZE * dpr, CURSOR_SIZE * dpr);
    }
  }
}

function stopCapture() {
  stopFrameLoop();
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
  if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
  previewVideo.srcObject = null;
  sourceTabA = null; sourceTabB = null;
  applyState('idle');
}

// ── Grabación ─────────────────────────────────────────────────────────────
btnStart.addEventListener('click', startRecording);

async function startRecording() {
  const fps = parseInt(selFps.value, 10) || 24;

  if (captureMode === 'window' || captureMode === 'screen') {
    // Para window/screen usamos el displayStream directamente
    if (!displayStream) return;
    captureStream = displayStream;
  } else if (captureMode === 'tab2' && sourceTabA && sourceTabB) {
    // Dos pestañas: combinar los dos canvas en uno más ancho
    const combinedCanvas = new OffscreenCanvas(
      (canvases[0].width || 1280) + (canvases[1].width || 1280),
      Math.max(canvases[0].height || 720, canvases[1].height || 720)
    );
    const combCtx = combinedCanvas.getContext('2d');

    // Mantener el canvas combinado actualizado en cada frame
    const drawCombined = () => {
      combCtx.drawImage(canvases[0], 0, 0);
      combCtx.drawImage(canvases[1], canvases[0].width || 1280, 0);
    };
    const combineTimer = setInterval(drawCombined, 1000 / fps);
    captureStream = combinedCanvas.captureStream(fps);

    // Limpiar el timer al parar
    captureStream._combineTimer = combineTimer;
  } else {
    // Pestaña única
    if (!sourceTabA) return;
    captureStream = canvases[0].captureStream(fps);
  }

  // Micrófono opcional
  const chkMic = document.getElementById('chk-mic');
  if (chkMic.checked) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream.getAudioTracks().forEach(t => captureStream.addTrack(t));
    } catch { /* sin micro, continuar */ }
  }

  const format = document.getElementById('sel-format').value;
  const mime = pickMime(format);

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
  if (captureStream?._combineTimer) clearInterval(captureStream._combineTimer);
  if (captureStream && captureStream !== displayStream) {
    captureStream.getTracks().forEach(t => t.stop());
  }
  captureStream = null;

  if (recordChunks.length === 0) { applyState('ready'); return; }

  const mime = mediaRecorder?.mimeType ?? 'video/webm';
  const blob = new Blob(recordChunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `devjam-${ts}.${ext}`;

  // Capturar snapshot de eventos ocurridos durante esta grabación
  const recStartTs = Date.now() - (totalSeconds * 1000);
  const recEndTs = Date.now();
  const sessionEvents = allEvents.filter(e =>
    e.timestamp >= recStartTs && e.timestamp <= recEndTs
  );

  recordings.unshift({
    name: filename,
    url,
    duration: totalSeconds,
    size: blob.size,
    startTs: recStartTs,
    endTs: recEndTs,
    events: [...sessionEvents],   // snapshot en el momento de parar
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
    overlayTime.textContent = d;
  }, 1000);
}
function stopTimer() { clearInterval(recTimer); recTimer = null; }

// ── Máquina de estados ────────────────────────────────────────────────────
function applyState(newState) {
  currentState = newState;

  btnStart.style.display = 'flex';
  btnPause.style.display = 'none';
  btnStop.style.display = 'none';
  btnStart.disabled = true;
  recOverlay.style.display = 'none';
  pauseOverlay.style.display = 'none';
  timerDisplay.className = 'timer-display';
  statusInd.className = 'status-indicator';

  switch (newState) {
    case 'idle':
      setStatus('Sin fuente', 'Elegí una pestaña para empezar', '');
      timerDisplay.textContent = '0:00:00';
      overlayTime.textContent = '0:00:00';
      break;
    case 'ready':
      setStatus('Listo', 'Podés iniciar la grabación', 'ready');
      btnStart.disabled = false;
      break;
    case 'recording':
      setStatus('Grabando', 'Captura activa', 'recording');
      btnStart.style.display = 'none';
      btnPause.style.display = 'flex';
      btnStop.style.display = 'flex';
      recOverlay.style.display = 'flex';
      timerDisplay.className = 'timer-display recording';
      break;
    case 'paused':
      setStatus('Pausado', 'Grabación en pausa', 'paused');
      btnStart.style.display = 'none';
      btnPause.style.display = 'flex';
      btnStop.style.display = 'flex';
      pauseOverlay.style.display = 'flex';
      timerDisplay.className = 'timer-display paused';
      break;
  }

  notifyBg(newState === 'recording' || newState === 'paused');
}

function setStatus(label, sub, cls) {
  statusLabel.textContent = label;
  statusSub.textContent = sub;
  statusInd.className = 'status-indicator' + (cls ? ' ' + cls : '');
}

// ── Captura toggle desde el panel de eventos ──────────────────────────────
epCaptureBtn.addEventListener('click', async () => {
  epCapturing = !epCapturing;
  // Filtrar captura a la pestaña seleccionada (sourceTabA) o todas si no hay ninguna
  const capTabId = epCapturing ? (sourceTabA?.id ?? null) : null;
  await bgMsg('SET_CAPTURING', { value: epCapturing, tabId: capTabId });
  updateCaptureBtn();
});

function updateCaptureBtn() {
  epCaptureBtn.dataset.active = epCapturing;
  epCaptureLabel.textContent = epCapturing ? 'Capturando' : 'Captura off';
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
    case 'error': return evs.filter(e => e.severity === 'error' || e.level === 'error' || e.level === 'assert');
    case 'network': return evs.filter(e => e._src === 'network');
    case 'console': return evs.filter(e => e._src === 'console');
    default: return evs;
  }
}

function buildConRow(e) {
  const sev = { error: 'ev-sev-error', assert: 'ev-sev-error', warn: 'ev-sev-warn', info: 'ev-sev-info', debug: 'ev-sev-debug' }[e.level] ?? 'ev-sev-log';
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
  const id = 'net-' + Math.random().toString(36).slice(2);

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
            <pre class="ev-pre">${esc(Object.entries(e.requestHeaders).map(([k, v]) => k + ': ' + v).join('\n'))}</pre>
          </div>` : ''}
        ${e.requestBody ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Request Body</span>
            <pre class="ev-pre">${esc(e.requestBody)}</pre>
          </div>` : ''}
        ${e.responseHeaders && Object.keys(e.responseHeaders).length ? `
          <div class="ev-detail-section">
            <span class="ev-detail-label">Response Headers</span>
            <pre class="ev-pre">${esc(Object.entries(e.responseHeaders).map(([k, v]) => k + ': ' + v).join('\n'))}</pre>
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
  epWarns.textContent = allEvents.filter(e => e.level === 'warn' || (e._src === 'network' && e.status >= 400 && e.status < 500)).length;
  epNet.textContent = allEvents.filter(e => e._src === 'network').length;
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
  overlay.id = 'session-overlay';
  overlay.className = 'session-overlay';
  overlay.innerHTML = buildSessionHTML(rec);
  document.body.appendChild(overlay);

  // Conectar video
  const video = overlay.querySelector('#session-video');
  video.src = rec.url;

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
    const id = btn.dataset.detailId;
    const detail = document.getElementById(id + '-detail');
    if (!detail) return;
    const open = detail.style.display === 'none';
    detail.style.display = open ? 'block' : 'none';
    btn.textContent = open ? '▼' : '▶';
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
  const scroll = overlay.querySelector('.sess-events-scroll');
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
    case 'error': return events.filter(e => e.severity === 'error' || e.level === 'error' || e.level === 'assert');
    case 'network': return events.filter(e => e._src === 'network');
    case 'console': return events.filter(e => e._src === 'console');
    default: return events;
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
  bgMsg('SET_RECORDING', { value: isRecording }).catch(() => { });
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
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtSize(b) {
  return b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

function shortUrl(url) {
  try { const u = new URL(url); return u.hostname + u.pathname.slice(0, 50); } catch { return url.slice(0, 60); }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgPlay() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><polygon points="3,2 14,8 3,14" fill="currentColor"/></svg>`; }
function svgPause() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>`; }

// ── Expandir/colapsar detalle — delegación de eventos (CSP-safe) ─────────
eventsScroll.addEventListener('click', e => {
  const btn = e.target.closest('.ev-expand');
  if (!btn) return;
  const id = btn.dataset.detailId;
  const detail = document.getElementById(id + '-detail');
  if (!detail) return;
  const open = detail.style.display === 'none';
  detail.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '▼' : '▶';
});

// ── Init ──────────────────────────────────────────────────────────────────
applyState('idle');