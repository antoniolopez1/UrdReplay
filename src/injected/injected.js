(() => {

    // Evitar doble inyección
    if (window.__DEVJAM_INJECTED__) return;
    window.__DEVJAM_INJECTED__ = true;

    const MAX_BODY_SIZE = 8000;

    // ─────────────────────────────────────────────────────────────
    // UTIL: safe stringify
    // ─────────────────────────────────────────────────────────────
    function safeSerialize(value) {
        try {
            if (typeof value === 'string') return value;
            if (value instanceof FormData) {
                const obj = {};
                value.forEach((v, k) => obj[k] = v);
                return JSON.stringify(obj);
            }
            if (value instanceof URLSearchParams) {
                return value.toString();
            }
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            return String(value);
        } catch {
            return '[unserializable]';
        }
    }

    function trim(str) {
        if (!str) return str;
        return str.length > MAX_BODY_SIZE ? str.slice(0, MAX_BODY_SIZE) : str;
    }

    // ─────────────────────────────────────────────────────────────
    // CONSOLE HOOK
    // ─────────────────────────────────────────────────────────────
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'assert', 'table', 'trace'];
    const originalConsole = {};

    methods.forEach(method => {
        originalConsole[method] = console[method].bind(console);

        console[method] = (...args) => {
            originalConsole[method](...args);

            window.dispatchEvent(new CustomEvent('__devjam_console__', {
                detail: {
                    level: method === 'assert' ? 'error' : method,
                    message: trim(args.map(safeSerialize).join(' ')),
                    timestamp: Date.now(),
                    url: location.href
                }
            }));
        };
    });

    window.addEventListener('error', (e) => {
        window.dispatchEvent(new CustomEvent('__devjam_console__', {
            detail: {
                level: 'error',
                message: `${e.message} ${e.filename ? e.filename + ':' + e.lineno : ''}`,
                timestamp: Date.now(),
                url: location.href
            }
        }));
    });

    window.addEventListener('unhandledrejection', (e) => {
        window.dispatchEvent(new CustomEvent('__devjam_console__', {
            detail: {
                level: 'error',
                message: 'Unhandled rejection: ' + String(e.reason),
                timestamp: Date.now(),
                url: location.href
            }
        }));
    });

    // ─────────────────────────────────────────────────────────────
    // FETCH HOOK
    // ─────────────────────────────────────────────────────────────
    const _fetch = window.fetch.bind(window);

    window.fetch = async function (input, init = {}) {

        const start = performance.now();

        const url = typeof input === 'string'
            ? input
            : input?.url || '';

        const method = (
            init.method ||
            input?.method ||
            'GET'
        ).toUpperCase();

        let requestBody = null;

        try {
            const rawBody = init.body || input?.body;

            if (rawBody) {
                requestBody = trim(safeSerialize(rawBody));
            }
        } catch { }

        try {

            const response = await _fetch(input, init);

            const clone = response.clone();

            let responseBody = null;

            try {
                const ct = response.headers.get('content-type') || '';

                if (
                    ct.includes('json') ||
                    ct.includes('text') ||
                    ct.includes('xml') ||
                    ct.includes('javascript')
                ) {
                    responseBody = trim(await clone.text());
                } else {
                    responseBody = `[binary ${ct}]`;
                }
            } catch {
                responseBody = null;
            }

            const responseHeaders = {};
            response.headers.forEach((v, k) => responseHeaders[k] = v);

            const finalUrl = response.url || absoluteUrl(url);

            window.dispatchEvent(new CustomEvent('__devjam_network__', {
                detail: {
                    transport: 'fetch',
                    url: finalUrl,
                    method,
                    status: response.status,
                    statusText: response.statusText,
                    duration: Math.round(performance.now() - start),
                    requestBody,
                    responseBody,
                    requestHeaders: init.headers || {},
                    responseHeaders,
                    timestamp: Date.now()
                }
            }));

            return response;

        } catch (err) {

            window.dispatchEvent(new CustomEvent('__devjam_network__', {
                detail: {
                    transport: 'fetch',
                    url,
                    method,
                    status: 0,
                    error: err.message,
                    duration: Math.round(performance.now() - start),
                    requestBody,
                    responseBody: null,
                    timestamp: Date.now()
                }
            }));

            throw err;
        }
    };

    // ─────────────────────────────────────────────────────────────
    // XHR HOOK (incluye Axios)
    // ─────────────────────────────────────────────────────────────
    const OriginalXHR = window.XMLHttpRequest;

    function absoluteUrl(url) {
        try {
            return new URL(url, window.location.href).href;
        } catch {
            return url;
        }
    }

    function XHRProxy() {

        const xhr = new OriginalXHR();

        let _url = '';
        let _method = 'GET';
        let _start = 0;
        let _requestHeaders = {};
        let _requestBody = null;

        const open = xhr.open;
        const send = xhr.send;
        const setHeader = xhr.setRequestHeader;

        xhr.open = function (method, url, ...rest) {
            _method = method.toUpperCase();
            _url = url;
            return open.apply(this, [method, url, ...rest]);
        };

        xhr.setRequestHeader = function (k, v) {
            _requestHeaders[k] = v;
            return setHeader.apply(this, [k, v]);
        };

        xhr.send = function (body) {

            _start = performance.now();

            _requestBody = body ? trim(safeSerialize(body)) : null;

            xhr.addEventListener('loadend', () => {

                let responseBody = null;

                try {
                    const ct = xhr.getResponseHeader('content-type') || '';

                    if (
                        ct.includes('json') ||
                        ct.includes('text') ||
                        ct.includes('xml')
                    ) {
                        responseBody = trim(xhr.responseText);
                    } else {
                        responseBody = `[binary ${ct}]`;
                    }
                } catch { }

                const responseHeaders = {};

                try {
                    xhr.getAllResponseHeaders()
                        .trim()
                        .split('\r\n')
                        .forEach(line => {
                            const idx = line.indexOf(': ');
                            if (idx > -1) {
                                responseHeaders[line.slice(0, idx)] = line.slice(idx + 2);
                            }
                        });
                } catch { }
                const finalUrl = xhr.responseURL || absoluteUrl(_url);

                window.dispatchEvent(new CustomEvent('__devjam_network__', {
                    detail: {
                        transport: 'xhr',
                        url: finalUrl,
                        method: _method,
                        status: xhr.status,
                        statusText: xhr.statusText,
                        duration: Math.round(performance.now() - _start),
                        requestBody: _requestBody,
                        responseBody,
                        requestHeaders: _requestHeaders,
                        responseHeaders,
                        timestamp: Date.now()
                    }
                }));
            });

            return send.apply(this, [body]);
        };

        return xhr;
    }

    window.XMLHttpRequest = XHRProxy;

})();