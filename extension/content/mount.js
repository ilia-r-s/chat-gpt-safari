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
  let token, loadStatus, loadMessage, retryButton, openTimer;
  let lastHostRemoval = 0, removalCount = 0;
  const changes = new Map();

  // Record only properties we own. Keep unrelated edits and newer site-written values.
  function setStyle(element, property, value) {
    let entry = changes.get(element);
    if (!entry) { entry = { hadStyle: element.hasAttribute("style"), properties: new Map() }; changes.set(element, entry); }
    const before = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    element.style.setProperty(property, value, "important");
    const original = entry.properties.get(property) ?? { before, priority };
    entry.properties.set(property, { ...original, applied: element.style.getPropertyValue(property) });
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

  // Keep a rigid grid, table, or control reachable by scrolling its own part
  // of the page. Reparenting the website would disrupt forms and navigation.
  function containOverflow(element, pageRight) {
    let depth = 0;
    for (let box = element.parentElement; box && box !== document.documentElement && ++depth <= 40; box = box.parentElement) {
      if (!box.clientWidth || box.scrollWidth <= box.clientWidth + 1 || box.getBoundingClientRect().right > pageRight + 1) continue;
      if (changes.get(box)?.properties.has("overflow-x")) return;
      if (box === document.body) setStyle(document.documentElement, "overflow-x", "clip");
      setStyle(box, "overflow-x", "auto");
      return;
    }
  }
  function fitPage(viewportWidth, pageRight) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const resizedClips = new Map();
    let visited = 0, adjusted = 0;
    for (let element = document.body; element && ++visited <= 5000 && adjusted < 80; element = walker.nextNode()) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible") continue;
      let rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= viewportWidth) continue;
      if (rect.right <= pageRight + 1) continue;
      // A scroller can keep its wider children. Only its visible box needs to fit.
      let clipped = false;
      let depth = 0;
      // A viewport-fixed control can escape ordinary ancestor overflow.
      for (let parent = style.position === "fixed" ? null : element.parentElement; parent && parent !== document.body && parent !== document.documentElement && ++depth <= 40; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (!/auto|scroll|hidden|clip/.test(overflow) || parent.getBoundingClientRect().right > pageRight + 1) continue;
        // A shell that we narrowed may now clip a previously reachable control.
        // Leave carousels and content already outside the site's clip alone.
        if ((overflow === "clip" || overflow === "hidden") && rect.right <= (resizedClips.get(parent) ?? 0) + 1 &&
            element.matches("button,a[href],input,select,textarea,[tabindex],[contenteditable=true],[role=button]")) {
          setStyle(parent, "overflow-x", "auto");
        }
        clipped = true; break;
      }
      if (clipped) continue;
      const positioned = style.position === "fixed" || style.position === "absolute";
      // Nested 100vw app shells escape a narrower root. Shrink containers in
      // document order so their own grids, sticky children and controls reflow.
      if (!positioned && !(rect.width > pageRight && element.matches("body,main,section,article,header,footer,nav,aside,div,form,iframe,canvas,video,img"))) {
        containOverflow(element, pageRight);
        continue;
      }
      if (!positioned && element.parentElement?.closest("[role='tablist']")) continue;
      adjusted++;
      const leftGap = positioned ? Math.min(24, Math.max(0, rect.left)) : Math.max(0, rect.left);
      const rightGap = Math.min(24, Math.max(0, viewportWidth - rect.right));
      const available = Math.max(1, pageRight - leftGap - rightGap);
      if (rect.width > available) {
        if (!positioned && /^(hidden|clip)$/.test(style.overflowX)) resizedClips.set(element, rect.right);
        const extra = style.boxSizing === "border-box" ? 0 : [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
        setStyle(element, "min-width", "0");
        setStyle(element, "max-width", `${Math.max(0, available - extra)}px`);
        rect = element.getBoundingClientRect();
      }
      const shift = Math.max(leftGap - rect.left, Math.min(0, pageRight - rightGap - rect.right));
      if (positioned && Math.abs(shift) >= 0.5) {
        const translation = style.translate === "none" ? ["0px"] : components(style.translate);
        translation[0] = `calc(${translation[0]} + ${shift}px)`;
        setStyle(element, "translate", translation.join(" "));
      }
      if (element.getBoundingClientRect().right > pageRight + 2) containOverflow(element, pageRight);
    }
  }

  function layout() {
    animation = null;
    observer?.disconnect();
    const offsets = [];
    for (const [box, change] of changes) {
      if (box.scrollLeft && change.properties.has("overflow-x")) offsets.push([box, box.scrollLeft]);
    }
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
    setStyle(root, "box-sizing", "border-box");
    setStyle(root, "min-width", "0");
    setStyle(root, "max-width", `${pageRight}px`);
    setStyle(root, "margin-right", `${panelWidth}px`);
    fitPage(viewportWidth, pageRight);
    for (const [box, left] of offsets) if (changes.get(box)?.properties.has("overflow-x")) box.scrollLeft = left;
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  }

  function scheduleLayout() {
    if (!animation) animation = requestAnimationFrame(layout);
  }
  function afterScroll() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; scheduleLayout(); }, 150);
  }

  function defaultWidth(width) { return Math.min(440, Math.max(Math.min(320, Math.round(width / 2)), Math.floor(width * 0.4))); }
  function widthLimits(viewportWidth) {
    const min = Math.min(320, Math.round(viewportWidth * 0.45));
    const pageMin = Math.min(320, Math.ceil(viewportWidth * 0.4));
    return { min, max: Math.min(840, viewportWidth - pageMin) };
  }

  function resize(width) {
    const { min, max } = widthLimits(document.documentElement.clientWidth || innerWidth);
    preferredWidth = Math.round(Math.min(max, Math.max(min, width)));
    scheduleLayout();
  }
  function saveWidth() {
    if (token) browser.runtime.sendMessage({ type: "dock.width", token, width: preferredWidth ?? null }).catch(() => {});
  }

  function stopDragging(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id; drag = null;
    if (handle?.hasPointerCapture(id)) handle.releasePointerCapture(id);
    handle?.removeAttribute("data-dragging");
    if (frame) frame.style.pointerEvents = "";
    saveWidth();
  }

  function addResizeHandle(shadow) {
    const style = document.createElement("style");
    style.textContent = `
      .resize { position:absolute; inset:0 auto 0 0; width:9px; cursor:col-resize; touch-action:none; user-select:none; outline:none; }
      .resize::after { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:transparent; transition:background .15s; }
      .resize:hover::after, .resize:focus-visible::after, .resize[data-dragging]::after { background:#888; }
      .resize:focus-visible { outline:2px solid CanvasText; outline-offset:-2px; }
      .load-status { position:absolute; inset:0; box-sizing:border-box; display:grid; place-content:center; gap:12px; padding:20px; text-align:center; font:14px/1.45 system-ui; background:Canvas; color:CanvasText; border-left:1px solid #8884; }
      .load-status[hidden], .load-status button[hidden] { display:none; }
      .load-status p { max-width:32ch; margin:0 auto; }
      .load-status button { font:inherit; color:inherit; cursor:pointer; border:1px solid #8886; border-radius:8px; padding:5px 12px; background:transparent; }
      .load-status .close { position:absolute; top:10px; right:10px; }
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
      preferredWidth = undefined; scheduleLayout(); saveWidth();
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
      saveWidth();
    });
    shadow.append(style, handle);
  }

  function loadFrame(url) {
    clearTimeout(openTimer);
    frame.inert = true;
    if (loadStatus.getRootNode().activeElement === retryButton) loadStatus.querySelector(".close").focus({ preventScroll: true });
    loadStatus.hidden = false;
    loadMessage.textContent = "Opening Safari Chat\u2026";
    retryButton.hidden = true;
    frame.src = url;
    openTimer = setTimeout(() => {
      loadMessage.textContent = "Safari Chat is taking longer to open on this page.";
      retryButton.hidden = false;
    }, 3500);
  }

  function addLoadStatus(shadow, url) {
    loadStatus = document.createElement("section");
    loadStatus.className = "load-status";
    loadMessage = document.createElement("p");
    loadMessage.setAttribute("role", "status");
    retryButton = document.createElement("button");
    retryButton.textContent = "Retry";
    retryButton.onclick = event => { if (event.isTrusted) loadFrame(url); };
    const dismiss = document.createElement("button");
    dismiss.className = "close";
    dismiss.textContent = "Close";
    dismiss.setAttribute("aria-label", "Close chat pane");
    dismiss.onclick = event => {
      if (!event.isTrusted) return;
      const grant = token;
      browser.runtime.sendMessage({ type: "dock.dismiss", token: grant }).catch(() => {}).finally(() => {
        if (token === grant) close();
      });
    };
    loadStatus.append(loadMessage, retryButton, dismiss);
    shadow.append(loadStatus);
  }

  function close() {
    stopDragging();
    clearTimeout(openTimer);
    clearTimeout(refreshTimer); cancelAnimationFrame(animation);
    refreshTimer = null; animation = null;
    observer?.disconnect(); observer = null;
    window.removeEventListener("resize", scheduleLayout);
    window.removeEventListener("scroll", afterScroll);
    window.removeEventListener("blur", stopDragging);
    window.removeEventListener("pagehide", close);
    restoreStyles();
    delete globalThis.__safariChatPageRight;
    host?.remove(); host = null; frame = null; handle = null; token = null;
    loadStatus = null; loadMessage = null; retryButton = null;
    if (previousFocus?.isConnected && (document.activeElement === document.body || document.activeElement === document.documentElement)) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== browser.runtime.id) return;
    if (message.type === "panel.ready" && loadStatus && message.token === token) {
      const focusChat = document.activeElement === host && loadStatus.contains(loadStatus.getRootNode().activeElement);
      clearTimeout(openTimer); loadStatus.hidden = true; frame.inert = false;
      if (focusChat) frame.focus({ preventScroll: true });
      return Promise.resolve(true);
    }
    if (message.type === "panel.close") {
      close();
      return Promise.resolve({ ok: true });
    }
    if (message.type !== "panel.show") return;
    if (typeof message.url !== "string" || message.url.split(/[?#]/)[0] !== browser.runtime.getURL("panel/panel.html")) return Promise.reject(new Error("Invalid panel URL."));
    if (!message.restore) removalCount = 0;
    if (!host?.isConnected) {
      if (!document.body) return Promise.resolve({ ok: false });
      token = message.token;
      if (!token) return Promise.resolve({ ok: false });
      if (Number.isInteger(message.width)) preferredWidth = message.width;
      previousFocus = document.activeElement;
      host = document.createElement("div");
      host.id = "safari-chat-host";
      host.popover = "manual";
      // The top layer keeps page transforms and stacking contexts from moving the dock.
      host.style.cssText = "all:initial!important;position:fixed!important;inset:0 0 0 auto!important;margin:0!important;padding:0!important;border:0!important;width:440px!important;height:100dvh!important;z-index:2147483647!important;display:block!important;color-scheme:light dark!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      frame = document.createElement("iframe");
      frame.setAttribute("aria-label", "Safari Chat");
      frame.referrerPolicy = "no-referrer";
      // Deliver the grant only to our extension document. The embedding site
      // must never receive it through URLs, resource timing, or a DOM attribute.
      const destination = new URL(message.url);
      const targetOrigin = destination.protocol + "//" + destination.host;
      frame.addEventListener("load", () => frame?.contentWindow?.postMessage({ type: "safari-chat.mount", token }, targetOrigin));
      frame.style.cssText = "display:block;box-sizing:border-box;width:100%;height:100%;border:0;border-left:1px solid #8884;background:Canvas;";
      shadow.append(frame);
      addLoadStatus(shadow, message.url);
      addResizeHandle(shadow);
      loadFrame(message.url);
      document.documentElement.append(host);
      observer = new MutationObserver(records => {
        if (!host?.isConnected) {
          const now = Date.now(), grant = token;
          if (now - lastHostRemoval > 2000) removalCount = 0;
          lastHostRemoval = now;
          close();
          // A site may replace its document shell. Retry transient replacements
          // and let the toolbar reopen a pane a site repeatedly removes.
          browser.runtime.sendMessage({ type: ++removalCount <= 2 ? "dock.restore" : "dock.removed", token: grant }).catch(() => {});
          return;
        }
        if (!records.some(record => record.target !== host && (record.type === "attributes" || [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE)))) return;
        if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; scheduleLayout(); }, 150);
      });
      try { host.showPopover?.(); layout(); }
      catch (error) { close(); throw error; }
      window.addEventListener("resize", scheduleLayout, { passive: true });
      window.addEventListener("scroll", afterScroll, { passive: true });
      window.addEventListener("blur", stopDragging);
      window.addEventListener("pagehide", close);
    }
    if (!message.restore) (loadStatus.hidden ? frame : loadStatus.querySelector(".close")).focus({ preventScroll: true });
    return Promise.resolve({ ok: true });
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) browser.runtime.sendMessage({ type: "dock.restore" }).catch(() => {});
  });
})();
