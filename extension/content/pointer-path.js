// Installed in the same isolated world as the validated element references.
export function installPointerPath() {
  globalThis.__safariChatStartPath = (owner, element, kind, points, speed, viewport) => {
    const drag = kind === "drag", url = location.href;
    const width = () => Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
    function hit(x, y) {
      if (location.href !== url || width() !== viewport.width || innerHeight !== viewport.height || scrollX !== viewport.x || scrollY !== viewport.y) throw new Error("The viewport changed. Read the page again.");
      if (x < 0 || x >= width() || y < 0 || y >= innerHeight) throw new Error("The path leaves the visible website.");
      const node = document.elementFromPoint(x, y);
      if (!node || node.closest("#safari-chat-host,iframe,frame,object,embed,[inert],[hidden],input[type=password],input[type=file]")) throw new Error("The path crosses an unavailable area.");
      const field = node.closest("input,textarea,[contenteditable],select");
      if (field && /password|passcode|credit.?card|debit.?card|card.?number|\bcc[-_]|\bcvc\b|\bcvv\b|security.?code|verification.?code|one.?time|\botp\b|secret|token/i.test([field.name, field.id, field.autocomplete, field.getAttribute("aria-label"), field.getAttribute("placeholder"), field.labels?.[0]?.innerText].join(" "))) throw new Error("The path crosses a sensitive field.");
      return node;
    }
    for (const point of points) hit(point.x, point.y);
    const first = points[0];
    const start = hit(first.x, first.y);
    if (!element.contains(start)) throw new Error("The starting point no longer hits the selected target. Read it again.");
    const pointerId = crypto.getRandomValues(new Uint32Array(1))[0] % 1073741824 + 32;
    const state = { kind, active: true, speed: first.speed ?? speed, waypoint: 0, x: first.x, y: first.y };
    let target, pressed = false, mouse = true, paint;
    function send(node, name, relatedTarget = null) {
      const isPointer = name.startsWith("pointer"), edge = /enter$|leave$/.test(name);
      const moving = name === "pointermove" || name === "pointerover" || name === "pointerout" || edge;
      const common = { bubbles: !edge, composed: !edge, cancelable: !edge && name !== "pointercancel", view: window,
        clientX: state.x, clientY: state.y, button: isPointer && moving ? -1 : 0, buttons: pressed ? 1 : 0, relatedTarget };
      const event = isPointer ? new PointerEvent(name, { ...common, pointerId, pointerType: "mouse", isPrimary: true, pressure: pressed ? 0.5 : 0 }) : new MouseEvent(name, common);
      return node.dispatchEvent(event);
    }
    function hover(next) {
      if (target === next) return;
      if (target) {
        send(target, "pointerout", next); if (mouse) send(target, "mouseout", next);
        for (let node = target; node && !node.contains(next); node = node.parentElement) {
          send(node, "pointerleave", next); if (mouse) send(node, "mouseleave", next);
        }
      }
      send(next, "pointerover", target); if (mouse) send(next, "mouseover", target);
      const entered = [];
      for (let node = next; node && !node.contains(target); node = node.parentElement) entered.push(node);
      for (const node of entered.reverse()) { send(node, "pointerenter", target); if (mouse) send(node, "mouseenter", target); }
      target = next;
    }
    function move(x, y) {
      const next = hit(x, y);
      state.x = x; state.y = y;
      paint?.(x, y); hover(next);
      send(target, "pointermove"); if (mouse) send(target, "mousemove");
    }
    function begin() {
      const marker = globalThis.__safariChatActionPointer;
      paint = marker?.track;
      move(first.x, first.y);
      if (drag) {
        if (!element.contains(hit(state.x, state.y))) throw new Error("The drag target changed before the press.");
        pressed = true;
        mouse = send(target, "pointerdown");
        if (mouse) send(target, "mousedown");
      }
    }
    function advance(dt) {
      // Visit every corner even if several short segments fit in one display frame.
      while (state.waypoint < points.length - 1) {
        const next = points[state.waypoint + 1], dx = next.x - state.x, dy = next.y - state.y;
        const distance = Math.hypot(dx, dy);
        if (distance && (!dt || !state.speed)) return;
        const travel = state.speed * dt;
        if (distance > travel) {
          move(state.x + dx * (travel / distance), state.y + dy * (travel / distance));
          return;
        }
        move(next.x, next.y);
        if (distance) dt = Math.max(0, dt - distance / state.speed);
        state.waypoint++;
        if (next.speed != null) state.speed = next.speed;
      }
      return "path finished";
    }
    function end(reason) {
      if (pressed) {
        pressed = false;
        const release = reason === "path finished" || reason === "stopped by model";
        const receiver = target?.isConnected ? target : document;
        send(receiver, release ? "pointerup" : "pointercancel");
        if (mouse) send(receiver, "mouseup");
        state.released = release;
      }
      globalThis.__safariChatActionPointer?.finishTrack?.();
    }
    return globalThis.__safariChatStartMotion(owner, state, element, advance, begin, end);
  };
  return true;
}
