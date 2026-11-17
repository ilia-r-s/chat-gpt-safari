(() => {
  if (globalThis.__safariChatMount) return;
  globalThis.__safariChatMount = true;
  let host;
  let frame;
  let previousFocus;
  let observer;
  let refreshTimer;
  let animation;
  let handle;
  let preferredWidth;
  let drag;
  const changes = new Map();

  // Record only properties we own. Keep unrelated edits and newer site-written values.
  function setStyle(element, property, value) {
    let entry = changes.get(element);
    if (!entry) { entry = { hadStyle: element.hasAttribute("style"), properties: new Map() }; changes.set(element, entry); }
    const before = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    element.style.setProperty(property, value, "important");
    entry.properties.set(property, { before, priority, applied: element.style.getPropertyValue(property) });
  }

  function restoreStyles() {
    for (const [element, { hadStyle, properties }] of changes) {
      for (const [property, saved] of properties) {
        if (element.style.getPropertyValue(property) !== saved.applied || element.style.getPropertyPriority(property) !== "important") continue;
        if (saved.before) element.style.setProperty(property, saved.before, saved.priority);
        else element.style.removeProperty(property);
      }
      if (!hadStyle && !element.style.length) element.removeAttribute("style");
    }
    changes.clear();
  }

  // Split CSS translate components without splitting spaces inside calc().
  function components(value) {
    const result = []; let part = "", depth = 0;
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (/\s/.test(char) && !depth) { if (part) result.push(part); part = ""; }
      else part += char;
    }
    if (part) result.push(part);
    return result;
  }

  function keepFixedControlsVisible(viewportWidth, pageRight) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let visited = 0, adjusted = 0;
    for (let element = document.body; element && ++visited <= 5000 && adjusted < 80; element = walker.nextNode()) {
      const style = getComputedStyle(element);
      if (style.position !== "fixed" || element.offsetParent || style.display === "none" || style.visibility !== "visible") continue;
      let rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= viewportWidth) continue;
      adjusted++;
      const leftGap = Math.min(24, Math.max(0, rect.left));
      const rightGap = Math.min(24, Math.max(0, viewportWidth - rect.right));
      const available = Math.max(1, pageRight - leftGap - rightGap);
      if (rect.width > available) {
        const extra = style.boxSizing === "border-box" ? 0 : [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
        setStyle(element, "min-width", "0");
        setStyle(element, "max-width", `${Math.max(0, available - extra)}px`);
        rect = element.getBoundingClientRect();
      }
      const shift = Math.max(leftGap - rect.left, Math.min(0, pageRight - rightGap - rect.right));
      if (Math.abs(shift) < 0.5) continue;
      const translation = style.translate === "none" ? ["0px"] : components(style.translate);
      translation[0] = `calc(${translation[0]} + ${shift}px)`;
      setStyle(element, "translate", translation.join(" "));
    }
  }

  function layout() {
    animation = null;
    observer?.disconnect();
    restoreStyles();
    if (!host?.isConnected || !document.body) { close(); return; }
    const root = document.documentElement;
    const viewportWidth = root.clientWidth || innerWidth;
    const { min, max } = widthLimits(viewportWidth);
    const panelWidth = Math.round(Math.min(max, Math.max(min, preferredWidth ?? defaultWidth(viewportWidth))));
    const pageRight = viewportWidth - panelWidth;
    globalThis.__safariChatPageRight = pageRight;
    host.style.setProperty("width", `${panelWidth}px`, "important");
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(panelWidth));
    handle.setAttribute("aria-valuetext", `${panelWidth} pixels wide`);
    const padding = parseFloat(getComputedStyle(root).paddingRight) || 0;
    setStyle(root, "box-sizing", "border-box");
    if (root.getBoundingClientRect().width > viewportWidth) {
      setStyle(root, "min-width", "0");
      setStyle(root, "max-width", "100%");
    }
    setStyle(root, "padding-right", `${padding + panelWidth}px`);
    // Cap common 100vw app roots without moving or replacing the site's DOM.
    const roots = [document.body];
    for (const child of document.body.children) { if (roots.length >= 81) break; roots.push(child); }
    for (const element of roots) {
      const style = getComputedStyle(element);
      if (style.position === "fixed" || element.getBoundingClientRect().width <= pageRight) continue;
      setStyle(element, "box-sizing", "border-box");
      setStyle(element, "min-width", "0");
      setStyle(element, "max-width", "100%");
    }
    keepFixedControlsVisible(viewportWidth, pageRight);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  }

  function scheduleLayout() {
    if (!animation) animation = requestAnimationFrame(layout);
  }

  function defaultWidth(viewportWidth) { return Math.min(440, Math.floor(viewportWidth * 0.4)); }
  function widthLimits(viewportWidth) {
    const min = Math.min(320, viewportWidth);
    return { min, max: Math.max(min, Math.min(840, viewportWidth - 320)) };
  }

  function resize(width) {
    const { min, max } = widthLimits(document.documentElement.clientWidth || innerWidth);
    preferredWidth = Math.min(max, Math.max(min, width));
    scheduleLayout();
  }

  function stopDragging(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id; drag = null;
    if (handle?.hasPointerCapture(id)) handle.releasePointerCapture(id);
    handle?.removeAttribute("data-dragging");
    if (frame) frame.style.pointerEvents = "";
  }

  function addResizeHandle(shadow) {
    const style = document.createElement("style");
    style.textContent = `
      .resize { position:absolute; inset:0 auto 0 0; width:9px; cursor:col-resize; touch-action:none; user-select:none; outline:none; }
      .resize::after { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:transparent; transition:background .15s; }
      .resize:hover::after, .resize:focus-visible::after, .resize[data-dragging]::after { background:#888; }
      .resize:focus-visible { outline:2px solid CanvasText; outline-offset:-2px; }
    `;
    handle = document.createElement("div");
    handle.className = "resize"; handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "Chat panel width");
    handle.title = "Drag to resize chat. Double-click to reset. Arrow keys also resize.";
    handle.addEventListener("pointerdown", event => {
      if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, width: host.getBoundingClientRect().width };
      handle.setPointerCapture(event.pointerId);
      handle.setAttribute("data-dragging", "");
      // Pointer capture owns the gesture even as it crosses the embedded frame.
      frame.style.pointerEvents = "none";
    });
    handle.addEventListener("pointermove", event => {
      if (event.isTrusted && drag?.id === event.pointerId) resize(drag.width + drag.x - event.clientX);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, stopDragging);
    handle.addEventListener("dblclick", event => {
      if (!event.isTrusted) return;
      preferredWidth = undefined; scheduleLayout();
    });
    handle.addEventListener("keydown", event => {
      if (!event.isTrusted || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Escape"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const { min, max } = widthLimits(document.documentElement.clientWidth || innerWidth);
      if (event.key === "Escape" && drag) { resize(drag.width); stopDragging(); }
      else if (event.key === "Enter") { preferredWidth = undefined; scheduleLayout(); }
      else if (event.key === "Home") resize(min);
      else if (event.key === "End") resize(max);
      else if (event.key.startsWith("Arrow")) resize(host.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 64 : 16));
    });
    shadow.append(style, handle);
  }

  function close() {
    stopDragging();
    clearTimeout(refreshTimer); cancelAnimationFrame(animation);
    refreshTimer = null; animation = null;
    observer?.disconnect(); observer = null;
    window.removeEventListener("resize", scheduleLayout);
    window.removeEventListener("blur", stopDragging);
    window.removeEventListener("pagehide", close);
    restoreStyles();
    delete globalThis.__safariChatPageRight;
    host?.remove(); host = null; frame = null; handle = null;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== browser.runtime.id) return;
    if (message.type === "panel.close") {
      close();
      return Promise.resolve({ ok: true });
    }
    if (message.type !== "panel.show") return;
    if (typeof message.url !== "string" || message.url.split(/[?#]/)[0] !== browser.runtime.getURL("panel/panel.html")) return Promise.reject(new Error("Invalid panel URL."));
    if (!host?.isConnected) {
      // Keep both surfaces usable; small windows use the existing standalone chat.
      if (innerWidth < 720 || !document.body || !HTMLElement.prototype.showPopover) return Promise.resolve({ ok: false, standalone: true });
      previousFocus = document.activeElement;
      host = document.createElement("div");
      host.id = "safari-chat-host";
      host.popover = "manual";
      // The top layer keeps page transforms and stacking contexts from moving the dock.
      host.style.cssText = "all:initial!important;position:fixed!important;inset:0 0 0 auto!important;margin:0!important;padding:0!important;border:0!important;width:440px!important;height:100dvh!important;z-index:2147483647!important;display:block!important;color-scheme:light dark!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      frame = document.createElement("iframe");
      frame.title = "Safari Chat";
      frame.src = message.url;
      frame.style.cssText = "display:block;box-sizing:border-box;width:100%;height:100%;border:0;border-left:1px solid #8884;background:Canvas;";
      shadow.append(frame);
      addResizeHandle(shadow);
      document.documentElement.append(host);
      observer = new MutationObserver(records => {
        if (!host?.isConnected) { close(); return; }
        if (!records.some(record => record.target !== host && (record.type === "attributes" || [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE)))) return;
        if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; scheduleLayout(); }, 150);
      });
      try { host.showPopover(); layout(); }
      catch (error) { close(); throw error; }
      window.addEventListener("resize", scheduleLayout, { passive: true });
      window.addEventListener("blur", stopDragging);
      window.addEventListener("pagehide", close);
    }
    frame.focus({ preventScroll: true });
    return Promise.resolve({ ok: true });
  });
})();
