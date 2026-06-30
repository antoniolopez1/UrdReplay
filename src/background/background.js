// ─── DevJam · Background Service Worker ───────────────────────────────────

const SESSION_KEY = 'devjam_session';
const MAX_EVENTS = 500;

// ── Estado ────────────────────────────────────────────────────────────────
let capturing = false;
let captureTabId = null;   // null = todas las pestañas, número = solo esa
let recording = false;
let networkEvents = [];
let consoleEvents = [];

browser.storage.local.get(SESSION_KEY).then(result => {
  const saved = result[SESSION_KEY];
  if (saved) {
    capturing = saved.capturing ?? false;
    captureTabId = saved.captureTabId ?? null;
    networkEvents = saved.networkEvents ?? [];
    consoleEvents = saved.consoleEvents ?? [];
  }
});

// ── Captura de red ─────────────────────────────────────────────────────────
const pendingRequests = new Map();

browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (!capturing) return;
    if (captureTabId !== null && details.tabId !== captureTabId) return;

    // Capturar body del request cuando está disponible
    let requestBody = null;
    if (details.requestBody) {
      if (details.requestBody.raw) {
        try {
          const bytes = details.requestBody.raw[0]?.bytes;
          if (bytes) requestBody = new TextDecoder().decode(bytes).slice(0, 4000);
        } catch { }
      } else if (details.requestBody.formData) {
        requestBody = JSON.stringify(details.requestBody.formData);
      }
    }

    pendingRequests.set(details.requestId, {
      id: details.requestId,
      type: 'network',
      method: details.method,
      url: details.url,
      startTime: details.timeStamp,
      tabId: details.tabId,
      requestBody,
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

browser.webRequest.onSendHeaders.addListener(
  details => {
    if (!capturing) return;
    if (captureTabId !== null && details.tabId !== captureTabId) return;
    const req = pendingRequests.get(details.requestId);
    if (!req) return;
    // webRequest devuelve [{name, value}] — convertir a objeto plano
    req.requestHeaders = {};
    for (const h of (details.requestHeaders ?? [])) {
      req.requestHeaders[h.name.toLowerCase()] = h.value;
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

browser.webRequest.onCompleted.addListener(
  details => {
    if (!capturing) return;
    if (captureTabId !== null && details.tabId !== captureTabId) return;
    const req = pendingRequests.get(details.requestId);
    if (!req) return;

    // webRequest devuelve [{name, value}] — convertir a objeto plano
    const rawHeaders = details.responseHeaders ?? [];
    const responseHeaders = {};
    for (const h of rawHeaders) responseHeaders[h.name.toLowerCase()] = h.value;
    const contentType = responseHeaders['content-type'] ?? '';
    const contentLength = responseHeaders['content-length'] ?? null;

    const event = {
      ...req,
      status: details.statusCode,
      duration: Math.round(details.timeStamp - req.startTime),
      contentType,
      contentLength: contentLength ? parseInt(contentLength) : null,
      responseHeaders,
      timestamp: Date.now(),
      severity: details.statusCode >= 500 ? 'error'
        : details.statusCode >= 400 ? 'warn'
          : 'info',
    };

    pendingRequests.delete(details.requestId);
    addNetworkEvent(event);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

browser.webRequest.onErrorOccurred.addListener(
  details => {
    if (!capturing) return;
    if (captureTabId !== null && details.tabId !== captureTabId) return;
    const req = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);

    addNetworkEvent({
      ...(req ?? {}),
      id: details.requestId,
      type: 'network',
      method: req?.method ?? '?',
      url: details.url,
      status: 0,
      error: details.error,
      duration: req ? Math.round(details.timeStamp - req.startTime) : 0,
      timestamp: Date.now(),
      severity: 'error',
    });
  },
  { urls: ['<all_urls>'] }
);

// ── Helpers ────────────────────────────────────────────────────────────────
function addNetworkEvent(event) {
  networkEvents.unshift(event);
  if (networkEvents.length > MAX_EVENTS) networkEvents.length = MAX_EVENTS;
  persist();
  broadcast({ type: 'NETWORK_EVENT', event });
}

function addConsoleEvent(event) {
  consoleEvents.unshift(event);
  if (consoleEvents.length > MAX_EVENTS) consoleEvents.length = MAX_EVENTS;
  persist();
  broadcast({ type: 'CONSOLE_EVENT', event });
}

function persist() {
  browser.storage.local.set({
    [SESSION_KEY]: { capturing, captureTabId, networkEvents, consoleEvents }
  });
}

// ── Frame push loop ────────────────────────────────────────────────────────
// sources: array de { type: 'tab'|'window'|'screen', tabId?, windowId? }
// Para 'tab': activa la pestaña, captura, restaura la tab anterior.
// Para 'window'/'screen': el recorder usa getDisplayMedia directamente.

let framePushTimer = null;
let framePushSources = [];

async function captureTabFrame(tabId) {
  // 1. Saber qué tab está activa ahora en esa ventana
  const tab = await browser.tabs.get(tabId);
  const windowId = tab.windowId;

  // 2. Obtener la tab activa actual en esa ventana
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  const wasActive = activeTab?.id ?? null;

  // 3. Si la tab objetivo no está activa, activarla momentáneamente
  if (wasActive !== tabId) {
    await browser.tabs.update(tabId, { active: true });
    // Esperar un tick para que el browser renderice el contenido
    await new Promise(r => setTimeout(r, 16));
  }

  // 4. Capturar
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
    format: 'jpeg', quality: 80,
  });

  // 5. Restaurar la tab que estaba activa (sin await para no bloquear)
  if (wasActive !== null && wasActive !== tabId) {
    browser.tabs.update(wasActive, { active: true }).catch(() => { });
  }

  return dataUrl;
}

function startFramePush(sources, fps) {
  stopFramePush();
  framePushSources = sources;
  const interval = Math.round(1000 / Math.min(fps, 30));
  let busy = false;

  framePushTimer = setInterval(async () => {
    if (busy || framePushSources.length === 0) return;
    busy = true;
    try {
      // Capturar cada fuente y mandar su frame con su índice
      const frames = await Promise.all(
        framePushSources.map(async (src, idx) => {
          if (src.type === 'tab') {
            const dataUrl = await captureTabFrame(src.tabId);
            return { idx, dataUrl };
          }
          return null; // window/screen los maneja el recorder con getDisplayMedia
        })
      );
      for (const f of frames) {
        if (f?.dataUrl) {
          browser.runtime.sendMessage({ type: 'FRAME_DATA', idx: f.idx, dataUrl: f.dataUrl }).catch(() => { });
        }
      }
    } catch { }
    busy = false;
  }, interval);
}

function stopFramePush() {
  if (framePushTimer) { clearInterval(framePushTimer); framePushTimer = null; }
  framePushSources = [];
}

// ── Broadcast ──────────────────────────────────────────────────────────────
function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => { });
}

// ── Mensajes ───────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  switch (msg.type) {

    // El content script manda eventos de consola con su tabId
    case 'CONSOLE_EVENT': {
      if (!capturing) break;
      if (captureTabId !== null && sender.tab?.id !== captureTabId) break;
      addConsoleEvent({ ...msg.event, tabId: sender.tab?.id });
      break;
    }

    // El content script manda eventos de red enriquecidos (fetch/XHR body)
    case 'NETWORK_BODY': {
      if (!capturing) break;
      if (captureTabId !== null && sender.tab?.id !== captureTabId) break;
      // Buscar el evento de red correspondiente y agregarle el body
      const ev = networkEvents.find(e => e.url === msg.url && !e.responseBody);
      if (ev) {
        ev.responseBody = msg.responseBody;
        ev.requestBodyFull = msg.requestBody;
        persist();
        broadcast({ type: 'NETWORK_EVENT', event: ev });
      }
      break;
    }

    case 'GET_STATE':
      sendResponse({ capturing, captureTabId, recording, networkEvents, consoleEvents });
      return true;

    case 'SET_CAPTURING':
      capturing = msg.value;
      captureTabId = msg.tabId ?? null;   // null = todas las pestañas
      persist();
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          browser.tabs.sendMessage(tab.id, {
            type: 'SET_CAPTURING', value: capturing
          }).catch(() => { });
        });
      });
      sendResponse({ ok: true });
      return true;

    case 'SET_RECORDING':
      recording = msg.value;
      broadcast({ type: 'RECORDING_STATE', value: recording });
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          browser.tabs.sendMessage(tab.id, {
            type: 'SET_RECORDING', value: recording
          }).catch(() => { });
        });
      });
      sendResponse({ ok: true });
      return true;

    case 'CURSOR_MOVE':
      broadcast({ type: 'CURSOR_MOVE', x: msg.x, y: msg.y, dpr: msg.dpr });
      break;

    case 'START_FRAME_PUSH':
      // startFramePush(msg.sources, msg.fps);
      sendResponse({ ok: true });
      return true;

    case 'STOP_FRAME_PUSH':
      // stopFramePush();
      sendResponse({ ok: true });
      return true;

    case 'CLEAR_EVENTS':
      networkEvents = [];
      consoleEvents = [];
      persist();
      sendResponse({ ok: true });
      return true;

    case 'EXPORT_JSON':
      sendResponse({ data: JSON.stringify({ exported: new Date().toISOString(), networkEvents, consoleEvents }, null, 2) });
      return true;
  }
});
