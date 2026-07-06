import { state, pendingRequests, responseBodyCapture, recordedTabIds, 
    SESSION_KEY, MAX_EVENTS,
    SENSITIVE_KEY_PATTERN,
    SENSITIVE_HEADER_NAMES,
    MAX_BODY_CHARS,
    MAX_RESULTS_PER_STEP
} from '../globalState.js';
import { broadcast } from "./RecorderUtils.js";



function redactHeaders(headers) {
    if (!headers) return headers;
    return headers.map((h) => {
        const isSensitive = SENSITIVE_HEADER_NAMES.has((h.name || "").toLowerCase());
        return { name: h.name, value: isSensitive ? "[REDACTED]" : h.value };
    });
}

function redactObjectDeep(obj) {
    if (Array.isArray(obj)) return obj.map(redactObjectDeep);
    if (obj && typeof obj === "object") {
        const out = {};
        for (const key of Object.keys(obj)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactObjectDeep(obj[key]);
        }
        return out;
    }
    return obj;
}

function redactBodyString(text) {
    if (!text) return text;
    try {
        const parsed = JSON.parse(text);
        return JSON.stringify(redactObjectDeep(parsed));
    } catch (e) {
        // No es JSON: redacta pares clave=valor típicos de formularios/querystrings
        return text.replace(
            /((?:password|pwd|secret|token|api[_-]?key|cvv|cvc)[^=&\n]*)=([^&\n]+)/gi,
            "$1=[REDACTED]"
        );
    }
}

function redactFormData(formData) {
    const out = {};
    for (const key of Object.keys(formData || {})) {
        out[key] = SENSITIVE_KEY_PATTERN.test(key) ? ["[REDACTED]"] : formData[key];
    }
    return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function addNetworkEvent(event) {
    state.networkEvents.unshift(event);
    if (state.networkEvents.length > MAX_EVENTS) state.networkEvents.length = MAX_EVENTS;
    persist();
    broadcast({ type: 'NETWORK_EVENT', event });
}

function addConsoleEvent(event) {
    state.consoleEvents.unshift(event);
    if (state.consoleEvents.length > MAX_EVENTS) state.consoleEvents.length = MAX_EVENTS;
    persist();
    broadcast({ type: 'CONSOLE_EVENT', event });
}

function persist() {
    browser.storage.local.set({
        [SESSION_KEY]: { capturing:state.capturing, captureTabId:state.captureTabId, networkEvents: state.networkEvents, consoleEvents: state.consoleEvents }
    });
}
// =====================================================================
// Captura de red: headers, body de petición/respuesta y status, por paso
// =====================================================================

function shouldTrackRequest(details) {
    if (!state.isRecording) return false;
    if (details.tabId == null || details.tabId < 0) return false;
    return recordedTabIds.has(details.tabId);
}

function extractRequestBody(requestBody) {
    if (!requestBody) return null;
    try {
        if (requestBody.error) {
            return { type: "error", data: requestBody.error };
        }
        if (requestBody.formData) {
            return { type: "formData", data: redactFormData(requestBody.formData) };
        }
        if (requestBody.raw) {
            const decoder = new TextDecoder("utf-8");
            let combined = "";
            let truncated = false;
            for (const part of requestBody.raw) {
                if (!part.bytes) continue;
                if (combined.length >= MAX_BODY_CHARS) {
                    truncated = true;
                    continue;
                }
                combined += decoder.decode(part.bytes, { stream: true });
            }
            if (combined.length > MAX_BODY_CHARS) {
                combined = combined.slice(0, MAX_BODY_CHARS);
                truncated = true;
            }
            return { type: "raw", data: redactBodyString(combined), truncated };
        }
    } catch (e) {
        return { type: "error", data: "No se pudo leer el cuerpo de la petición" };
    }
    return null;
}

/**
 * Intenta capturar el cuerpo de la respuesta usando StreamFilter
 * (API exclusiva de Firefox). Solo se intenta para llamadas tipo
 * xmlhttprequest/fetch, ya que son las relevantes para un caso de uso
 * (se evita interceptar imágenes, fuentes, scripts, etc.)
 */
function maybeCaptureResponseBody(details) {
    // console.log('maybeCaptureResponseBody 124');
    if (details.type !== "xmlhttprequest" && details.type !== "fetch") return;
    if (typeof browser.webRequest.filterResponseData !== "function") return;

    try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        const chunks = [];
        let total = 0;

        filter.ondata = (event) => {
            if (total < MAX_BODY_CHARS * 2) {
                chunks.push(event.data);
                total += event.data.byteLength;
            }
            filter.write(event.data); // deja pasar el dato intacto, no se modifica la respuesta real
        };

        filter.onstop = () => {
            try {
                const { buffer, total: totalBytes } = mergeArrayBuffers(chunks, MAX_BODY_CHARS);
                const decoder = new TextDecoder("utf-8");
                const text = decoder.decode(buffer);
                responseBodyCapture.set(details.requestId, {
                    preview: redactBodyString(text),
                    truncated: totalBytes > MAX_BODY_CHARS
                });
            } catch (e) {
                /* contenido binario o no decodificable como texto: se omite el body */
            }
            try {
                filter.disconnect();
            } catch (e) { }
        };

        filter.onerror = () => {
            try {
                filter.disconnect();
            } catch (e) { }
        };
    } catch (e) {
        /* filterResponseData no disponible para este tipo de petición */
    }
}
function finalizeRequest(details, error) {
    // console.log('finalizeRequest details ', details);
    // console.log('finalizeRequest error ', error);
    const entry = pendingRequests.get(details.requestId);
    if (!entry) return;
    pendingRequests.delete(details.requestId);

    if (!shouldTrackRequest(details)) {
        responseBodyCapture.delete(details.requestId);
        return;
    }

    entry.fromCache = !!details.fromCache;
    entry.finishedAt = nowISO();
    entry.durationMs = Math.round(details.timeStamp - entry.timeStampStart);
    entry.error = error || null;
    if (details.statusCode) entry.statusCode = details.statusCode;

    const bodyCapture = responseBodyCapture.get(details.requestId);
    if (bodyCapture) {
        entry.responseBodyPreview = bodyCapture.preview;
        entry.responseBodyTruncated = bodyCapture.truncated;
        responseBodyCapture.delete(details.requestId);
    }

    delete entry.timeStampStart;
    attachResult("network", entry);
}

export {
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
}