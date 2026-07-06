// Estado persistido (se guarda en storage.local en cada cambio)
const state = {
    isRecording: false,
    capturing: false,
    captureTabId: null,
    networkEvents: [],
    consoleEvents: [],
    scope: null,        // 'tab' | 'window'
    tabId: null,
    windowId: null,
    currentCase: null,  // { id, title, scope, startedAt, events: [...] }
    savedCases: []       // casos finalizados, cada uno con su propio título
};

let recordedTabIds = new Set();// pestañas dentro del alcance actual (para webRequest)

const pendingRequests = new Map();
const responseBodyCapture = new Map(); // requestId -> { preview, truncated }

const SESSION_KEY = 'urd_session';
const MAX_EVENTS = 500;

// ---------- Redacción de datos sensibles (headers / bodies) ----------

const SENSITIVE_KEY_PATTERN = /pass(word)?|pwd|secret|token|api[_-]?key|auth|card(num|number)?|cvv|cvc|ssn/i;
const SENSITIVE_HEADER_NAMES = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "proxy-authorization"
]);
// Límites para no disparar el tamaño de storage con bodies/console grandes
const MAX_BODY_CHARS = 20000;       // tope de texto guardado por body de red
const MAX_RESULTS_PER_STEP = 60;    // tope de entradas (red/consola/errores) por paso


export { state, recordedTabIds, 
    pendingRequests, responseBodyCapture, 
    SESSION_KEY, MAX_EVENTS,
    SENSITIVE_KEY_PATTERN,
    SENSITIVE_HEADER_NAMES,
    MAX_BODY_CHARS,
    MAX_RESULTS_PER_STEP
}