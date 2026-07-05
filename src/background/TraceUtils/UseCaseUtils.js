import { state } from '../globalState.js';

const STORAGE_KEY = "recorderState";

/*Funciones UrdTrace */
// ---------- Utilidades generales ----------


function uid() {
    return "case_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function nowISO() {
    return new Date().toISOString();
}

function safePathFromUrl(url) {
    try {
        const u = new URL(url);
        return u.pathname + (u.search || "");
    } catch (e) {
        return url;
    }
}

function isTrackableUrl(url) {
    if (!url) return false;
    return !(
        url.startsWith("about:") ||
        url.startsWith("moz-extension:") ||
        url.startsWith("chrome:") ||
        url.startsWith("data:")
    );
}

async function persistState() {
    console.log('persistEvent');
    await browser.storage.local.set({ [STORAGE_KEY]: state });
}

async function loadState() {
    const data = await browser.storage.local.get(STORAGE_KEY);
    if (data && data[STORAGE_KEY]) {
        state.isRecording = data[STORAGE_KEY].isRecording;
        state.scope = data[STORAGE_KEY].scope;
        state.tabId = data[STORAGE_KEY].tabId;
        state.windowId = data[STORAGE_KEY].windowId;
        state.currentCase = data[STORAGE_KEY].currentCase;
        state.savedCases = data[STORAGE_KEY].savedCases;
        // state = data[STORAGE_KEY];
    }
}

function nextStep() {
    return state.currentCase ? state.currentCase.events.length + 1 : 1;
}

function pushEvent(eventData) {
    console.log('pushEvent eventData', eventData);
    if (!state.isRecording || !state.currentCase) return null;
    const event = {
        step: nextStep(),
        timestamp: nowISO(),
        results: { network: [], console: [], errors: [] },
        ...eventData
    };
    state.currentCase.events.push(event);
    persistState();
    return event;
}

function matchesScope(tabId, windowId) {
    if (!state.isRecording) return false;
    if (state.scope === "tab") return tabId === state.tabId;
    if (state.scope === "window") return windowId === state.windowId;
    return false;
}

/**
 * Adjunta un "resultado" (red, consola o error) al último paso de usuario
 * registrado. Así cada paso queda con la evidencia de lo que provocó.
 */
function attachResult(category, payload) {
    if (!state.isRecording || !state.currentCase || state.currentCase.events.length === 0) return;
    const lastEvent = state.currentCase.events[state.currentCase.events.length - 1];
    if (!lastEvent.results) lastEvent.results = { network: [], console: [], errors: [] };
    const bucket = lastEvent.results[category];
    if (!bucket) return;

    if (bucket.length >= MAX_RESULTS_PER_STEP) {
        lastEvent.results.truncated = true;
        return;
    }
    bucket.push({ timestamp: nowISO(), ...payload });
    persistState();
}


function deleteCase(caseId) {
    state.savedCases = state.savedCases.filter((c) => c.id !== caseId);
    return persistState();
}

function clearAllCases() {
    state.savedCases = [];
    return persistState();
}
async function handleNavigationEvent(tabId, url) {
    if (!state.isRecording) return;
    try {
        const tab = await browser.tabs.get(tabId);
        if (!matchesScope(tabId, tab.windowId)) return;
        pushEvent({
            type: "navigation",
            description: `Usuario navega a ${safePathFromUrl(url)}`,
            url
        });
    } catch (e) {
        /* la pestaña pudo haberse cerrado ya */
    }
}

/**Fin funciones UrdTrace despues cambiar a archivo */

export { 
    clearAllCases,
    deleteCase,
    handleNavigationEvent, 
    isTrackableUrl, 
    loadState, 
    matchesScope,
    nowISO, 
    persistState, 
    pushEvent, 
    uid, 
    safePathFromUrl,
}; 