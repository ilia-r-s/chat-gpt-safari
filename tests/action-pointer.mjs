import assert from "node:assert/strict";
import { createBrowserTools, readTab } from "../extension/core/browser-tools.js";

export async function testActionPointer(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
  try {
    await page.goto(origin + "/__workflow/one");
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box}body{font:16px system-ui;margin:0;color:#25282b}
      main{margin:48px 24px;max-width:520px}h1{font-size:28px;letter-spacing:-1px}
      p{line-height:1.6}button{font:inherit;border-radius:8px;border:1px solid #a4abb2;padding:10px 16px;background:#f7f8fa}
      .clip{overflow:hidden;width:max-content}@media(max-width:450px){.clip{width:140px}.clip button{width:220px;text-align:left}}
      ::backdrop{background:#f00;pointer-events:auto}
    </style><main><h1>Trip itinerary</h1><p>Meet at the station at noon.</p>
      <div class="clip"><button>View itinerary</button></div>
      <p><label><input type="checkbox"> Include return trip</label></p></main>`);
    const controller = new AbortController();
    let afterAim;
    const api = {
      tabs: { get: async id => ({ id, url: page.url(), status: "complete", active: true }) },
      scripting: { executeScript: async ({ func, args }) => {
        const result = await page.evaluate(({ source, args }) => eval("(" + source + ")")(...args), { source: func.toString(), args });
        if (func.name === "showActionPointer" && args[2] === "aim") await afterAim?.();
        return [{ result }];
      } },
    };
    const execute = createBrowserTools({ api, defaultTabId: 1, pageChars: 6000, approve: async () => {} });
    const read = () => execute({ operation: "read" }, controller.signal);
    const act = (operation, elementId, extra) => execute({ operation, elementId, ...extra }, controller.signal);
    await page.evaluate(() => {
      window.pointerHits = element => {
        const pointer = window.__safariChatActionPointer;
        if (!pointer || !element) return false;
        const box = pointer.position.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.left + 3, box.top + 3));
      };
      window.clicks = [];
      document.querySelector("button").onclick = event => window.clicks.push(window.pointerHits(event.currentTarget));
    });

    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 600 });
      const snapshot = await read();
      assert.ok(!("pointerRect" in snapshot));
      await page.waitForFunction(() => window.pointerHits(document.querySelector("h1")), null, { timeout: 2000 });
      const target = snapshot.elements.find(element => element.label === "View itinerary");
      const before = await page.evaluate(() => {
        window.firstPointer = window.__safariChatActionPointer.host;
        return window.clicks.length;
      });
      await act("click", target.id);
      const drawn = await page.evaluate(() => {
        const { host, position } = window.__safariChatActionPointer;
        const box = position.getBoundingClientRect(), clip = document.querySelector(".clip").getBoundingClientRect();
        return { hits: window.clicks.slice(), single: document.querySelectorAll("#safari-chat-action-pointer").length === 1 && host === window.firstPointer,
          passesThrough: window.pointerHits(document.querySelector("button")), hidden: host.inert && host.getAttribute("aria-hidden") === "true",
          inside: box.left + 3 > clip.left && box.left + 3 < clip.right };
      });
      assert.equal(drawn.hits.length, before + 1);
      assert.ok(drawn.hits.at(-1) && drawn.passesThrough && drawn.single && drawn.hidden && drawn.inside);
      if (width === 900) await page.screenshot({ path: "build/screenshots/action-pointer.png", clip: { x: 10, y: 28, width: 330, height: 230 } });
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      document.querySelector("input").focus();
      const text = document.querySelector("p").firstChild, range = document.createRange();
      range.setStart(text, 12); range.setEnd(text, 19);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const excerpt = await readTab(api, 1, 6000, { selectionOnly: true, expectedURL: page.url() });
    assert.equal(excerpt.selection, "station");
    assert.ok(!("pointerRect" in excerpt));
    assert.equal(await page.evaluate(() => {
      const { position, svg } = window.__safariChatActionPointer;
      const box = position.getBoundingClientRect(), text = getSelection().getRangeAt(0).getBoundingClientRect();
      return getSelection().toString() === "station" && document.activeElement === document.querySelector("input") &&
        box.left + 3 >= text.left && box.left + 3 <= text.right && box.top + 3 >= text.top && box.top + 3 <= text.bottom &&
        !position.getAnimations().length && !svg.getAnimations().length;
    }), true);
    await page.locator("#safari-chat-action-pointer").waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await page.evaluate(() => !!window.__safariChatActionPointer), false);

    const checkbox = (await read()).elements.find(element => element.actions.includes("set_checked"));
    await page.locator("#safari-chat-action-pointer").waitFor({ state: "detached", timeout: 3000 });
    await act("set_checked", checkbox.id, { checked: false });
    assert.equal(await page.locator("#safari-chat-action-pointer").count(), 0);
    const check = (await read()).elements.find(element => element.actions.includes("set_checked"));
    await act("set_checked", check.id, { checked: true });
    assert.equal(await page.locator("input").isChecked(), true);
    assert.equal(await page.evaluate(() => window.pointerHits(document.querySelector("input"))), true);

    const beforeCancel = (await read()).elements.find(element => element.label === "View itinerary");
    afterAim = () => controller.abort();
    await assert.rejects(act("click", beforeCancel.id), { name: "AbortError" });
    assert.deepEqual(await page.evaluate(() => window.clicks), [true, true]);
    await page.reload();
    assert.equal(await page.locator("#safari-chat-action-pointer").count(), 0);
  } finally { await page.close(); }
}
