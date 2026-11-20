import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { MotionSession } from "../extension/core/motion-session.js";

async function testTargetedScroll(page, api) {
  const signal = new AbortController().signal;
  await page.setContent(`<style>body{margin:0}.hero{height:2700px}section{height:220px}footer{height:60000px}</style>
    <div class="hero">Product tiles</div><section class="gallery" aria-label="Entertainment"><div role="tablist">
    ${[1,2,3].map(n=>`<button role="tab" aria-selected="${n===3}" aria-controls="item-${n}">Item ${n}</button>`).join("")}
    </div>${[1,2,3].map(n=>`<div role="tabpanel" id="item-${n}">Offer ${n}</div>`).join("")}</section><footer>Long footer</footer>`);
  await page.evaluate(()=>{
    scrollTo(0,0);
    for (const tab of document.querySelectorAll("[role=tab]")) tab.onclick=()=>{
      for (const item of document.querySelectorAll("[role=tab]")) item.setAttribute("aria-selected",String(item===tab));
    };
  });
  const execute = createBrowserTools({ api, defaultTabId:7, pageChars:6000, motionSession:new MotionSession(api,()=>{}), approve:async()=>"once" });
  const act = args => execute(args,signal);
  const read = () => act({operation:"read"});
  const seek = (text, direction = "down") => act({operation:"scroll_until", direction, text, speed:1e7});
  await read();
  const result = await seek("carousel");
  assert.equal(result.found,true); assert.equal(result.motion.active,false);
  const position = await page.evaluate(()=>scrollY);
  assert.ok(position>0 && position<=2700);
  assert.ok(await page.locator("[role=tablist]").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  }), "the carousel's navigation strip must be fully on screen at the stop");
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(()=>scrollY),position,"the page stays at the target during model latency");
  for (const expected of [2,1]) {
    const gallery = (await read()).elements.find(item=>item.kind==="carousel");
    const move = await act({operation:"scroll",elementId:gallery.id,direction:"left"});
    assert.equal(move.requestedItem,expected);
  }
  await read(); assert.equal((await seek("Offer 2")).found,true);
  await read(); const missing = await seek("An absent phrase");
  assert.equal(missing.found,false); assert.equal(missing.motion.reason,"search limit");
  const top = await page.evaluate(()=>scrollY);
  assert.ok(top < 60000);
  await read(); assert.equal((await seek("carousel","up")).found,true);
  await page.setContent('<style>article{margin-top:1900px}footer{height:1200px}</style><input value="needle"><textarea>needle</textarea><div contenteditable>needle</div><p hidden>needle</p><p style="opacity:0">needle</p><article><p>First <em>needle</em></p><p>Second <b>needle</b></p></article><footer></footer>');
  await read();
  const found = await act({operation:"find_text", text:"needle", occurrence:2});
  assert.equal(found.found,true); assert.equal(found.inViewport,true);
  assert.equal(found.excerpt,"Second needle");
  await read();
  const absent = await act({operation:"find_text", text:"needle", occurrence:3});
  assert.equal(absent.found,false); assert.equal(absent.matchesSeen,2);
  assert.equal(await page.locator("input").inputValue(),"needle");
  console.log("Target search stopped at the gallery in both directions, stayed still between calls, moved two slides left and bounded a missing target.");
}

