// Serialized into Safari's isolated world. DOM references stay in this document.
export function controlPageMotion(command, id, options) {
  if (command === "install") {
    globalThis.__safariChatStartMotion = (owner, state, element, advance, begin, end) => {
      if (globalThis.__safariChatMotion?.state.active) throw new Error("Another motion is already running on this page.");
      if (document.hidden) throw new Error("Motion needs a visible tab.");
      const url = location.href, listeners = new AbortController();
      let frame, previous = performance.now(), renewed = previous;
      function stop(reason) {
        if (!state.active) return state;
        state.active = false; state.reason = reason;
        cancelAnimationFrame(frame); listeners.abort();
        try { end?.(reason); } finally {
          globalThis.__safariChatMotion = { id: owner, state };
        }
        return state;
      }
      function tick(now) {
        if (location.href !== url || !element.isConnected) return stop("page changed");
        if (document.hidden) return stop("tab hidden");
        if (now - renewed >= 4000) return stop("connection lost");
        const dt = Math.max(0, Math.min(64, now - previous)) / 1000;
        previous = now;
        let reason;
        try { reason = advance(dt, now); }
        catch (error) { reason = error.message || "motion interrupted"; }
        if (reason) return stop(reason);
        if (state.active) frame = requestAnimationFrame(tick);
      }
      function takeOver(event) {
        if (!event.isTrusted) return;
        if (event.type === "keydown" && !["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
        stop("stopped by user");
      }
      const listen = { capture: true, passive: true, signal: listeners.signal };
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) window.addEventListener(type, takeOver, listen);
      window.addEventListener("pagehide", () => stop("page changed"), listen);
      document.addEventListener("visibilitychange", () => { if (document.hidden) stop("tab hidden"); }, listen);
      globalThis.__safariChatMotion = { id: owner, state, stop,
        renew() {
          if (performance.now() - renewed >= 4000) return stop("connection lost");
          renewed = performance.now();
        },
      };
      try { begin?.(); } catch (error) { stop("start interrupted"); throw error; }
      if (state.active) frame = requestAnimationFrame(tick);
      return state;
    };
    globalThis.__safariChatStartScroll = (target, owner, direction, speed, speedChanges) => {
      const state = { active: true, kind: "scroll", direction, speed };
      let fraction = 0, stalled = 0, lastDirection, travelled = 0, checkpoint = 0;
      const applySpeeds = () => {
        while (checkpoint < speedChanges.length && travelled >= speedChanges[checkpoint].after) {
          state.speed = speedChanges[checkpoint++].speed;
          fraction = 0;
        }
      };
      applySpeeds();
      return globalThis.__safariChatStartMotion(owner, state, target, (dt, now) => {
        if (state.direction !== lastDirection || !state.speed) { stalled = 0; fraction = 0; }
        lastDirection = state.direction;
        const horizontal = ["left", "right"].includes(lastDirection);
        const sign = ["up", "left"].includes(lastDirection) ? -1 : 1;
        fraction += sign * Math.min(horizontal ? target.scrollWidth : target.scrollHeight, state.speed * dt);
        const remaining = speedChanges[checkpoint] ? Math.ceil(speedChanges[checkpoint].after - travelled) : Infinity;
        const distance = sign * Math.min(Math.abs(Math.trunc(fraction)), remaining);
        if (!distance) return;
        fraction -= distance;
        const before = horizontal ? target.scrollLeft : target.scrollTop;
        target.scrollBy({ left: horizontal ? distance : 0, top: horizontal ? 0 : distance, behavior: "instant" });
        const moved = Math.abs((horizontal ? target.scrollLeft : target.scrollTop) - before);
        if (moved) { stalled = 0; travelled += moved; applySpeeds(); }
        else if (!stalled) stalled = now;
        else if (now - stalled >= 200) return "scroll boundary";
      });
    };
    return true;
  }
  const motion = globalThis.__safariChatMotion;
  if (!motion || motion.id !== id) return { active: false, reason: "page changed" };
  if (motion.state.active) {
    if (command === "stop") return motion.stop(options.reason);
    motion.renew();
    if (command === "adjust" && motion.state.active) {
      motion.state.speed = options.speed;
      if (options.direction) motion.state.direction = options.direction;
    }
  }
  return motion.state;
}
