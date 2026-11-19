// Also serialized by Safari into the isolated world. Keep all drawing code local.
export function showActionPointer(expectedURL, target, effect = "copy") {
  try {
    if (location.href !== expectedURL || document.hidden || !document.documentElement) return false;
    const width = Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
    let anchor = target;
    if (target === "selection") {
      const selection = getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return false;
      anchor = selection.getRangeAt(0);
    } else if (target?.ref) {
      const state = globalThis.__safariChatRefs;
      if (state?.url !== expectedURL || state.pointerTarget?.id !== target.ref) return false;
      anchor = state.pointerTarget.element;
      state.showPointer = showActionPointer;
      delete state.pointerTarget;
    }
    if (!anchor) return false;

    // Clip the hotspot to the visible fragment, including nested scroll areas.
    let left = 0, top = 0, right = width, bottom = innerHeight;
    const container = anchor instanceof Range ? anchor.commonAncestorContainer : null;
    const ancestor = container?.nodeType === Node.ELEMENT_NODE ? container : (container ?? anchor).parentElement;
    for (let parent = ancestor, depth = 0; parent && depth++ < 64; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    const rects = anchor.getClientRects ? anchor.getClientRects() : [anchor];
    let point;
    for (let i = 0; i < Math.min(rects.length, 256); i++) {
      const rect = rects[i], x1 = Math.max(left, rect.left), y1 = Math.max(top, rect.top);
      const x2 = Math.min(right, rect.right), y2 = Math.min(bottom, rect.bottom);
      if (!(x2 > x1 && y2 > y1)) continue;
      point = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      break;
    }
    if (!point) return false;

    let pointer = globalThis.__safariChatActionPointer;
    if (!pointer?.host.isConnected || !pointer.track) {
      pointer?.clear();
      const host = document.createElement("div");
      host.id = "safari-chat-action-pointer";
      host.setAttribute("aria-hidden", "true");
      host.inert = true;
      host.popover = "manual";
      host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:clip!important;pointer-events:none!important;user-select:none!important;contain:strict!important;z-index:2147483647!important;display:block!important";
      const shadow = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(":host::backdrop{display:none!important}");
      shadow.adoptedStyleSheets = [sheet];
      const position = document.createElement("div");
      position.style.cssText = "position:absolute;top:0;left:0;width:24px;height:25px;pointer-events:none";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 25");
      svg.setAttribute("focusable", "false");
      svg.style.cssText = "display:block;width:24px;height:25px;overflow:visible;transform-origin:3px 3px;filter:drop-shadow(0 1px 1px #0009) drop-shadow(0 0 4px #339cff) drop-shadow(0 0 9px #339cffa8)";
      const arrow = document.createElementNS(svg.namespaceURI, "path");
      arrow.setAttribute("d", "M3 2.5 Q2 2.1 2.4 3.8 L8.1 21.5 Q8.8 23.4 10 21.6 L13.5 15.3 Q13.9 14.6 14.8 14.4 L21 13 Q23.2 12.4 21.1 11.2 Z");
      arrow.setAttribute("fill", "#101010"); arrow.setAttribute("stroke", "#fff");
      arrow.setAttribute("stroke-width", "1.8"); arrow.setAttribute("stroke-linejoin", "round");
      svg.append(arrow); position.append(svg); shadow.append(position);
      const clear = () => {
        clearTimeout(pointer.timer);
        host.remove();
        window.removeEventListener("pagehide", clear);
        window.removeEventListener("resize", resized);
        document.removeEventListener("visibilitychange", clear);
        if (globalThis.__safariChatActionPointer === pointer) delete globalThis.__safariChatActionPointer;
      };
      const resized = () => {
        if (innerWidth !== pointer.viewportWidth || innerHeight !== pointer.viewportHeight) clear();
      };
      pointer = { host, position, svg, clear, tracking: false,
        track(x, y) {
          if (!pointer.tracking) {
            pointer.tracking = true;
            clearTimeout(pointer.timer);
            position.getAnimations().forEach(animation => animation.cancel());
            svg.getAnimations().forEach(animation => animation.cancel());
          }
          position.style.transform = "translate(" + (x - 3) + "px," + (y - 3) + "px)";
        },
        finishTrack() { pointer.tracking = false; clearTimeout(pointer.timer); pointer.timer = setTimeout(clear, 700); },
      };
      globalThis.__safariChatActionPointer = pointer;
      window.addEventListener("pagehide", clear);
      window.addEventListener("resize", resized);
      document.addEventListener("visibilitychange", clear);
      document.documentElement.append(host);
      try { host.showPopover?.(); } catch { /* A fixed layer also works in documents without popovers. */ }
    }
    const { host, position, svg } = pointer;
    if (pointer.tracking) return true;
    pointer.viewportWidth = innerWidth; pointer.viewportHeight = innerHeight;
    clearTimeout(pointer.timer);
    pointer.timer = setTimeout(pointer.clear, 930);
    host.style.setProperty("width", width + "px", "important");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = getComputedStyle(position).transform;
    const to = "translate(" + (point.x - 3) + "px," + (point.y - 3) + "px)";
    position.getAnimations().forEach(animation => animation.cancel());
    svg.getAnimations().forEach(animation => animation.cancel());
    position.style.transform = to;
    if (!reduced && effect !== "press" && from !== "none") position.animate([{ transform: from }, { transform: to }], { duration: 120, easing: "ease-out" });
    if (!reduced && effect === "press") svg.animate([{ transform: "scale(1)" }, { transform: "scale(.83)", offset: .35 }, { transform: "scale(1)" }], { duration: 220 });
    if (!reduced) svg.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 740, duration: 170, fill: "forwards" });
    return effect === "aim" ? (reduced ? 45 : 125) : true;
  } catch { return false; } // Visual feedback must never block the underlying action.
}
