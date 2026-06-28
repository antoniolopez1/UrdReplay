// ─── UrdReplay · Background Service Worker ───────────────────────────────────

const SESSION_KEY = 'devjam_session';
const MAX_EVENTS  = 500;

// ── Estado ────────────────────────────────────────────────────────────────
let capturing     = false;
let captureTabId  = null;   // null = todas las pestañas, número = solo esa
let recording     = false;
let networkEvents = [];
let consoleEvents = [];

browser.storage.local.get(SESSION_KEY).then(result => {
  const saved = result[SESSION_KEY];
  if (saved) {
    capturing     = saved.capturing    ?? false;
    captureTabId  = saved.captureTabId ?? null;
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
        } catch {}
      } else if (details.requestBody.formData) {
        requestBody = JSON.stringify(details.requestBody.formData);
      }
    }

    pendingRequests.set(details.requestId, {
      id:          details.requestId,
      type:        'network',
      method:      details.method,
      url:         details.url,
      startTime:   details.timeStamp,
      tabId:       details.tabId,
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
    const rawHeaders      = details.responseHeaders ?? [];
    const responseHeaders = {};
    for (const h of rawHeaders) responseHeaders[h.name.toLowerCase()] = h.value;
    const contentType     = responseHeaders['content-type'] ?? '';
    const contentLength   = responseHeaders['content-length'] ?? null;

    const event = {
      ...req,
      status:          details.statusCode,
      duration:        Math.round(details.timeStamp - req.startTime),
      contentType,
      contentLength:   contentLength ? parseInt(contentLength) : null,
      responseHeaders,
      timestamp:       Date.now(),
      severity:        details.statusCode >= 500 ? 'error'
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
      id:        details.requestId,
      type:      'network',
      method:    req?.method ?? '?',
      url:       details.url,
      status:    0,
      error:     details.error,
      duration:  req ? Math.round(details.timeStamp - req.startTime) : 0,
      timestamp: Date.now(),
      severity:  'error',
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
let framePushTimer = null;

function startFramePush(tabId, fps) {
  stopFramePush();
  const interval = Math.round(1000 / Math.min(fps, 30));
  let   busy     = false;
  let   windowId = null;

  browser.tabs.get(tabId).then(tab => { windowId = tab.windowId; }).catch(() => {});

  framePushTimer = setInterval(async () => {
    if (busy || windowId === null) return;
    busy = true;
    try {
      const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
        format: 'jpeg', quality: 80,
      });
      browser.runtime.sendMessage({ type: 'FRAME_DATA', dataUrl }).catch(() => {});
    } catch {}
    busy = false;
  }, interval);
}

function stopFramePush() {
  if (framePushTimer) { clearInterval(framePushTimer); framePushTimer = null; }
}

// ── Broadcast ──────────────────────────────────────────────────────────────
function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
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
        ev.responseBody    = msg.responseBody;
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
      capturing    = msg.value;
      captureTabId = msg.tabId ?? null;   // null = todas las pestañas
      persist();
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          browser.tabs.sendMessage(tab.id, {
            type: 'SET_CAPTURING', value: capturing
          }).catch(() => {});
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
          }).catch(() => {});
        });
      });
      sendResponse({ ok: true });
      return true;

    case 'CURSOR_MOVE':
      broadcast({ type: 'CURSOR_MOVE', x: msg.x, y: msg.y, dpr: msg.dpr });
      break;

    case 'START_FRAME_PUSH':
      startFramePush(msg.tabId, msg.fps);
      sendResponse({ ok: true });
      return true;

    case 'STOP_FRAME_PUSH':
      stopFramePush();
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
