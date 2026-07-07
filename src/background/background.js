import {
  finalizeRequest,
  shouldTrackRequest,
  persist,
  redactHeaders,
  redactObjectDeep,
  redactBodyString,
  redactFormData,
  addNetworkEvent,
  addConsoleEvent,
  extractRequestBody,
  maybeCaptureResponseBody
} from "./TraceUtils/NetworkUtils.js";
import { startRecording, stopRecording, rebuildRecordedTabIds, broadcast } from "./TraceUtils/RecorderUtils.js";
import {
  state, pendingRequests, recordedTabIds, SESSION_KEY,
  SENSITIVE_KEY_PATTERN,
  SENSITIVE_HEADER_NAMES,
  MAX_BODY_CHARS,
  MAX_RESULTS_PER_STEP
} from './globalState.js';
import { loadState, isTrackableUrl, handleNavigationEvent, deleteCase, matchesScope, pushEvent } from "./TraceUtils/UseCaseUtils.js";
// ─── DevJam · Background Service Worker ───────────────────────────────────



// ── Estado ────────────────────────────────────────────────────────────────
let recording = false;
// let networkEvents = [];
// let consoleEvents = [];

browser.storage.local.get(SESSION_KEY).then(result => {
  const saved = result[SESSION_KEY];
  if (saved) {
    state.capturing = saved.capturing ?? false;
    state.captureTabId = saved.captureTabId ?? null;
    state.networkEvents = saved.networkEvents ?? [];
    state.consoleEvents = saved.consoleEvents ?? [];
  }
});
/**
 * background.js
 * Controla el ciclo de vida de la grabación de un "caso de uso":
 *  - Mantiene el estado en memoria + storage.local (fuente de verdad)
 *  - Escucha navegación real y de SPA (history pushState/replaceState)
 *  - Escucha apertura/cierre de pestañas cuando el alcance es "ventana"
 *  - Recibe eventos de interacción (clics, inputs) y de "resultados"
 *    (consola, errores) que manda content.js
 *  - Captura peticiones de red (headers, body, response) vía webRequest
 *    y las adjunta como "resultado" del paso de usuario más reciente
 *  - Responde a content.js cuándo debe capturar o no (según pestaña/ventana)
 */


browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (!shouldTrackRequest(details)) return;
    if (!state.capturing) return;
    if (state.captureTabId !== null && details.tabId !== state.captureTabId) return;

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
    if (!shouldTrackRequest(details)) return;
    if (!state.capturing) return;
    if (state.captureTabId !== null && details.tabId !== state.captureTabId) return;
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
    if (!shouldTrackRequest(details)) return;
    if (!state.capturing) return;
    if (state.captureTabId !== null && details.tabId !== state.captureTabId) return;
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
    if (!state.capturing) return;
    if (state.captureTabId !== null && details.tabId !== state.captureTabId) return;
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



// ── Mensajes ───────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // console.log('message', msg);
  // console.log('sender', sender);
  switch (msg.type) {

    // El content script manda eventos de consola con su tabId
    case 'CONSOLE_EVENT': {
      if (!state.capturing) break;
      if (state.captureTabId !== null && sender.tab?.id !== state.captureTabId) break;
      addConsoleEvent({ ...msg.event, tabId: sender.tab?.id });
      break;
    }

    // El content script manda eventos de red enriquecidos (fetch/XHR body)
    case 'NETWORK_BODY': {
      // console.log('background NETWORK_BODY');
      // console.log('no se ha encontrado un evento de red', msg);
      // console.log('state.networkEvents', state.networkEvents);
      if (!state.capturing) break;
      if (state.captureTabId !== null && sender.tab?.id !== state.captureTabId) break;
      // Buscar el evento de red correspondiente y agregarle el body
      const ev = state.networkEvents.find(e => e.url === msg.url);
      if (ev) {
        ev.responseBody = msg.responseBody;
        ev.requestBodyFull = msg.requestBody;
        // state.networkEvents = [...state.networkEvents.filter(net => net.id !== ev.id), ev]; // Reemplazar el evento en la lista
        persist();
        broadcast({ type: 'NETWORK_EVENT', event: ev });
      } 
      break;
    }

    case 'GET_STATE':
      sendResponse({ capturing: state.capturing, captureTabId: state.captureTabId, recording, networkEvents: state.networkEvents, consoleEvents: state.consoleEvents });
      return true;

    case 'SET_CAPTURING':
      state.capturing = msg.value;
      state.captureTabId = msg.tabId ?? null;   // null = todas las pestañas
      persist();
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          browser.tabs.sendMessage(tab.id, {
            type: 'SET_CAPTURING', value: state.capturing
          }).catch(() => { });
        });
      });
      sendResponse({ ok: true });
      return true;

    case 'SET_RECORDING':
      recording = msg.value;
      state.isRecording = msg.value;
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
      state.networkEvents = [];
      state.consoleEvents = [];
      persist();
      sendResponse({ ok: true });
      return true;

    case 'EXPORT_JSON':
      sendResponse({ data: JSON.stringify({ exported: new Date().toISOString(), networkEvents: state.networkEvents, consoleEvents: state.consoleEvents }, null, 2) });
      return true;
  }
});

