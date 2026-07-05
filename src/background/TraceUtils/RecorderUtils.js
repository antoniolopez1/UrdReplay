import { state, pendingRequests, responseBodyCapture } from '../globalState.js';
import { uid, nowISO, isTrackableUrl, persistState, pushEvent, safePathFromUrl } from './UseCaseUtils.js'
// ---------- Acciones principales de grabación ----------

let recordedTabIds = new Set();// pestañas dentro del alcance actual (para webRequest)
// let state = {
//     isRecording: false,
//     scope: null,        // 'tab' | 'window'
//     tabId: null,
//     windowId: null,
//     currentCase: null,  // { id, title, scope, startedAt, events: [...] }
//     savedCases: []       // casos finalizados, cada uno con su propio título
// };

async function rebuildRecordedTabIds() {
    console.log('function rebuild RecordedTabIds 16');
    recordedTabIds = new Set();
    if (!state.isRecording) return;
    if (state.scope === "tab" && state.tabId != null) {
        console.log('asigna tab id');
        recordedTabIds.add(state.tabId);
    } else if (state.scope === "window" && state.windowId != null) {
        try {
            const tabs = await browser.tabs.query({ windowId: state.windowId });
            tabs.forEach((t) => recordedTabIds.add(t.id));
        } catch (e) {
            /* la ventana pudo haberse cerrado */
        }
    }
}

async function startRecording({ title, scope }) {
    console.log('starting recording 20', state);
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    console.log('activeTab', activeTab);
    if (!activeTab) throw new Error("No se encontró una pestaña activa.");

    state.isRecording = true;
    console.log('asigna isRecording true');
    state.scope = scope; // 'tab' | 'window'
    state.tabId = activeTab.id;
    state.windowId = activeTab.windowId;
    state.currentCase = {
        id: uid(),
        title: title && title.trim() ? title.trim() : "Caso sin título",
        scope,
        startedAt: nowISO(),
        finishedAt: null,
        events: []
    };
    console.log('state 49', state);
    pendingRequests.clear();
    responseBodyCapture.clear();
    await rebuildRecordedTabIds();
    console.log('start recording 55', activeTab.url);
    // Evento inicial: dónde empieza el usuario
    if (isTrackableUrl(activeTab.url)) {
        pushEvent({
            type: "navigation",
            description: `Usuario inicia en ${safePathFromUrl(activeTab.url)}`,
            url: activeTab.url
        });
    }
    console.log('persistState');
    await persistState();
    await notifyTabsRecordingChanged(true);
    console.log('state startRecording end function', state);
    return state;
}

async function stopRecording() {
    if (state.currentCase) {
        state.currentCase.finishedAt = nowISO();
        state.savedCases.push(state.currentCase);
    }
    const finished = state.currentCase;
    state.isRecording = false;
    state.currentCase = null;
    const oldScope = state.scope;
    const oldTabId = state.tabId;
    const oldWindowId = state.windowId;
    state.scope = null;
    state.tabId = null;
    state.windowId = null;

    recordedTabIds = new Set();
    pendingRequests.clear();
    responseBodyCapture.clear();

    await persistState();
    await notifyTabsRecordingChanged(false, oldScope, oldTabId, oldWindowId);
    return finished;
}

async function notifyTabsRecordingChanged(recording, scope, tabId, windowId) {
    console.log('notifyTabsRecordingChanged');
    // Avisa a los content scripts ya cargados que deben empezar/parar de capturar,
    // sin esperar a que recarguen la página.
    try {
        const targetScope = recording ? state.scope : scope;
        const targetTabId = recording ? state.tabId : tabId;
        const targetWindowId = recording ? state.windowId : windowId;

        let tabsToNotify = [];
        if (targetScope === "tab" && targetTabId != null) {
            tabsToNotify = [targetTabId];
        } else if (targetScope === "window" && targetWindowId != null) {
            const tabs = await browser.tabs.query({ windowId: targetWindowId });
            tabsToNotify = tabs.map((t) => t.id);
        }

        for (const id of tabsToNotify) {
            browser.tabs.sendMessage(id, { action: "SET_RECORDING1", recording }).catch(() => { });
        }
    } catch (e) {
        /* pestañas privilegiadas (about:, etc.) no aceptan mensajes; se ignora */
    }
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
function mergeArrayBuffers(chunks, maxBytes) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const size = Math.min(total, maxBytes);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
        if (offset >= size) break;
        const arr = new Uint8Array(c);
        const toCopy = Math.min(arr.byteLength, size - offset);
        result.set(arr.subarray(0, toCopy), offset);
        offset += toCopy;
    }
    return { buffer: result.buffer, total };
}

export { startRecording, stopRecording, rebuildRecordedTabIds, broadcast };