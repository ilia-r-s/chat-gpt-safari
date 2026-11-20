const number = { type: "number" };
const modifiers = ["Shift", "Control", "Alt", "Meta"];
const pointProperties = { id: { type: "integer" }, x: number, y: number, buttons: { type: "integer" },
  pressure: number, width: number, height: number, tiltX: number, tiltY: number, twist: number, tangentialPressure: number };

export const GESTURE_TOOL = {
  type: "function", name: "gesture", strict: false,
  description: "After read, play timed webpage input. Trackpad: anchor over a picture; move two IDs left for a swipe (positive deltaX), apart for pinch, around for rotation. Wheel: anchor at cursor and supply deltaX/Y/Z per frame, spread over the preceding interval, or use discrete notches. Touch: independent fingers. Frames use cumulative ms; list all active points, omit lifted IDs, finish empty. Vary timing for speed or holds. Mouse/pen buttons: 0 hover, 1 tip/left, 2 right, 4 middle, 8 back, 16 forward, 32 eraser. Supports taps, chords, pressure 0-1, tilt, twist and HTML dragDrop. Verify effects with read; wait defaults true.",
  parameters: { type: "object", additionalProperties: false, required: ["device", "frames"], properties: {
    tabId: { type: ["integer", "null"] }, elementId: { type: ["string", "null"] },
    device: { type: "string", enum: ["trackpad", "wheel", "touch", "mouse", "pen"] },
    deltaMode: { type: "string", enum: ["pixel", "line", "page"] }, discrete: { type: "boolean" },
    anchor: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: number, y: number } },
    frames: { type: "array", items: { type: "object", additionalProperties: false, required: ["at"], properties: {
      at: number, deltaX: number, deltaY: number, deltaZ: number, points: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "x", "y"], properties: pointProperties } },
      modifiers: { type: "array", items: { type: "string", enum: modifiers } },
    } } }, dragDrop: { type: "boolean" }, wait: { type: "boolean" },
  } },
};

export function validateGesture(args, viewport, bounds) {
  const { device, frames, anchor, dragDrop } = args;
  const inside = (p, box) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= box[0] && p.x < box[2] && p.y >= box[1] && p.y < box[3];
  const wheel = device === "wheel";
  if (!viewport || !["trackpad", "wheel", "touch", "mouse", "pen"].includes(device) || !Array.isArray(frames) || frames.length < 2 || frames.length > 128) throw new Error("Choose an input device and 2-128 gesture frames after reading the page.");
  if (dragDrop && device !== "mouse") throw new Error("HTML drag and drop needs a mouse path.");
  const screen = [0, 0, viewport.width, viewport.height], target = bounds ?? screen;
  if ((wheel || anchor != null) && (!["trackpad", "wheel"].includes(device) || !inside(anchor, screen))) throw new Error("Choose an anchor inside the visible website for the trackpad or wheel.");
  if (frames[0]?.at !== 0 || !wheel && (!Array.isArray(frames[0]?.points) || !frames[0].points.length || frames.at(-1)?.points?.length !== 0)) throw new Error("Start at 0 ms. Contact paths must start with points and finish with an empty list.");
  if (args.deltaMode != null && (!wheel || !["pixel", "line", "page"].includes(args.deltaMode)) || args.discrete != null && (!wheel || typeof args.discrete !== "boolean")) throw new Error("Choose pixel, line or page units and an optional discrete setting for the wheel.");
  let total = 0, fingers = 0;
  const ranges = { pressure: [0, 1], width: [0, 512], height: [0, 512], tiltX: [-90, 90], tiltY: [-90, 90], twist: [0, 359], tangentialPressure: [-1, 1] };
  for (const [i, frame] of frames.entries()) {
    if (!Number.isFinite(frame?.at) || frame.at > 60000 || i && frame.at <= frames[i - 1].at) throw new Error("Frame times must strictly increase within 60,000 milliseconds.");
    if (frame.modifiers != null && (!Array.isArray(frame.modifiers) || frame.modifiers.length > 4 || frame.modifiers.some(m => !modifiers.includes(m)))) throw new Error("Use Shift, Control, Alt or Meta for modifiers.");
    const deltas = ["deltaX", "deltaY", "deltaZ"].filter(key => frame[key] != null);
    if (wheel) {
      if ((frame.points != null && (!Array.isArray(frame.points) || frame.points.length)) || deltas.some(key => !Number.isFinite(frame[key]) || Math.abs(frame[key]) > 1000000)) throw new Error("Supply finite wheel deltas and a fixed anchor.");
      continue;
    }
    if (deltas.length) throw new Error("Wheel deltas need the wheel device.");
    if (!Array.isArray(frame.points) || frame.points.length > (["mouse", "pen"].includes(device) ? 1 : 10)) throw new Error("Use one mouse or pen pointer, or up to ten contact points per frame.");
    total += frame.points.length; fingers = Math.max(fingers, frame.points.length);
    const ids = new Set();
    for (const p of frame.points) {
      if (!inside(p, screen) || !Number.isInteger(p.id) || p.id < 0 || p.id > 31 || ids.has(p.id)) throw new Error("Choose distinct contact IDs from 0 to 31 and points inside the website.");
      ids.add(p.id);
      if (p.buttons != null && (!Number.isInteger(p.buttons) || p.buttons < 0 || p.buttons > 63)) throw new Error("Invalid pointer button mask.");
      for (const [key, [min, max]] of Object.entries(ranges)) if (p[key] != null && (!Number.isFinite(p[key]) || p[key] < min || p[key] > max)) throw new Error("Invalid pointer " + key + ".");
    }
  }
  if (total > 512) throw new Error("Use at most 512 contact samples per gesture.");
  const start = anchor ?? frames[0].points[0];
  if (!inside(start, target)) throw new Error("Start the gesture inside the selected target.");
  return { device, frames, anchor: anchor ?? null, dragDrop: !!dragDrop, fingers,
    ...(wheel && { deltaMode: ["pixel", "line", "page"].indexOf(args.deltaMode ?? "pixel"), discrete: args.discrete === true }) };
}

export function gesturePreview(spec) {
  const paths = [], current = new Map();
  for (const frame of spec.frames) {
    const points = frame.points || [];
    for (const id of current.keys()) if (!points.some(p => p.id === id)) current.delete(id);
    for (const p of points) {
      if (!current.has(p.id)) { const path = []; current.set(p.id, path); paths.push(path); }
      current.get(p.id).push([p.x, p.y]);
    }
  }
  return paths;
}
