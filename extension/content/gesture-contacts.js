// Coordinate contacts stay bound to their original touch target. Hovering mouse
// and pen inputs instead follow hit testing throughout the approved path.
export function installGestureContacts() {
  globalThis.__safariChatContacts = (ctx, spec) => {
    const { state, send, init, hit, hover, activate } = ctx, device = spec.device;
    const contacts = new Map(), base = crypto.getRandomValues(new Uint32Array(1))[0] % 10000000 + 64;
    const buttons = [1, 4, 2, 8, 16, 32];
    let primary, tap, multi = false, drag;
    let nativeTouch = false;
    if (device === "touch") {
      try { nativeTouch = new TouchEvent("touchstart", { touches: [new Touch({ identifier: 1, target: document })] }).touches?.[0]?.identifier === 1; } catch {}
      state.touchEvents = nativeTouch || !!spec.eventChannel;
    }
    const relay = (target, detail) => target.dispatchEvent(new CustomEvent(spec.eventChannel, { detail, bubbles: true, composed: true, cancelable: true }));
    function pointer(node, c, type, p, button = -1, mask = c.buttons) {
      return send(node, new PointerEvent(type, { ...init(p), pointerId: base + c.id, pointerType: device,
        isPrimary: c.id === primary, button, buttons: mask, pressure: mask ? p.pressure ?? 0.5 : 0,
        width: p.width ?? 1, height: p.height ?? 1, tiltX: p.tiltX || 0, tiltY: p.tiltY || 0,
        twist: p.twist || 0, tangentialPressure: p.tangentialPressure || 0,
      }));
    }
    function mouse(node, name, p, button, mask) {
      return send(node, new MouseEvent(name, { ...init(p), button, buttons: mask }));
    }
    function dragEvent(node, type, p) {
      return send(node, new DragEvent(type, { ...init(p), dataTransfer: drag.data }));
    }
    function dragMove(c, target, p) {
      if (!drag && c.source && c.distance >= 4) {
        drag = { source: c.source, data: new DataTransfer() };
        if (!dragEvent(drag.source, "dragstart", p)) { drag = null; c.source = null; return; }
      }
      if (!drag) return;
      dragEvent(drag.source, "drag", p);
      if (target !== drag.target) {
        if (drag.target) dragEvent(drag.target, "dragleave", p);
        dragEvent(target, "dragenter", p); drag.target = target;
      }
      drag.accepted = !dragEvent(target, "dragover", p);
    }
    function endDrag(p, cancel) {
      if (!drag) return;
      if (drag.accepted && !cancel) { dragEvent(drag.target, "drop", p); state.dropDispatched = true; }
      else if (drag.target) dragEvent(drag.target, "dragleave", p);
      dragEvent(drag.source, "dragend", p); drag = null;
    }
    function touchEvents(groups, type) {
      if (!state.touchEvents || !groups.size) return;
      const asTouch = c => {
        const data = { identifier: base + c.id, clientX: c.p.x, clientY: c.p.y,
          pageX: c.p.x + scrollX, pageY: c.p.y + scrollY, radiusX: (c.p.width || 2) / 2, radiusY: (c.p.height || 2) / 2, force: c.p.pressure ?? 0.5 };
        return nativeTouch ? new Touch({ ...data, target: c.target }) : { ...data, startX: c.startX, startY: c.startY };
      };
      const active = [...contacts.values()];
      for (const [target, changed] of groups) {
        const { ctrlKey, altKey, metaKey, shiftKey } = init(changed[0].p);
        const lists = { touches: active.map(asTouch), targetTouches: active.filter(c => c.target === target).map(asTouch), changedTouches: changed.map(asTouch), ctrlKey, altKey, metaKey, shiftKey };
        const accepted = nativeTouch ? send(target, new TouchEvent(type, { bubbles: true, composed: true, cancelable: true, ...lists })) : relay(target, { type, ...lists });
        if (!nativeTouch) { state.events++; if (!accepted) state.prevented++; }
        if (!accepted) for (const c of changed) c.suppressTap = true;
      }
    }
    function group(groups, target, c) {
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(c);
    }
    function click(c, node, p, button) {
      if (multi || c.suppressTap || c.distance > 5 || c.down !== node || !node.isConnected) return;
      const count = tap?.node === node && tap.button === button && state.elapsed - tap.at < 450 && Math.hypot(p.x-tap.x, p.y-tap.y) < 5 ? tap.count+1 : 1;
      activate(node, p, button, count, device);
      tap = { node, at: state.elapsed, count, button, x: p.x, y: p.y };
    }
    function touchAxes(target) {
      let x = true, y = true;
      for (let el = target; el; el = el.parentElement || el.getRootNode().host) {
        const style = getComputedStyle(el), action = style.touchAction;
        if (action && !["auto", "manipulation"].includes(action)) {
          x &&= /pan-(x|left|right)/.test(action); y &&= /pan-(y|up|down)/.test(action);
        }
        if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) break;
      }
      return { x, y };
    }
    function update(p, c, node) {
      const isTouch = device === "touch", mask = isTouch ? 1 : p.buttons ?? (device === "pen" ? 1 : 0);
      if (!isTouch) hover(node, p, base+c.id, device, c.buttons);
      const changed = c.buttons ^ mask;
      const moved = !c.p || ["x","y","pressure","tiltX","tiltY","twist","width","height","tangentialPressure"].some(k => c.p[k] !== p[k]);
      if (c.p && c.buttons) c.distance += Math.hypot(p.x-c.p.x, p.y-c.p.y);
      if (changed) {
        for (let button = 0; button < buttons.length; button++) {
          const bit = buttons[button]; if (!(changed & bit)) continue;
          const before = c.buttons;
          c.buttons ^= bit;
          if (mask & bit) {
            if (!before) { c.down = node; c.distance = 0; c.suppressTap = false; }
            if (spec.dragDrop && button === 0) c.source = node.closest("[draggable=true],a[href],img");
            if (!pointer(node, c, before ? "pointermove" : "pointerdown", p, button)) c.suppressTap = true;
            if (!isTouch && !c.suppressTap) { mouse(node, "mousedown", p, button, c.buttons); c.mouseButtons |= bit; }
          } else {
            pointer(node, c, c.buttons ? "pointermove" : "pointerup", p, button);
            if (c.mouseButtons & bit) { mouse(node, "mouseup", p, button, c.buttons); c.mouseButtons &= ~bit; }
            if (drag && button === 0) endDrag(p, false);
            else if (!isTouch) click(c, node, p, button);
          }
        }
      } else if (moved) {
        pointer(node, c, "pointermove", p);
        if (!isTouch) mouse(node, "mousemove", p, 0, mask);
        if (c.source && (mask & 1)) dragMove(c, node, p);
      }
      c.receiver = node;
      c.p = p;
      return moved;
    }
    function frame(points, cancel = false) {
      const started = new Map(), moved = new Map(), ended = new Map(), released = [];
      if (points.length > 1) multi = true;
      for (const c of contacts.values()) {
        if (points.some(p => p.id === c.id)) continue;
        contacts.delete(c.id);
        const node = c.target.isConnected ? c.target : document;
        if (cancel) {
          pointer(node, c, "pointercancel", c.p, 0, 0); endDrag(c.p, true);
          for (const [button, bit] of buttons.entries()) {
            if (c.mouseButtons & bit) {
              c.mouseButtons &= ~bit;
              mouse(c.receiver?.isConnected ? c.receiver : node, "mouseup", c.p, button, c.mouseButtons);
            }
          }
        } else if (device === "touch") {
          pointer(node, c, "pointerup", c.p, 0, 0);
        } else if (c.buttons) update({ ...c.p, buttons: 0 }, c, hit(c.p));
        if (device === "touch") {
          group(ended, node, c);
          if (!cancel) released.push(c);
        }
      }
      touchEvents(ended, cancel ? "touchcancel" : "touchend");
      for (const c of released) {
        if (c.target.isConnected && hit(c.p) === c.target) click(c, c.target, c.p, 0);
      }
      if (!contacts.size) { primary = undefined; multi = points.length > 1; }
      for (const p of points) {
        const under = hit(p);
        let c = contacts.get(p.id);
        if (!c) {
          if (!contacts.size && spec.eventChannel) relay(under, "start");
          c = { id: p.id, target: under, startX: p.x, startY: p.y, buttons: 0, mouseButtons: 0, distance: 0, began: state.elapsed, axes: device === "touch" && touchAxes(under) };
          primary ??= c.id; contacts.set(c.id, c); group(started, under, c);
        }
        if (!c.target.isConnected) throw new Error("The gesture target disappeared.");
        const receiver = device === "touch" ? c.target : under;
        const prior = c.p;
        if (update(p, c, receiver)) group(moved, receiver, c);
        if (prior && device === "touch") {
          c.dx = prior.x - p.x; c.dy = prior.y - p.y;
          if (!multi && !c.suppressTap && c.distance < 5 && state.elapsed - c.began >= 600) {
            send(receiver, new PointerEvent("contextmenu", { ...init(p), pointerType: "touch", pointerId: base+c.id, button: 2 }));
            c.suppressTap = true;
          }
        }
      }
      touchEvents(started, "touchstart");
      for (const [target, changes] of moved) {
        const old = changes.filter(c => !started.get(target)?.includes(c));
        if (old.length) moved.set(target, old); else moved.delete(target);
      }
      touchEvents(moved, "touchmove");
      if (!multi && device === "touch" && contacts.size === 1) {
        const c = contacts.values().next().value;
        if (!c.suppressTap && c.distance > 5) ctx.pan(c.target, c.axes.x ? c.dx : 0, c.axes.y ? c.dy : 0);
      }
    }
    return { frame, cancel: () => frame([], true), close: () => { if (spec.eventChannel) relay(document, "close"); } };
  };
  return true;
}
