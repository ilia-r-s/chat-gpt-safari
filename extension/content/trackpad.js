// An indirect trackpad routes deltas to the surface under the stationary cursor.
export function installTrackpad() {
  globalThis.__safariChatTrackpad = (ctx, target, anchor, channel) => {
    const { state, send, init, activate, wheel } = ctx;
    let last = [], peak = 0, travel = 0, scale = 1, rotation = 0, transforming = false;
    let taps = 0, lastTap = -Infinity, transformed = false;
    const relay = detail => target.dispatchEvent(new CustomEvent(channel, { detail, bubbles: true, composed: true, cancelable: true }));
    let safariGesture = true;
    try { safariGesture = typeof document.createEvent("GestureEvent").initGestureEvent === "function"; } catch { safariGesture = false; }
    const center = points => ({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    });
    function transform(type) {
      const opts = init(anchor);
      if (!safariGesture) {
        if (!channel) return true;
        state.events++;
        const accepted = relay({ type, x: anchor.x, y: anchor.y, scale, rotation, ctrl: opts.ctrlKey, shift: opts.shiftKey, alt: opts.altKey, meta: opts.metaKey });
        if (!accepted) state.prevented++;
        return accepted;
      }
      const e = document.createEvent("GestureEvent");
      e.initGestureEvent(type, true, true, window, 0, 0, 0, anchor.x, anchor.y,
        opts.ctrlKey, opts.altKey, opts.shiftKey, opts.metaKey, target, scale, rotation);
      return send(target, e);
    }
    function finishTransform() {
      if (transforming) transform("gestureend");
      transforming = false; scale = 1; rotation = 0;
    }
    return {
      frame(points) {
        if (!last.length && points.length) {
          if (channel) relay("start");
          ctx.aim();
          peak = 0; travel = 0; transformed = false;
        }
        peak = Math.max(peak, points.length);
        // Finger order may change without a finger lifting.
        const matched = last.map(a => [a, points.find(b => a.id === b.id)]).filter(pair => pair[1]);
        if (matched.length >= 1) {
          const before = center(matched.map(pair => pair[0])), after = center(matched.map(pair => pair[1]));
          const dx = before.x - after.x, dy = before.y - after.y;
          travel += Math.max(...matched.map(([a, b]) => Math.hypot(b.x-a.x, b.y-a.y)));
          if (matched.length >= 2) {
            const [[a, c], [b, d]] = matched, x0 = b.x-a.x, y0 = b.y-a.y, x1 = d.x-c.x, y1 = d.y-c.y;
            const oldLength = Math.hypot(x0, y0), ratio = oldLength >= 1 ? Math.hypot(x1, y1) / oldLength : 1;
            const angle = Math.atan2(x0*y1 - y0*x1, x0*x1 + y0*y1) * 180 / Math.PI;
            if (ratio > 0 && (Math.abs(ratio - 1) > 0.00001 || Math.abs(angle) > 0.001)) {
              if (!transforming) transform("gesturestart");
              transformed = transforming = true; scale *= ratio; rotation += angle;
              state.scale = scale; state.rotation = rotation;
              const accepted = transform("gesturechange");
              if (accepted && ratio !== 1 && !safariGesture && (!channel || typeof GestureEvent === "undefined")) wheel(0, -100 * Math.log(ratio), 0, 0, true);
              if (!safariGesture && !channel && Math.abs(angle) > 0.001) state.rotationUnavailable = true;
            }
          }
          if (dx || dy) wheel(dx, dy);
        }
        if (points.length < 2) finishTransform();
        if (last.length && !points.length && !transformed && travel < 4 && peak <= 2) {
          taps = state.elapsed - lastTap < 450 ? taps + 1 : 1; lastTap = state.elapsed;
          activate(target, anchor, peak === 2 ? 2 : 0, taps, "mouse");
        }
        last = points;
      },
      cancel: finishTransform,
      close: () => { if (channel) document.dispatchEvent(new CustomEvent(channel, { detail: "close", bubbles: true })); },
    };
  };
  return true;
}