// ---------- Listeners de mensajes (popup y content scripts) ----------

browser.runtime.onMessage.addListener((message, sender) => {
  // console.log('message', message);
  // console.log('sender', sender);
  switch (message.action) {
    case "GET_RECORDING_STATE": {
      const tabId = sender.tab ? sender.tab.id : null;
      const windowId = sender.tab ? sender.tab.windowId : null;
      const recording = sender.tab ? matchesScope(tabId, windowId) : state.isRecording;
      return Promise.resolve({ recording });
    }

    case "GET_FULL_STATE": {
      // console.log('background 277', state);
      return Promise.resolve(state);
    }

    case "START_RECORDING": {
      // console.log('start recording', message.payload);
      return startRecording(message.payload);
    }

    case "STOP_RECORDING": {
      return stopRecording();
    }

    case "DELETE_CASE": {
      return deleteCase(message.caseId).then(() => state);
    }

    case "CLEAR_ALL_CASES": {
      return clearAllCases().then(() => state);
    }

    case "EVENT_CAPTURED": {
      // console.log('algocapturado');
      if (!sender.tab) return Promise.resolve(false);
      const tabId = sender.tab.id;
      const windowId = sender.tab.windowId;
      if (matchesScope(tabId, windowId)) {
        pushEvent(message.event);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }

    case "RESULT_CAPTURED": {
      // Resultado "pasivo" (consola / error) que se adjunta al último paso, no crea uno nuevo
      if (!sender.tab) return Promise.resolve(false);
      const tabId = sender.tab.id;
      const windowId = sender.tab.windowId;
      if (matchesScope(tabId, windowId)) {
        attachResult(message.category, message.data);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }

    default:
      return undefined;
  }
});

// ---------- Navegación real (carga completa de página) ----------

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // solo frame principal
  if (!isTrackableUrl(details.url)) return;
  handleNavigationEvent(details.tabId, details.url);
});

// ---------- Navegación tipo SPA (pushState / replaceState / hash) ----------

browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isTrackableUrl(details.url)) return;
  handleNavigationEvent(details.tabId, details.url);
});

browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isTrackableUrl(details.url)) return;
  handleNavigationEvent(details.tabId, details.url);
});


// ---------- Pestañas nuevas / cerradas (solo relevante con alcance "ventana") ----------

browser.tabs.onCreated.addListener((tab) => {
  if (!state.isRecording || state.scope !== "window") return;
  if (tab.windowId !== state.windowId) return;
  recordedTabIds.add(tab.id);
  pushEvent({
    type: "tab",
    description: `Usuario abre una nueva pestaña`,
    url: tab.url || null
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  recordedTabIds.delete(tabId);
  if (!state.isRecording) return;

  if (state.scope === "tab" && tabId === state.tabId) {
    // Se cerró la pestaña que se estaba grabando: detener y guardar lo capturado.
    pushEvent({ type: "tab", description: "La pestaña grabada se cerró" });
    stopRecording();
    return;
  }

  if (state.scope === "window" && tabId !== state.tabId) {
    pushEvent({ type: "tab", description: "Usuario cierra una pestaña" });
  }
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // console.log('ingresa en el listener de webRequest', details);
    // console.log('!shouldTrackRequest(details)', !shouldTrackRequest(details));
    if (!shouldTrackRequest(details)) return;

    pendingRequests.set(details.requestId, {
      requestId: details.requestId,
      method: details.method,
      url: details.url,
      resourceType: details.type,
      startedAt: nowISO(),
      timeStampStart: details.timeStamp,
      requestBody: extractRequestBody(details.requestBody),
      requestHeaders: null,
      responseHeaders: null,
      statusCode: null,
      statusLine: null,
      fromCache: null,
      finishedAt: null,
      durationMs: null,
      error: null
    });

    maybeCaptureResponseBody(details);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!shouldTrackRequest(details)) return;
    const entry = pendingRequests.get(details.requestId);
    if (!entry) return;
    entry.requestHeaders = redactHeaders(details.requestHeaders);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!shouldTrackRequest(details)) return;
    const entry = pendingRequests.get(details.requestId);
    if (!entry) return;
    entry.responseHeaders = redactHeaders(details.responseHeaders);
    entry.statusCode = details.statusCode;
    entry.statusLine = details.statusLine;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (!shouldTrackRequest(details)) return;
    finalizeRequest(details, null)
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onErrorOccurred.addListener((details) => {
  finalizeRequest(details, details.error);
}, { urls: ["<all_urls>"] });


// ---------- Inicialización ----------

loadState().then(() => {
  if (state.isRecording) rebuildRecordedTabIds();
});
