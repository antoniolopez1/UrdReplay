// ─── UrdReplay · Content Script ──────────────────────────────────────────────
(function () {
  'use strict';

  let capturing = false;
  let recording = false;

  // ── Inyectar hook en el contexto de página ────────────────────────────────
  // Necesitamos acceso al console y fetch/XHR reales de la página,
  // que viven en el "page world", no en el "isolated world" del content script.
  function injectPageHook() {
    const script = document.createElement('script');
    script.textContent = `
(function () {
  // ── Console ──────────────────────────────────────────────────────────────
  const _methods  = ['log','info','warn','error','debug','assert','table','trace'];
  const _original = {};
  _methods.forEach(method => {
    _original[method] = console[method].bind(console);
    console[method] = function (...args) {
      _original[method](...args);
      try {
        const message = args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return '[circular]'; }
        }).join(' ');
        window.dispatchEvent(new CustomEvent('__devjam_console__', { detail: {
          level: method === 'assert' ? 'error' : method,
          message: message.slice(0, 2000),
          timestamp: Date.now(),
          url: location.href,
        }}));
      } catch {}
    };
  });

  window.addEventListener('error', e => {
    window.dispatchEvent(new CustomEvent('__devjam_console__', { detail: {
      level: 'error',
      message: e.message + (e.filename ? ' — ' + e.filename + ':' + e.lineno : ''),
      timestamp: Date.now(), url: location.href,
    }}));
  });

  window.addEventListener('unhandledrejection', e => {
    window.dispatchEvent(new CustomEvent('__devjam_console__', { detail: {
      level: 'error',
      message: 'Unhandled rejection: ' + String(e.reason),
      timestamp: Date.now(), url: location.href,
    }}));
  });

  // ── Fetch interceptor (para capturar request/response body) ──────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url    = typeof input === 'string' ? input : input?.url ?? '';
    const method = (init.method ?? (typeof input === 'object' ? input.method : null) ?? 'GET').toUpperCase();

    // Capturar request body
    let requestBody = null;
    try {
      const rawBody = init.body ?? (typeof input === 'object' ? input.body : null);
      if (rawBody) {
        if (typeof rawBody === 'string') requestBody = rawBody.slice(0, 4000);
        else if (rawBody instanceof FormData) {
          const obj = {};
          rawBody.forEach((v, k) => { obj[k] = v; });
          requestBody = JSON.stringify(obj).slice(0, 4000);
        } else if (rawBody instanceof URLSearchParams) {
          requestBody = rawBody.toString().slice(0, 4000);
        } else {
          requestBody = '[binary]';
        }
      }
    } catch {}

    const t0  = performance.now();
    let response;
    try {
      response = await _fetch(input, init);
    } catch (err) {
      window.dispatchEvent(new CustomEvent('__devjam_network__', { detail: {
        url, method, status: 0, error: err.message,
        duration: Math.round(performance.now() - t0),
        requestBody, responseBody: null,
        requestHeaders: Object.fromEntries(Object.entries(init.headers ?? {})),
        timestamp: Date.now(),
      }}));
      throw err;
    }

    // Clonar para leer body sin consumirlo
    const clone = response.clone();
    let responseBody = null;
    try {
      const ct = response.headers.get('content-type') ?? '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('javascript')) {
        responseBody = (await clone.text()).slice(0, 8000);
      } else {
        responseBody = '[binary ' + ct + ']';
      }
    } catch {}

    // Capturar headers de respuesta
    const responseHeaders = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });

    window.dispatchEvent(new CustomEvent('__devjam_network__', { detail: {
      url, method,
      status:          response.status,
      statusText:      response.statusText,
      duration:        Math.round(performance.now() - t0),
      requestBody,
      responseBody,
      requestHeaders:  Object.fromEntries(Object.entries(init.headers ?? {})),
      responseHeaders,
      contentType:     response.headers.get('content-type') ?? '',
      timestamp:       Date.now(),
    }}));

    return response;
  };

  // ── XMLHttpRequest interceptor ────────────────────────────────────────────
  const _XHR  = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr    = new _XHR();
    let _method  = 'GET';
    let _url     = '';
    let _reqBody = null;
    let _t0      = 0;
    const _reqHeaders = {};

    const _open = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _method = method.toUpperCase();
      _url    = url;
      return _open(method, url, ...rest);
    };

    const _setHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (k, v) {
      _reqHeaders[k] = v;
      return _setHeader(k, v);
    };

    const _send = xhr.send.bind(xhr);
    xhr.send = function (body) {
      _t0 = performance.now();
      if (body) {
        try {
          _reqBody = typeof body === 'string' ? body.slice(0, 4000) : '[binary]';
        } catch {}
      }

      xhr.addEventListener('loadend', () => {
        let responseBody = null;
        try {
          const ct = xhr.getResponseHeader('content-type') ?? '';
          if (ct.includes('json') || ct.includes('text') || ct.includes('xml')) {
            responseBody = (xhr.responseText ?? '').slice(0, 8000);
          } else {
            responseBody = '[binary]';
          }
        } catch {}

        // Parsear todos los response headers
        const responseHeaders = {};
        try {
          xhr.getAllResponseHeaders().trim().split('\\r\\n').forEach(line => {
            const idx = line.indexOf(': ');
            if (idx > 0) responseHeaders[line.slice(0, idx)] = line.slice(idx + 2);
          });
        } catch {}

        window.dispatchEvent(new CustomEvent('__devjam_network__', { detail: {
          url:             _url,
          method:          _method,
          status:          xhr.status,
          statusText:      xhr.statusText,
          duration:        Math.round(performance.now() - _t0),
          requestBody:     _reqBody,
          responseBody,
          requestHeaders:  _reqHeaders,
          responseHeaders,
          contentType:     xhr.getResponseHeader('content-type') ?? '',
          timestamp:       Date.now(),
        }}));
      });

      return _send(body);
    };

    return xhr;
  };

})();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // ── Escuchar eventos del hook ─────────────────────────────────────────────
  window.addEventListener('__devjam_console__', e => {
    if (!capturing) return;
    browser.runtime.sendMessage({
      type: 'CONSOLE_EVENT',
      event: { type: 'console', ...e.detail },
    }).catch(() => {});
  });

  window.addEventListener('__devjam_network__', e => {
    if (!capturing) return;
    browser.runtime.sendMessage({
      type: 'NETWORK_BODY',
      ...e.detail,
    }).catch(() => {});
  });

  // ── Órdenes del background ────────────────────────────────────────────────
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'SET_CAPTURING') capturing = msg.value;
    if (msg.type === 'SET_RECORDING') recording = msg.value;
  });

  // ── Cursor tracking ───────────────────────────────────────────────────────
  let cursorThrottle = null;
  document.addEventListener('mousemove', e => {
    if (!recording) return;
    if (cursorThrottle) return;
    cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 32);
    browser.runtime.sendMessage({
      type: 'CURSOR_MOVE',
      x:    e.clientX,
      y:    e.clientY,
      dpr:  window.devicePixelRatio || 1,
    }).catch(() => {});
  }, { passive: true });

  injectPageHook();
})();
