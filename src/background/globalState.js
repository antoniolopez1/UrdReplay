// Estado persistido (se guarda en storage.local en cada cambio)
const state = {
    isRecording: false,
    scope: null,        // 'tab' | 'window'
    tabId: null,
    windowId: null,
    currentCase: null,  // { id, title, scope, startedAt, events: [...] }
    savedCases: []       // casos finalizados, cada uno con su propio título
};

let recordedTabIds = new Set();// pestañas dentro del alcance actual (para webRequest)

const pendingRequests = new Map();
const responseBodyCapture = new Map(); // requestId -> { preview, truncated }

export { state, recordedTabIds, pendingRequests, responseBodyCapture }