// Desktop WebKit has no constructible native touch or trackpad gesture events.
// Only numeric webpage input crosses into the site's world. This listener has
// no extension APIs and cannot initiate any extension operation.
export function installPageGestureEvents(channel) {
  const listeners = new AbortController();
  const contacts = new Map();
  const options = { capture: true, signal: listeners.signal };
  const timer = setTimeout(close, 15000);
  function close() { clearTimeout(timer); listeners.abort(); }
  window.addEventListener(channel, message => {
    const data = message.detail;
    if (data === "start") { clearTimeout(timer); return; }
    if (data === "close") { close(); return; }
    if (!data) return;
    const target = message.composedPath()[0];
    if (["touchstart", "touchmove", "touchend", "touchcancel"].includes(data.type)) {
      if (data.type === "touchstart") for (const p of data.changedTouches) contacts.set(p.identifier, target);
      const event = new UIEvent(data.type, { bubbles: true, cancelable: true, composed: true, view: window });
      for (const name of ["touches", "targetTouches", "changedTouches"]) {
        const points = Array.from(data[name], p => ({ ...p, target: contacts.get(p.identifier) ?? document.elementFromPoint(p.startX, p.startY) }));
        Object.defineProperty(points, "item", { value: i => points[i] ?? null });
        Object.defineProperty(event, name, { value: points });
      }
      for (const name of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) Object.defineProperty(event, name, { value: data[name] });
      if (!target.dispatchEvent(event)) message.preventDefault();
      if (data.type === "touchend" || data.type === "touchcancel") for (const p of data.changedTouches) contacts.delete(p.identifier);
      return;
    }
    if (!["gesturestart", "gesturechange", "gestureend"].includes(data.type) ||
        ![data.x, data.y, data.scale, data.rotation].every(Number.isFinite)) return;
    const event = new MouseEvent(data.type, { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: data.x, clientY: data.y, ctrlKey: data.ctrl, shiftKey: data.shift, altKey: data.alt, metaKey: data.meta });
    Object.defineProperties(event, { scale: { value: data.scale }, rotation: { value: data.rotation } });
    if (!target.dispatchEvent(event)) message.preventDefault();
  }, options);
  window.addEventListener("pagehide", close, options);
  return true;
}
