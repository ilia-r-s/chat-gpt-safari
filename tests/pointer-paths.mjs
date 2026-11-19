import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { MotionSession } from "../extension/core/motion-session.js";

export async function testPointerPaths(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.goto(origin + "/__workflow/one");
    await page.setContent('<style>*{margin:0}canvas{position:absolute;left:40px;top:40px;background:#eee}#handle{position:absolute;left:40px;top:300px;width:40px;height:35px;background:teal;cursor:grab}</style><canvas width="400" height="220" aria-label="Drawing pad"></canvas><div id="handle" draggable="true" aria-label="Handle"></div>');
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
      window.events = []; window.releases = 0; window.clicks = 0;
      let drawing = false, held = false;
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup"]) {
        document.addEventListener(type, e => window.events.push({ type, x: e.clientX, y: e.clientY, buttons: e.buttons, id: e.pointerId, trusted: e.isTrusted }));
      }
      canvas.addEventListener("pointerdown", e => { drawing = true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); });
      canvas.addEventListener("pointermove", e => { if (drawing) { ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); } });
      canvas.addEventListener("pointerup", () => { drawing = false; window.releases++; });
      canvas.addEventListener("pointercancel", () => { drawing = false; });
      document.addEventListener("click", () => window.clicks++);
      const handle = document.getElementById("handle");
      handle.addEventListener("mousedown", () => { held = true; });
      document.addEventListener("mousemove", e => { if (held) { handle.style.left = (e.clientX - 10) + "px"; handle.style.top = (e.clientY - 10) + "px"; } });
      document.addEventListener("mouseup", () => { held = false; });
    });
    const api = { tabs: { get: async id => ({ id, url: page.url(), status: "complete" }) }, scripting: {
      executeScript: async ({ func, args = [] }) => [{ result: await page.evaluate(({ code, args }) => eval(`(${code})`)(...args), { code: func.toString(), args }) }],
    } };
    const approvals = [], motionSession = new MotionSession(api, () => {}), controller = new AbortController();
    const perform = createBrowserTools({ api, defaultTabId: 9, pageChars: 6000, motionSession, approve: async a => { approvals.push(a.operation); } });
    const tool = args => perform(args, controller.signal);
    const surface = async label => (await tool({ operation: "read" })).elements.find(el => el.label === label);
    const pad = await surface("Drawing pad");
    assert.ok(pad.actions.includes("drag")); assert.deepEqual(pad.bounds, [40, 40, 440, 260]);
    const points = [[60,60,420.75], [140,80,0], [90,175,900.5], [195,150,137.25], [140,95,null]].map(([x,y,speed]) => ({ x,y,speed }));
    const drag = { operation: "drag", elementId: pad.id, speed: 311.125, path: points, wait: false };
    await assert.rejects(tool({ ...drag, path: [{ x: 10, y: 10 }, ...points] }), /inside the selected target/);
    await assert.rejects(tool({ ...drag, path: [...points, { x: 901, y: 10 }] }), /visible viewport/);
    await assert.rejects(tool({ ...drag, speed: -2 }), /finite speed/);
    assert.deepEqual(approvals, ["read"]);
    await tool(drag);
    await page.waitForFunction(() => globalThis.__safariChatMotion.state.waypoint === 1);
    assert.deepEqual(await page.evaluate(() => {
      const box = globalThis.__safariChatActionPointer.position.getBoundingClientRect();
      return [box.left + 3, box.top + 3];
    }), [140, 80]);
    const paused = await page.evaluate(() => window.events.length);
    await page.waitForTimeout(130); assert.equal(await page.evaluate(() => window.events.length), paused);
    await tool({ operation: "set_speed", speed: 728.625 });
    const finished = (await tool({ operation: "wait_motion" })).motion;
    assert.equal(finished.reason, "path finished"); assert.equal(finished.released, true);
    assert.deepEqual([finished.x, finished.y, finished.waypoint], [140, 95, 4]);
    const result = await page.evaluate(() => {
      const pixels = document.querySelector("canvas").getContext("2d").getImageData(0,0,400,220).data;
      return { events: window.events, ink: pixels.filter((n,i) => i % 4 === 3 && n > 0).length, releases: window.releases, clicks: window.clicks };
    });
    const pointer = result.events.filter(e => e.type.startsWith("pointer"));
    assert.equal(pointer.filter(e => e.type === "pointerdown").length, 1);
    assert.equal(new Set(pointer.map(e => e.id)).size, 1);
    assert.equal(pointer.at(-1).type, "pointerup"); assert.equal(pointer.at(-1).buttons, 0);
    for (const { x,y } of points.slice(1)) assert.ok(pointer.some(e => e.x === x && e.y === y && e.type === "pointermove" && e.buttons === 1));
    assert.ok(result.ink > 200); assert.equal(result.releases, 1); assert.equal(result.clicks, 0);
    assert.ok(pointer.every(e => !e.trusted));
    assert.equal(approvals.filter(op => op === "drag").length, 1);

    const handle = await surface("Handle");
    const target = { x: 250, y: 370 };
    const mouseDrag = await tool({ operation: "drag", elementId: handle.id, path: [{ x:50,y:310 }, target], speed: 735.5 });
    assert.equal(mouseDrag.motion.released, true);
    assert.equal(await page.locator("#handle").evaluate(e => e.offsetLeft), 240);
    assert.equal(await page.locator("#handle").evaluate(e => e.offsetTop), 360);

    const moved = await surface("Handle");
    await page.evaluate(() => { window.events = []; });
    const hover = await tool({ operation: "move_pointer", elementId: moved.id, path: [target,{ x:160,y:95,speed:333.25 },{ x:90,y:90 }], speed: 900 });
    assert.equal(hover.motion.reason, "path finished");
    assert.ok(await page.evaluate(() => window.events.some(e => e.type === "pointermove") && window.events.every(e => e.buttons === 0)));
    await tool({ operation: "read" });
    await tool({ operation: "move_pointer", elementId: null, path: [{x:650,y:510,speed:65.25},{x:710,y:490,speed:830.5},{x:660,y:440}], wait: false });
    await page.waitForFunction(() => globalThis.__safariChatMotion.state.x > 652);
    const adjusted = await tool({ operation: "set_speed", speed: 1500.25 });
    assert.equal(adjusted.motion.waypoint,0); assert.equal(adjusted.motion.speed,1500.25);
    const free = await tool({operation:"wait_motion"});
    assert.deepEqual([free.motion.reason,free.motion.x,free.motion.y], ["path finished",660,440]);
    assert.ok(await page.evaluate(() => window.clicks === 0 && window.events.every(e => e.buttons === 0)));

    const cancelTarget = await surface("Drawing pad");
    await tool({ ...drag, elementId: cancelTarget.id, speed: 0, path: [{x:60,y:60,speed:0},{x:420,y:240}] });
    const ended = motionSession.current.finished; controller.abort(); await ended;
    assert.ok(await page.evaluate(() => window.events.at(-2).type === "pointercancel" && window.events.at(-1).type === "mouseup"));
    console.log("Pointer paths passed drawing through corners, a mid-path pause and speed change, handle dragging, hover-only movement and cancellation with no click.");
  } finally { await page.close(); }
}
