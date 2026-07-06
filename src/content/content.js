// ─── UrdReplay · Content Script ──────────────────────────────────────────────
(function () {
  // console.log("CONTENT LOADED", location.href);
  'use strict';

  let capturing = false;
  let recording = false;
  let recording1 = false; //urdTrace
  const MAX_TEXT_LENGTH = 120;
  const MAX_CONSOLE_LENGTH = 1000;

  async function refresh() {
    // console.log('refresh antes de mandar sendMessage');
    const state = await browser.runtime.sendMessage({ action: "GET_FULL_STATE" });
    // renderAll(state);
    // return state;
    capturing = state.capturing;
  }
  // ── Inyectar hook en el contexto de página ────────────────────────────────
  // Necesitamos acceso al console y fetch/XHR reales de la página,
  // que viven en el "page world", no en el "isolated world" del content script.
  function injectPageHook() {
    console.log('empieza el injectPageHook');
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("src/injected/injected.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // ── Escuchar eventos del hook ─────────────────────────────────────────────
  window.addEventListener('__devjam_console__', e => {
    if (!capturing) return;
    browser.runtime.sendMessage({
      type: 'CONSOLE_EVENT',
      event: { type: 'console', ...e.detail },
    }).catch(() => { });
  });

  window.addEventListener('__devjam_network__', async (e) => {
    await refresh();
    console.log('capturando red', capturing);
    if (!capturing) return;
    browser.runtime.sendMessage({
      type: 'NETWORK_BODY',
      ...e.detail,
    }).catch(() => { });
  });

  // ── Órdenes del background ────────────────────────────────────────────────
  browser.runtime.onMessage.addListener(msg => {
    console.log('capturing', msg);
    if (msg.type === 'SET_CAPTURING') capturing = msg.value;
    if (msg.type === 'SET_RECORDING') recording = msg.value;
    if (msg.action === 'SET_RECORDING1') recording1 = !!msg.recording;
  });


  // ── Cursor tracking ───────────────────────────────────────────────────────
  let cursorThrottle = null;
  document.addEventListener('mousemove', e => {
    if (!recording) return;
    if (cursorThrottle) return;
    cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 32);
    browser.runtime.sendMessage({
      type: 'CURSOR_MOVE',
      x: e.clientX,
      y: e.clientY,
      dpr: window.devicePixelRatio || 1,
    }).catch(() => { });
  }, { passive: true });

  //Caputura eventos de usuario
  function send(event) {
    // console.log('evento270', event);
    if (!recording1) return;
    browser.runtime.sendMessage({ action: "EVENT_CAPTURED", event }).catch(() => { });
  }
  function describeClickTarget(el) {
    console.log('describeClickTarget');
    if (!el) return { label: "elemento", selector: null, tag: null };

    const interactive = el.closest
      ? el.closest('button, a, input, select, textarea, [role="button"], [role="link"], summary')
      : el;
    const target = interactive || el;

    let label =
      getLabelFor(target) ||
      truncate(target.innerText || target.textContent || "") ||
      target.getAttribute?.("alt") ||
      target.tagName.toLowerCase();

    if (!label) label = target.tagName.toLowerCase();

    return { label, selector: getSelector(target), tag: target.tagName.toLowerCase() };
  }
  function getLabelFor(el) {
    if (!el) return null;
    if (el.getAttribute) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return truncate(ariaLabel);
    }
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && lbl.textContent.trim()) return truncate(lbl.textContent);
      } catch (e) {
        /* id con caracteres raros para CSS.escape en navegadores viejos */
      }
    }
    const parentLabel = el.closest ? el.closest("label") : null;
    if (parentLabel && parentLabel.textContent.trim()) return truncate(parentLabel.textContent);
    if (el.placeholder) return truncate(el.placeholder);
    if (el.name) return el.name;
    if (el.title) return truncate(el.title);
    return null;
  }
  function getSelector(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return `#${el.id}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;

    const path = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let selector = node.tagName.toLowerCase();
      if (node.className && typeof node.className === "string" && node.className.trim()) {
        selector += "." + node.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      path.unshift(selector);
      node = node.parentElement;
      depth++;
    }
    return path.join(" > ");
  }

  function truncate(text, max) {
    if (!text) return text;
    text = String(text).trim().replace(/\s+/g, " ");
    const limit = max || MAX_TEXT_LENGTH;
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  // ---------- Captura de clics ----------

  window.addEventListener(
    "click",
    (e) => {
      // alert(recording1);
      console.log(recording1);
      if (!recording1) return;
      const { label, selector, tag } = describeClickTarget(e.target);

      let verb = "hace clic en";
      if (tag === "a") verb = "hace clic en el enlace";
      else if (tag === "button" || (e.target.closest && e.target.closest('[role="button"]')))
        verb = "hace clic en el botón";
      else if (tag === "input" && (e.target.type === "checkbox" || e.target.type === "radio")) {
        // Estos se manejan mejor en el listener "change" para reflejar el estado final
        return;
      }

      send({
        type: "click",
        description: `Usuario ${verb} "${label}"`,
        selector,
        url: location.href
      });
    },
    true
  );

  // ---------- Captura de inputs / textarea / select ----------
  document.addEventListener(
    "change",
    (e) => {
      if (!recording1) return;
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();

      if (tag === "select") {
        const selectedText =
          el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : el.value;
        send({
          type: "select",
          description: `Usuario selecciona "${truncate(selectedText)}" en "${getLabelFor(el) || el.name || "select"}"`,
          selector: getSelector(el),
          value: truncate(selectedText),
          url: location.href
        });
        return;
      }

      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        const label = getLabelFor(el) || el.value || el.name || el.type;
        const accion = el.type === "checkbox" ? (el.checked ? "marca" : "desmarca") : "selecciona";
        send({
          type: el.type,
          description: `Usuario ${accion} "${label}"`,
          selector: getSelector(el),
          value: el.checked,
          url: location.href
        });
        return;
      }

      if (tag === "input" || tag === "textarea") {
        const label = getLabelFor(el) || el.name || el.id || "campo de texto";
        const isPassword = tag === "input" && el.type === "password";
        const isSensitive =
          isPassword ||
          el.autocomplete === "cc-number" ||
          el.autocomplete === "cc-csc" ||
          (el.name && /tarjeta|card|cvv|cvc/i.test(el.name));

        if (isSensitive) {
          send({
            type: "input",
            description: `Usuario escribe en el campo "${label}" (valor oculto, ${el.value.length} caracteres)`,
            selector: getSelector(el),
            value: null,
            masked: true,
            url: location.href
          });
        } else {
          send({
            type: "input",
            description: `Usuario escribe "${truncate(el.value)}" en el campo "${label}"`,
            selector: getSelector(el),
            value: truncate(el.value),
            url: location.href
          });
        }
      }
    },
    true
  );

  // ---------- Envío de formularios (por si se envía con Enter, sin clic en botón) ----------

  document.addEventListener(
    "submit",
    (e) => {
      if (!recording1) return;
      const form = e.target;
      const label = (form && (form.getAttribute("name") || form.getAttribute("id"))) || "formulario";
      send({
        type: "submit",
        description: `Usuario envía el formulario "${label}"`,
        selector: getSelector(form),
        url: location.href
      });
    },
    true
  );

  injectPageHook();
})();
