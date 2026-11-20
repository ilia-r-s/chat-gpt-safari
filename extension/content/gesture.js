// Installed into the isolated content world alongside the per-device drivers.
export function installGesturePlayer() {
  globalThis.__safariChatStartGesture = (owner, element, spec, snapshot, hosts) => {
    const viewport = snapshot.viewport, url = location.href, { frames, device } = spec;
    const width = () => Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
    if (width() !== viewport.width || innerHeight !== viewport.height || scrollX !== viewport.x || scrollY !== viewport.y) throw new Error("The viewport changed. Read it again.");
    function hit(p) {
      if (location.href !== url || width() !== viewport.width || innerHeight !== viewport.height ||
          p.x < 0 || p.x >= width() || p.y < 0 || p.y >= innerHeight) throw new Error("The gesture left the approved viewport. Read the page again.");
      let node = document.elementFromPoint(p.x, p.y);
      // Follow open shadow roots and check the host at each boundary.
      for (let depth = 0; depth < 16; depth++) {
        if (!node || node.closest("#safari-chat-host,iframe,frame,object,embed,[inert],[hidden],:disabled,[aria-disabled=true],input[type=password],input[type=file]")) throw new Error("The gesture crosses an unavailable area.");
        const field = node.closest("input,textarea,select,[contenteditable]");
        if (field && /password|passcode|credit.?card|debit.?card|card.?number|\bcc[-_]|\bcvc\b|\bcvv\b|security.?code|verification.?code|one.?time|\botp\b|secret|token/i.test([field.name, field.id, field.autocomplete, field.getAttribute("aria-label"), field.getAttribute("placeholder"), field.labels?.[0]?.innerText].join(" "))) throw new Error("The gesture crosses a sensitive field.");
        const child = node.shadowRoot?.elementFromPoint?.(p.x, p.y);
        if (!child || node === child) return node;
        node = child;
      }
      throw new Error("The target is nested too deeply.");
    }
    const anchor = spec.anchor || frames[0].points[0];
    const target = hit(anchor);
    const within = node => element.contains(node) || node.getRootNode().host && within(node.getRootNode().host);
    if (!within(target)) throw new Error("The starting point no longer hits the selected target. Read it again.");
    const state = { kind: "gesture", device, active: true, speed: 1, elapsed: 0, events: 0, prevented: 0 };
    let mods = [], over, index = 0;
    const init = p => ({ bubbles: true, composed: true, cancelable: true, view: window,
      clientX: p.x, clientY: p.y, shiftKey: mods.includes("Shift"), ctrlKey: mods.includes("Control"), altKey: mods.includes("Alt"), metaKey: mods.includes("Meta") });
    const send = (node, event) => {
      state.events++;
      const accepted = node.dispatchEvent(event);
      if (!accepted) state.prevented++;
      return accepted;
    };
    function hover(node, p, pointerId = 1, pointerType = "mouse", buttons = 0) {
      globalThis.__safariChatActionPointer?.track?.(p.x, p.y);
      if (over === node) return;
      function transition(receiver, name, relatedTarget) {
        const edge = name === "enter" || name === "leave";
        const options = { ...init(p), bubbles: !edge, composed: !edge, cancelable: !edge, buttons, relatedTarget };
        send(receiver, new PointerEvent("pointer" + name, { ...options, pointerId, pointerType, isPrimary: true, button: -1 }));
        send(receiver, new MouseEvent("mouse" + name, options));
      }
      if (over) {
        transition(over, "out", node);
        for (let el = over; el && !el.contains(node); el = el.parentElement) transition(el, "leave", node);
      }
      transition(node, "over", over ?? null);
      const parents = [];
      for (let el = node; el && !el.contains(over ?? null); el = el.parentElement) parents.push(el);
      for (const el of parents.reverse()) transition(el, "enter", over ?? null);
      over = node;
    }
    function activate(node, p, button, count, pointerType) {
      if (hit(p) !== node) throw new Error("The target changed before activation.");
      function verify() {
        if (hit(p) !== node) throw new Error("The target changed before activation.");
        const control = node.closest("button,input");
        const form = control && ["submit","image"].includes(control.type) && control.form;
        for (const address of [node.closest("a[href]")?.href, form && (control.hasAttribute("formaction") ? control.formAction : form.action)]) {
          if (!address) continue;
          const dest = new URL(address, url);
          if (!["http:", "https:"].includes(dest.protocol) || dest.username || dest.password || !hosts.includes(dest.hostname)) throw new Error("The gesture would activate an unapproved destination. Read the page and choose its link explicitly.");
        }
      }
      verify();
      const opts = { ...init(p), button, buttons: 0, detail: count, pointerType, isPrimary: true };
      if (button === 2) send(node, new PointerEvent("contextmenu", opts));
      if (device === "trackpad") {
        for (const type of ["mousedown", "mouseup"]) send(node, new MouseEvent(type, { ...opts, buttons: type === "mousedown" ? (button === 2 ? 2 : 1) : 0 }));
      }
      verify(); send(node, new PointerEvent(button ? "auxclick" : "click", opts));
      if (!button && count === 2 && node.isConnected && location.href === url) send(node, new MouseEvent("dblclick", opts));
    }
    const remainder = { X: 0, Y: 0 };
    function pan(node, dx, dy, mode = 0) {
      // Scripted wheel and touch events have no native scrolling default.
      // Preserve subpixel input and chain unused distance at scroll boundaries.
      for (const [axis, distance] of [["X", dx], ["Y", dy]]) {
        if (!distance) continue;
        const prop = axis === "X" ? "scrollLeft" : "scrollTop";
        let delta;
        for (let el = node; el; el = el.parentElement || el.getRootNode().host) {
          const style = getComputedStyle(el), root = el === document.scrollingElement;
          if (!root && !/^(auto|scroll|overlay)$/.test(style["overflow" + axis])) continue;
          if (delta === undefined) {
            const unit = mode === 1 ? parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 :
              mode === 2 ? (axis === "X" ? el.clientWidth : el.clientHeight) : 1;
            const exact = distance * unit + remainder[axis];
            delta = Math.trunc(exact); remainder[axis] = exact - delta;
          }
          if (Math.abs(delta) < 1) break;
          const before = el[prop];
          el.scrollBy({ left: axis === "X" ? delta : 0, top: axis === "Y" ? delta : 0, behavior: "instant" });
          const moved = el[prop] - before;
          state["scroll" + axis] = (state["scroll" + axis] || 0) + moved;
          if (Math.abs(moved) >= Math.abs(delta) || root || /contain|none/.test(style["overscrollBehavior" + axis])) break;
          delta -= moved;
        }
      }
    }
    function aim() {
      hover(target, anchor);
      send(target, new PointerEvent("pointermove", { ...init(anchor), pointerType: "mouse", pointerId: 1, isPrimary: true, button: -1 }));
      send(target, new MouseEvent("mousemove", init(anchor)));
    }
    function wheel(dx, dy, dz = 0, mode = 0, zoom = false) {
      if (!dx && !dy && !dz) return;
      const options = init(anchor), ctrl = zoom || options.ctrlKey;
      state.wheelEvents = (state.wheelEvents || 0) + 1;
      const event = new WheelEvent("wheel", { ...options, ctrlKey: ctrl, deltaX: dx, deltaY: dy, deltaZ: dz, deltaMode: mode });
      if (!send(target, event) || ctrl || options.metaKey) return;
      if (options.shiftKey && !dx) { dx = dy; dy = 0; }
      pan(target, dx, dy, mode);
    }
    const ctx = { state, hit, init, send, hover, activate, pan, wheel, aim };
    let driver;
    if (device === "trackpad") driver = globalThis.__safariChatTrackpad(ctx, target, anchor, spec.eventChannel);
    else if (device !== "wheel") driver = globalThis.__safariChatContacts(ctx, spec);
    const gallery = [...snapshot.refs.values()].find(ref => ref.gallery?.scope.contains(target))?.gallery;
    const item = () => gallery?.tabs.findIndex(t => t.element.getAttribute("aria-selected") === "true") + 1;
    if (gallery) state.fromItem = item();
    function play(points) {
      if (device === "trackpad" || device === "wheel") {
        if (!target.isConnected) throw new Error("The hovered surface disappeared.");
        hit(anchor);
      } else if (points.length) globalThis.__safariChatActionPointer?.track?.(points[0].x, points[0].y);
      driver.frame(points);
    }
    function keyframe() {
      const frame = frames[index];
      if (frame.modifiers) mods = frame.modifiers;
      if (device === "wheel") {
        aim(); wheel(frame.deltaX || 0, frame.deltaY || 0, frame.deltaZ || 0, spec.deltaMode);
        return;
      }
      state.elapsed = frame.at; play(frame.points);
    }
    function advanceWheel(elapsed) {
      hit(anchor);
      if (!target.isConnected) throw new Error("The wheel target disappeared.");
      while (index + 1 < frames.length && state.elapsed < elapsed) {
        const next = frames[index + 1], until = Math.min(elapsed, next.at);
        if (next.modifiers) mods = next.modifiers;
        const share = spec.discrete ? Number(until === next.at) : (until - state.elapsed) / (next.at - frames[index].at);
        wheel((next.deltaX || 0) * share, (next.deltaY || 0) * share, (next.deltaZ || 0) * share, spec.deltaMode);
        state.elapsed = until;
        if (until === next.at) index++;
      }
      if (index === frames.length - 1) return "gesture finished";
    }
    function advance(dt) {
      if (state.speed === 0) return;
      const elapsed = Math.min(frames.at(-1).at, state.elapsed + dt * 1000 * state.speed);
      if (device === "wheel") return advanceWheel(elapsed);
      while (index + 1 < frames.length && frames[index + 1].at <= elapsed) { index++; keyframe(); }
      if (index === frames.length - 1) return "gesture finished";
      state.elapsed = elapsed;
      const a = frames[index], b = frames[index + 1];
      const fraction = (elapsed - a.at) / (b.at - a.at);
      if (!fraction) return;
      const points = a.points.map(p => {
        const end = b.points.find(q => q.id === p.id);
        if (!end) return p;
        const out = { ...p };
        for (const key of ["x", "y", "pressure", "tiltX", "tiltY", "twist", "width", "height", "tangentialPressure"]) {
          if (p[key] != null && end[key] != null) out[key] = p[key] + (end[key] - p[key]) * fraction;
        }
        return out;
      });
      play(points);
    }
    return globalThis.__safariChatStartMotion(owner, state, element, advance, keyframe, reason => {
      if (reason !== "gesture finished") driver?.cancel();
      driver?.close?.();
      if (gallery) state.currentItem = item();
      globalThis.__safariChatActionPointer?.finishTrack?.();
    });
  };
  return true;
}
