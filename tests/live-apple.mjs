// Opt-in network check. Run with the same installed Chrome and Playwright as ui-smoke.mjs.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { MotionSession } from "../extension/core/motion-session.js";

const modulePath = process.env.SAFARI_CHAT_PLAYWRIGHT;
if (!modulePath) throw Error("Set SAFARI_CHAT_PLAYWRIGHT to an installed playwright/index.mjs.");
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.SAFARI_CHAT_CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
  // Fetch current first-party assets through the test runner. The isolated
  // Chrome process only needs the browser automation connection.
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET" || request.resourceType() === "media" ||
        url.protocol !== "https:" || !/(^|\.)(apple|cdn-apple)\.com$/.test(url.hostname)) return route.abort();
    let response;
    try {
      response = await route.fetch({ timeout: 15000, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch { await route.abort().catch(() => {}); }
    finally { await response?.dispose(); }
  });
  const response = await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  assert.ok(response?.ok(), "Apple returned HTTP " + response?.status());
  const url = page.url();
  const api = {
    tabs: { get: async () => ({ id: 1, active: true, status: "complete", url: page.url() }) },
    scripting: { executeScript: async ({ func, args = [] }) => [
      { result: await page.evaluate(({ src, args }) => eval("(" + src + ")")(...args), { src: func.toString(), args }) },
    ] },
  };
  const execute = createBrowserTools({ api, defaultTabId: 1, pageChars: 12000, motionSession: new MotionSession(api, () => {}), approve: async () => {} });
  const signal = AbortSignal.timeout(60000);
  const call = args => execute(args, signal);
  const read = () => call({ operation: "read" });
  await read();
  const seek = await call({ operation: "scroll_until", direction: "down", text: "carousel", speed: 4000 });
  assert.ok(seek.found && !seek.motion.active, "Gallery search ended at " + seek.motion?.reason);
  const snapshot = await read();
  const gallery = snapshot.elements.find(el => el.kind === "carousel");
  assert.ok(gallery, "No accessible carousel at the stopping position");
  const [left, top, right, bottom] = gallery.bounds;
  // Anchor to the gallery found by the extension, even if the homepage has several.
  const tabs = await page.evaluateHandle(([x,y]) => document.elementFromPoint(x,y)?.closest('[role="tablist"]'), [(left+right)/2, (top+bottom)/2]);
  const selected = () => tabs.evaluate(list => Array.from(list.querySelectorAll('[role="tab"]')).findIndex(tab => tab.getAttribute("aria-selected") === "true"));
  const start = await selected();
  assert.ok(start >= 0);
  const step = start < gallery.itemCount-1 ? 1 : -1;
  const point = await tabs.evaluate(list => {
    const section = list.closest("section") || list.parentElement;
    const visible = Array.from(section.querySelectorAll('[role="tabpanel"]')).map(panel => {
      const r = panel.getBoundingClientRect();
      const left = Math.max(0,r.left), top = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
      const x = Math.floor((left+right)/2), y = Math.floor((top+bottom)/2);
      return { x, y, area: right > left && bottom > top && panel.contains(document.elementFromPoint(x,y)) ? (right-left)*(bottom-top) : 0 };
    });
    const hit = visible.sort((a,b) => b.area-a.area)[0];
    return hit?.area ? { x: hit.x, y: hit.y } : null;
  });
  assert.ok(point, "No gallery picture is visible at the stopping position");
  for (const direction of [step, -step]) {
    // The hovered picture may be a sliver at a viewport edge. Finger travel on
    // the trackpad is independent of the stationary cursor over that picture.
    const contactX = Math.max(180, Math.min(snapshot.viewport.width-185, point.x));
    const contactY = Math.min(snapshot.viewport.height-6, point.y);
    const pair = (at, dx) => ({ at, points: [{ id: 1, x: contactX+dx, y: contactY }, { id: 2, x: contactX+dx+20, y: contactY+4 }] });
    const motion = await call({ operation: "gesture", device: "trackpad", anchor: point, frames: [pair(0,0), pair(180,-direction*160), {at:200,points:[]}] });
    assert.equal(motion.motion?.reason, "gesture finished", motion.error);
    const expected = direction === step ? start + step : start;
    await page.waitForFunction(({ list, expected }) => list.querySelectorAll('[role="tab"]')[expected]?.getAttribute("aria-selected") === "true", { list: tabs, expected }, {timeout: 4000}).catch(async () => {
      const hit = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.outerHTML.slice(0,180), point);
      throw Error(`Expected slide ${expected+1} in ${gallery.label}, observed ${await selected()+1}. Target ${JSON.stringify(point)}: ${hit}. Gesture: ${JSON.stringify(motion.motion)}`);
    });
    await read();
    if (direction === step) {
      // ARIA selection changes at the beginning of Apple's slide transition.
      // Send the reverse swipe after the first has visually settled.
      const panel = page.locator('[role="tabpanel"]').filter({ visible: true }).first();
      await panel.evaluate(async el => {
        let x = el.getBoundingClientRect().x, stillSince = performance.now();
        const stop = stillSince + 4000;
        while (performance.now() < stop && performance.now()-stillSince < 700) {
          await new Promise(requestAnimationFrame);
          const next = el.getBoundingClientRect().x;
          if (Math.abs(next-x) > .25) { x = next; stillSince = performance.now(); }
        }
      });
    }
  }
  assert.equal(page.url(), url);
  console.log("Live Apple gallery passed: found the carousel and swiped the picture in both directions.");
} finally { await browser.close(); }