export async function testContinuousScroll(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.goto(origin + "/__workflow/one");
    await page.setContent('<main style="height:12000px"><section aria-label="Notes" style="height:120px;overflow:auto"><p>Recent notes</p><div style="height:500px"></div><p>Earlier notes</p></section></main>');
    const api = { tabs: { get: async id => ({ id, url: page.url(), status: "complete" }) }, scripting: {
      executeScript: async ({ func, args }) => [{ result: await page.evaluate(({ code, args }) => eval(`(${code})`)(...args), { code: func.toString(), args }) }],
    } };
    const controller = new AbortController(), approvals = [];
    const scrolling = new MotionSession(api, () => {});
    const execute = createBrowserTools({ api, defaultTabId: 7, pageChars: 6000, motionSession: scrolling, approve: async action => { approvals.push(action.title); } });
    const read = () => execute({ operation: "read" }, controller.signal);
    const move = (direction, speed, elementId, wait) => execute({ operation: "scroll", direction, speed, elementId, wait }, controller.signal);
    const control = (operation, speed) => execute({ operation, speed }, controller.signal);
    await assert.rejects(move("down", 1413.75), /Read the current page/);
    const area = (await read()).elements.find(ref => ref.label === "Notes" && ref.actions.includes("scroll"));
    assert.ok(area);
    await move("down", 1413.75, area.id);
    await assert.rejects(move("right", 509.125), /supported by the scrolling area/);
    const boundary = await control("wait_motion");
    assert.equal(boundary.motion.reason, "scroll boundary");
    assert.deepEqual(await page.evaluate(() => [scrollY, document.querySelector("section").scrollTop > 0]), [0, true]);
    await read();
    await execute({ operation: "scroll", direction: "down", speed: 293.5, speedChanges: [{ after: 32, speed: 703.25 }, { after: 73, speed: 0 }] }, controller.signal);
    await page.waitForFunction(() => globalThis.__safariChatMotion.state.speed === 0);
    assert.equal(await page.evaluate(() => scrollY), 73);
    await control("set_speed", 173.25);
    await page.waitForFunction(() => scrollY > 25);
    const distance = () => page.evaluate(async () => {
      const start = performance.now(), y = scrollY;
      while (performance.now() - start < 250) await new Promise(requestAnimationFrame);
      return (scrollY - y) / (performance.now() - start);
    });
    const slow = await distance();
    const snapshot = await read();
    assert.equal(snapshot.motion.speed, 173.25); assert.ok(snapshot.viewport.scrollY > 0);
    const grants = approvals.length;
    await move("down", 1413.75);
    assert.ok(await distance() > slow * 2, "changing speed increases physical scroll velocity");
    await control("set_speed", 0); assert.equal(await distance(), 0);
    await move("up", 509.125);
    assert.ok(await distance() < 0, "the active scroll can reverse");
    const stopped = await control("stop_motion");
    assert.equal(stopped.motion.reason, "stopped by model");
    assert.equal(await distance(), 0);
    assert.equal(approvals.length, grants, "speed changes and stop use the existing continuous-scroll grant");
    assert.ok(approvals.includes("Scroll continuously?"));

    await read();
    const waiting = move("down", 173.25, null, true);
    await page.waitForFunction(() => globalThis.__safariChatMotion?.state.active);
    await page.keyboard.press("Escape");
    assert.equal((await waiting).motion.reason, "stopped by user");
    assert.equal(await distance(), 0);
    await read(); await assert.rejects(move("down", 1413.75), /user stopped/);

    // An ongoing task can read a new document after navigation, but old motion never follows it.
    const next = new MotionSession(api, () => {});
    let blocked = false;
    const perform = createBrowserTools({ api, defaultTabId: 7, pageChars: 6000, motionSession: next,
      approve: async () => {}, readAccess: async () => ({ mode: "auto", allowed: [], blocked: blocked ? ["127.0.0.1"] : [] }) });
    const start = async () => {
      await perform({ operation: "read" }, controller.signal);
      await perform({ operation: "scroll", direction: "down", speed: 509.125 }, controller.signal);
    };
    await start();
    const navigated = next.current.finished;
    await page.reload();
    assert.equal((await navigated).reason, "page changed"); assert.equal(await distance(), 0);
    await start(); const revoked = next.current.finished; blocked = true;
    assert.equal((await revoked).reason, "access or connection changed"); assert.equal(await distance(), 0);
    blocked = false;
    await start(); const cancelled = next.current.finished; controller.abort();
    assert.equal((await cancelled).reason, "task stopped"); assert.equal(await distance(), 0);
    console.log("Continuous scrolling passed physical speed changes, direction reversal, nested boundaries, model and keyboard stops, navigation, revocation and cancellation.");
    await testTargetedScroll(page, api);
  } finally { await page.close(); }
}
