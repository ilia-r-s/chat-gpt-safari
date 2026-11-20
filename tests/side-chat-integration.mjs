import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chatPort, fixture } from "./background-fixture.mjs";

async function connectPanel(page, f) {
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async items => {
    await store(items);
    await page.evaluate(items => {
      const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }]));
      window.storageChanged?.(changes, "local");
    }, items);
  };
  await page.exposeFunction("panelRPC", message => f.events.message(message, f.sender));
  const ports = new Map();
  await page.exposeFunction("panelPost", (id, message) => {
    if (message.type === "run") {
      ports.set(id, chatPort(f, event => page.evaluate(({ id, event }) => window.deliver(id, event), { id, event })));
    }
    return ports.get(id)(message);
  });
  await page.addInitScript(() => {
    let id = 0;
    const listeners = new Map();
    window.deliver = (id, event) => listeners.get(id)?.(event);
    window.browser = {
      storage: { onChanged: { addListener: fn => { window.storageChanged = fn; } } },
      runtime: {
        id: "test-extension", onMessage: { addListener() {} }, sendMessage: window.panelRPC,
        connect() {
          const next = ++id;
          return { onMessage: { addListener: fn => listeners.set(next, fn) }, onDisconnect: { addListener() {} },
            disconnect: () => listeners.delete(next), postMessage: message => window.panelPost(next, message) };
        },
      },
    };
  });
}

// Bridge the real panel and background through WebExtension-shaped fixture ports.
// Script injection operates on a second real page. Only the OS and provider are simulated.
export async function testSideChatIntegration(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  try {
    const page = await context.newPage(), source = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await source.goto(origin + "/__workflow/one");
    await source.setContent('<article style="height:2300px">Local page for side chat</article>');
    const operations = [{ operation: "read" }, { operation: "scroll", direction: "down" }];
    const f = await fixture({ toolRequest: operations });
    f.data.settings = { interactionMode: "work" };
    f.api.tabs.get = async id => ({ id, url: source.url(), status: "complete" });
    let reads = 0;
    f.api.scripting = { executeScript: async ({ target, func, args }) => {
      assert.equal(target.tabId, 1);
      if (func.name === "snapshotPage") reads++;
      const result = await source.evaluate(({ code, args }) => eval(`(${code})`)(...args), { code: func.toString(), args });
      return [{ result }];
    } };
    await connectPanel(page, f);
    await page.goto(origin + "/panel/panel.html?tab=1");
    const prompt = page.getByRole("textbox", { name: "Message Safari Chat" });
    const mode = page.locator("#actions-guidance"), approval = page.locator("#approval");
    await page.locator("#model-trigger").click();
    await page.getByRole("slider", { name: "Reasoning effort" }).press("End");
    await page.keyboard.press("Escape");
    assert.equal(reads, 0);
    await prompt.fill("Scroll down this page."); await prompt.press("Enter");
    await approval.waitFor();
    await page.getByRole("button", { name: "More approval options" }).click();
    const options = await page.locator("#approval-options").boundingBox();
    assert.ok(options && options.x >= 0 && options.x + options.width <= 320 && options.y >= 0 && options.y + options.height <= 640);
    await page.screenshot({ path: "build/screenshots/panel-approval.png" });
    await page.getByRole("button", { name: /Allow for this site/ }).click();
    await page.locator("#stop-button").waitFor({ state: "hidden" });
    assert.equal(reads, 1); assert.ok(await source.evaluate(() => scrollY > 0));
    assert.deepEqual(Array.from(f.data["website-access:account-a"].allowed), ["127.0.0.1"]);
    assert.ok(f.requests.every(req => req.reasoning.effort === "high"));
    await mode.click(); await page.getByRole("button", { name: /Manage website access/ }).click();
    assert.equal(await page.getByLabel("Default for websites").count(), 0);
    await page.getByRole("button", { name: "Remove rule for 127.0.0.1" }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await mode.click();
    await page.screenshot({ path: "build/screenshots/panel-approval-selector.png" });
    await page.getByRole("button", { name: /Approve for me/ }).click();
    await mode.filter({ hasText: "Approve for me" }).waitFor();
    await page.reload();
    await mode.filter({ hasText: "Approve for me" }).waitFor();
    assert.equal(reads, 1, "opening or restoring chat does not read a page in automatic mode");
    f.requests.length = 0;
    await page.locator("#model-trigger").click();
    await page.locator("#reset-effort").click();
    await page.keyboard.press("Escape");
    await prompt.fill("Scroll again."); await prompt.press("Enter");
    await page.locator("#messages .assistant").nth(1).getByText("Hello").waitFor();
    assert.equal(reads, 2); assert.ok(f.requests.every(req => !req.reasoning));
    assert.equal(await page.locator("#approval").isVisible(), false);
    await page.screenshot({ path: "build/screenshots/panel-automatic.png" });

    // Safari's own site permission still requires a gesture when actions are automatic.
    f.requests.length = 0;
    const destination = "https://finance.yahoo.com/";
    operations.splice(0, operations.length, { operation: "open_tab", url: destination }, { operation: "read", tabId: 2 });
    f.api.tabs.get = async id => ({ id, windowId: 4, status: "complete", url: id === 1 ? source.url() : "" });
    f.api.permissions = { contains: async () => false };
    let sheets = 0;
    await page.exposeFunction("requestSiteInSafari", ({ origins, gesture }) => {
      assert.deepEqual(origins, ["https://finance.yahoo.com/*"]); assert.equal(gesture, true);
      if (++sheets === 1) throw Error("Sheet unavailable");
      return false;
    });
    await page.evaluate(() => { browser.permissions = {
      request: ({ origins }) => window.requestSiteInSafari({ origins, gesture: navigator.userActivation.isActive }), contains: async () => false,
    }; });
    await prompt.fill("Open Yahoo Finance in a new tab and check its page."); await prompt.press("Enter");
    const permit = page.getByRole("button", { name: "Allow in Safari…" });
    await permit.waitFor(); assert.equal(reads, 2);
    await mode.click(); await page.locator("#access-menu").getByRole("button", { name: /Approve for me/ }).click();
    assert.equal(sheets, 0); assert.equal(await permit.isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "More approval options" }).isVisible(), false);
    await page.screenshot({ path: "build/screenshots/panel-site-permission.png" });
    await permit.click(); await approval.getByText(/couldn’t open its permission sheet/).waitFor();
    await permit.click(); await page.locator("#stop-button").waitFor({ state: "hidden" });
    const output = f.requests.at(-1).input.findLast(item => item.type === "function_call_output");
    assert.match(JSON.parse(output.output).error, /finance\.yahoo\.com was not granted/);
    assert.equal(f.createdTabs.length, 1); assert.equal(sheets, 2); assert.equal(reads, 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

export async function testConversationModes(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 482, height: 782 }, colorScheme: "dark" });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const models = ["GPT-6.2 Sol", "GPT-6.2 Astra", "GPT-6.1 Sol", "GPT-6.1 Terra", "GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"].map(display_name => ({
    display_name, visibility: "list", slug: display_name.toLowerCase().replaceAll(" ", "-"), supported_reasoning_levels: ["low", "medium", "high"],
  }));
  models.push({ slug: "chat-latest", display_name: "Chat Latest (Instant)", visibility: "list", supported_reasoning_levels: [] });
  models.push({ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", supported_reasoning_levels: ["high"], supported_reasoning_modes: ["standard"] });
  const f = await fixture({ catalog: { models } });
  f.data.settings = { reasoningEffort: "low" };
  try {
    await connectPanel(page, f);
    await page.goto(origin + "/panel/panel.html?tab=1");
    const prompt = page.locator("#prompt"), temporary = page.locator("#temporary-button"), picker = page.locator("#model-trigger");
    await picker.filter({ hasText: "Medium" }).waitFor();
    assert.equal(await page.locator("#chat-mode").getAttribute("aria-pressed"), "true");
    const dimensions = () => page.evaluate(() => ["#work-sources", "#composer", "#prompt", ".composer-toolbar"].map(selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    }));
    for (const width of [320, 482]) {
      await page.setViewportSize({ width, height: 782 });
      for (const draft of ["", "First line\nSecond line\nThird line"]) {
        await prompt.fill(draft);
        const chatSize = await dimensions();
        await page.locator("#work-mode").click();
        assert.deepEqual(await dimensions(), chatSize, `Composer geometry with ${draft.length} characters at ${width}px`);
        await page.locator("#chat-mode").click();
      }
    }
    await prompt.fill(""); await page.locator("#work-mode").click();
    await picker.filter({ hasText: "GPT-6.2 Sol" }).waitFor();
    await page.screenshot({ path: "build/screenshots/panel-reference-work.png" });
    await picker.click(); await page.locator("#effort").press("End");
    await page.screenshot({ path: "build/screenshots/panel-reference-effort.png" });
    await page.locator("#select-model").click();
    await page.screenshot({ path: "build/screenshots/panel-reference-models.png" });
    await page.keyboard.press("Escape");
    await page.locator("#chat-mode").click();
    await page.locator("#work-sources").waitFor();
    assert.match(await picker.innerText(), /Medium/);
    assert.equal(await page.locator("#action-budget").isVisible(), true);
    assert.equal(await page.locator("#actions-guidance").isVisible(), true);
    await page.screenshot({ path: "build/screenshots/panel-reference-chat.png" });
    await picker.click(); await page.locator("#select-model").click();
    assert.deepEqual(await page.locator("#model-list button").allInnerTexts(), ["GPT-6", "GPT-5.6 Sol"]);
    await page.locator("#back-to-effort").click();
    await page.locator("#effort").press("End");
    assert.equal(await page.locator("#effort").getAttribute("aria-valuetext"), "Pro");
    await page.keyboard.press("Escape");
    await prompt.fill("Remember the ordinary draft.");
    await temporary.click();
    await page.getByRole("heading", { name: "Temporary chat" }).waitFor();
    assert.equal(await prompt.inputValue(), "");
    await prompt.fill("A temporary question"); await prompt.press("Enter");
    await page.locator("#messages .assistant").getByText("Hello").waitFor();
    assert.equal(f.requests[0].tools[0].name, "safari");
    assert.equal(f.requests[0].model, "gpt-6-astra");
    assert.deepEqual(f.requests[0].reasoning, { mode: "pro" });
    await page.reload();
    await page.locator("#messages .user").getByText("A temporary question").waitFor();
    await page.locator("#history-button").click();
    await page.locator("#history-list").getByText("Remember the ordinary draft.").waitFor();
    assert.doesNotMatch(await page.locator("#history-list").innerText(), /temporary question/);
    await page.screenshot({ path: "build/screenshots/panel-reference-drawer.png" });
    await page.keyboard.press("Escape");
    await temporary.click();
    await page.waitForFunction(() => document.querySelector("#prompt").value === "Remember the ordinary draft.");
    await page.locator("#work-mode").click();
    await picker.filter({ hasText: "High" }).waitFor();
    assert.equal(await page.locator("#work-sources").isVisible(), true);
    assert.doesNotMatch(JSON.stringify(f.data), /A temporary question/);
    await page.reload(); await picker.filter({ hasText: "GPT-6.2 Sol" }).waitFor();
    assert.equal(await page.locator("#work-mode").getAttribute("aria-pressed"), "true");
    await page.locator("#chat-mode").click(); await picker.click(); await page.locator("#select-model").click();
    await page.locator("#model-list").getByRole("button", { name: "GPT-5.6 Sol" }).click();
    await page.getByText("Instant is unavailable for this model on this connection.").waitFor();
    assert.deepEqual(await page.locator("#chat-levels button").allTextContents(), ["High"]);
    await page.locator("#select-model").click(); await page.getByRole("button", { name: "GPT-6", exact: true }).click();
    await page.locator("#chat-levels").getByRole("button", { name: "Instant" }).click();
    await picker.filter({ hasText: "Instant" }).waitFor();
    await prompt.fill("An Instant question"); await prompt.press("Enter");
    await page.locator("#messages .assistant").getByText("Hello").waitFor();
    assert.equal(f.requests.at(-1).model, "chat-latest");
    assert.equal(f.requests.at(-1).reasoning, undefined);
    assert.deepEqual(errors, []);
    console.log("Chat and Work preferences, the sidebar, and temporary-chat recovery and isolation passed.");
  } finally { await page.close(); }
}

export async function testActionAllowance(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 440, height: 720 } });
  const gate = Promise.withResolvers();
  try {
    const operations = Array.from({ length: 100 }, () => ({ operation: "list_tabs" }));
    const f = await fixture({ toolRequest: operations, catalog: { data: [{ id: "gpt-6-sol" }] } });
    f.data["website-access:account-a"] = { mode: "auto", allowed: [], blocked: [] };
    let lists = 0;
    f.api.tabs.query = async () => { if (++lists === 99) await gate.promise; return []; };
    await connectPanel(page, f);
    await page.goto(origin + "/panel/panel.html?tab=1");
    const prompt = page.locator("#prompt"), meter = page.locator("#actions-left");
    await meter.filter({ hasText: /^100\/100 browser actions left$/ }).waitFor();
    await prompt.fill("Check my open tabs until the browser action allowance is used."); await prompt.press("Enter");
    await meter.filter({ hasText: "1/100 browser actions left · 99 used" }).waitFor();
    await page.locator("#history-button").click();
    await page.locator("#settings-button").click();
    await page.getByText("Context and usage", { exact: true }).click();
    const time = page.getByLabel("Time limit per message (minutes)");
    assert.equal(await time.inputValue(), "10");
    await time.fill("0"); await time.press("Tab");
    assert.equal(await time.evaluate(field => field.validity.rangeUnderflow), true);
    await time.fill("12"); await time.press("Tab");
    await page.waitForFunction(() => document.querySelector("#settings-status").textContent === "Setting saved.");
    assert.equal(f.data.settings.turnMinutes, 12);
    const setting = page.locator("#actions-setting");
    assert.equal(await setting.inputValue(), "100");
    await setting.fill("7"); await setting.press("Tab");
    await page.getByText("Setting saved.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Close settings" }).click();
    assert.match(await meter.innerText(), /^1\/100 /);
    await prompt.fill("Keep this private follow-up draft.");
    await page.locator("#file-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("unsent evidence") });
    await page.locator("#attachments").getByText("draft.txt").waitFor();
    gate.resolve();
    const more = page.getByRole("button", { name: "Continue", exact: true });
    await more.waitFor();
    assert.equal(await meter.textContent(), "7/7 browser actions left");
    assert.equal(await page.locator("#action-limit-note").innerText(), "This reply used all 100 browser actions.");
    assert.equal(lists, 100); assert.equal(f.requests.length, 101); assert.equal(f.requests.at(-1).tools, undefined);
    await page.reload();
    await more.waitFor();
    assert.equal(await meter.textContent(), "7/7 browser actions left");
    assert.equal(await prompt.inputValue(), "Keep this private follow-up draft.");
    await page.screenshot({ path: "build/screenshots/panel-action-limit.png" });
    await page.setViewportSize({ width: 320, height: 640 });
    await more.scrollIntoViewIfNeeded();
    const button = await more.boundingBox();
    assert.ok(button.x >= 0 && button.x + button.width <= 320 && button.y + button.height <= 640);
    await more.click();
    await meter.filter({ hasText: "7/7 browser actions left" }).waitFor();
    await page.waitForFunction(() => document.getElementById("stop-button").hidden && document.querySelectorAll("#messages .assistant").length === 2);
    assert.equal(f.requests.length, 102); assert.equal(lists, 100);
    assert.ok(f.requests.at(-1).tools); assert.equal(f.requests.at(-1).input.at(-1).content, "Please continue.");
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /unsent evidence|private follow-up draft/);
    assert.equal(await prompt.inputValue(), "Keep this private follow-up draft.");
    await page.locator("#attachments").getByText("draft.txt").waitFor();
    assert.equal(await more.isVisible(), false);
    console.log("Action allowance passed 100 dispatches, draft recovery, a changed next-message limit and one explicit continuation.");
  } finally { gate.resolve(); await page.close(); }
}

// The source and panel run at distinct origins. Each real navigation destroys
// the iframe and its port. Only the extension transport, account and SSE server are fixtures.
export async function testDockWorkflow(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const finish = Promise.withResolvers();
  try {
    const source = await context.newPage();
    const errors = [];
    source.on("pageerror", err => errors.push(err.message));
    const panelOrigin = origin.replace("127.0.0.1", "localhost");
    const panelURL = panelOrigin + "/panel/panel.html";
    const script = await readFile("extension/content/mount.js", "utf8");
    const actions = [{ operation: "navigate", url: origin + "/__workflow/two" }, { operation: "read" },
      { operation: "click" }, { operation: "read" }, { operation: "scroll", direction: "down" }];
    const f = await fixture({ toolRequest: actions, responseForRequest: number => {
      if (number !== 6) return;
      return new Response(new ReadableStream({ start(controller) {
        const send = data => controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(data) + "\n\n"));
        send({ type: "response.output_text.delta", delta: "First part" });
        finish.promise.then(() => {
          send({ type: "response.output_text.delta", delta: ", completed." });
          send({ type: "response.completed", response: { output: [], usage: { input_tokens: 13, output_tokens: 4 } } });
          controller.close();
        });
      } }));
    } });
    f.data.settings = { interactionMode: "work" };
    let loading = false, reads = 0, clicks = 0, visits = 0;
    const sourceTab = () => ({ id: 1, windowId: 4, index: 0, active: true, url: source.url(), status: loading ? "loading" : "complete" });
    const frameIds = new Map(), ports = new Map();
    let lastFrameId = 0;
    const sender = frame => {
      const main = frame === source.mainFrame();
      if (!main && !frameIds.has(frame)) frameIds.set(frame, ++lastFrameId);
      return { id: f.sender.id, tab: sourceTab(), frameId: main ? 0 : frameIds.get(frame),
        url: main ? source.url() : frame.url().replace(panelOrigin + "/", f.api.runtime.getURL("")) };
    };
    await context.exposeBinding("extensionRequest", ({ frame }, message) => f.events.message(message, sender(frame)));
    await context.exposeBinding("extensionPost", ({ frame }, { id, message }) => {
      if (!ports.has(id)) {
        const receive = chatPort(f, event => {
          frame.evaluate(({ id, event }) => window.receivePort(id, event), { id, event }).catch(() => {});
        }, sender(frame));
        ports.set(id, { receive, frame });
      }
      // Runtime.Port.postMessage returns immediately, including for the original run.
      const port = ports.get(id);
      if (port.frame === frame) port.receive(message).catch(error => errors.push(error.message));
    });
    const drop = (frame, id) => {
      const port = ports.get(id);
      if (port?.frame === frame) { port.receive.disconnect(); ports.delete(id); }
    };
    await context.exposeBinding("extensionDisconnect", ({ frame }, id) => drop(frame, id));
    source.on("framedetached", frame => { for (const id of ports.keys()) drop(frame, id); frameIds.delete(frame); });
    await context.addInitScript(({ panelOrigin }) => {
      const listeners = new Map();
      window.receivePort = (id, event) => listeners.get(id)?.(event);
      window.browser = { storage: { onChanged: { addListener() {} } }, runtime: {
        id: "test-extension", getURL: path => panelOrigin + "/" + path, sendMessage: window.extensionRequest,
        onMessage: { addListener: fn => { window.receiveMessage = fn; } },
        connect() {
          const id = crypto.randomUUID();
          return { onMessage: { addListener: fn => listeners.set(id, fn) }, onDisconnect: { addListener() {} },
            postMessage: message => window.extensionPost({ id, message }), disconnect() { listeners.delete(id); window.extensionDisconnect(id); } };
        },
      } };
    }, { panelOrigin });
    source.on("request", request => {
      if (request.isNavigationRequest() && request.frame() === source.mainFrame()) {
        loading = true; f.events.updated(1, { status: "loading" }, sourceTab());
      }
    });
    source.on("framenavigated", frame => { if (frame === source.mainFrame()) f.events.updated(1, { url: frame.url() }, sourceTab()); });
    source.on("load", () => { loading = false; f.events.updated(1, { status: "complete" }, sourceTab()); });
    f.api.tabs.get = async id => { assert.equal(id, 1); return sourceTab(); };
    f.api.tabs.update = async (id, options) => {
      assert.equal(id, 1);
      if (options.url) { visits++; await source.goto(options.url); }
      return sourceTab();
    };
    f.api.tabs.sendMessage = (id, message) => {
      assert.equal(id, 1);
      if (message.url) message = { ...message, url: message.url.replace(f.api.runtime.getURL(""), panelOrigin + "/") };
      return source.evaluate(message => window.receiveMessage(message, { id: browser.runtime.id }), message);
    };
    f.api.scripting = { executeScript: async ({ target, files, func, args }) => {
      assert.equal(target.tabId, 1);
      if (files) { assert.deepEqual(Array.from(files), ["content/mount.js"]); await source.evaluate(script); return []; }
      if (func.name === "actOnPage" && args[0] === "click" && !args[4]?.preview) {
        clicks++;
        assert.equal(await source.evaluate(() => {
          const pointer = window.__safariChatActionPointer, link = document.querySelector("main a");
          const box = pointer?.position.getBoundingClientRect(), dock = document.getElementById("safari-chat-host").getBoundingClientRect();
          return !!box && pointer.host.getBoundingClientRect().right <= dock.left + 1 && link.contains(document.elementFromPoint(box.left + 3, box.top + 3));
        }), true, "the pointer lands on the link in the page column before it navigates");
      }
      const result = await source.evaluate(({ code, args }) => eval(`(${code})`)(...args), { code: func.toString(), args });
      if (func.name === "snapshotPage") {
        reads++; if (reads === 1) actions[2].elementId = result.elements.find(item => item.label === "Continue").id;
      }
      return [{ result }];
    } };
    const panel = previous => source.frames().find(frame => frame !== previous && frame.url().startsWith(panelURL)) ??
      source.waitForEvent("framenavigated", { predicate: frame => frame !== previous && frame.url().startsWith(panelURL), timeout: 10000 });
    const prompt = frame => frame.getByRole("textbox", { name: "Message Safari Chat" });
    await source.goto(origin + "/__workflow/one"); await f.events.action(sourceTab());
    const first = await panel();
    await first.waitForFunction(() => document.getElementById("model-name")?.textContent === "Model A");
    assert.ok(await source.evaluate(() => {
      const edge = document.getElementById("safari-chat-host").getBoundingClientRect().left;
      return innerWidth === 1440 && edge === 1000 && ["main", "header", "button"].every(s => document.querySelector(s).getBoundingClientRect().right <= edge + 1);
    }));
    await prompt(first).fill("Go to step two, follow Continue, and scroll the final page."); await prompt(first).press("Enter");
    await first.locator("#approval").getByText("Navigate this tab?").waitFor();
    await prompt(first).fill("Keep this follow-up draft.");
    await source.reload();
    const second = await panel();
    assert.ok(first.isDetached()); assert.notEqual(first, second);
    await second.locator("#approval").getByText("Navigate this tab?").waitFor();
    assert.match(await second.locator("#actions-left").textContent(), /^99\/100 /);
    assert.equal(await prompt(second).inputValue(), "Keep this follow-up draft.");
    assert.equal(f.requests.length, 1); assert.equal(reads, 0);
    await second.getByRole("button", { name: "More approval options" }).click();
    await second.getByRole("button", { name: /Allow for this site/ }).click();
    await source.waitForURL("**/__workflow/three");
    const third = await panel();
    await third.locator("#messages .assistant").getByText("First part", { exact: true }).waitFor();
    assert.ok(await source.evaluate(() => scrollY > 0)); assert.equal(f.requests.length, 6);
    await source.reload();
    const fourth = await panel(); assert.ok(third.isDetached());
    await fourth.locator("#messages .assistant").getByText("First part", { exact: true }).waitFor();
    assert.equal(await fourth.locator("#stop-button").isVisible(), true);
    assert.equal(await prompt(fourth).inputValue(), "Keep this follow-up draft.");
    assert.equal(f.requests.length, 6); assert.equal(reads, 2); assert.equal(clicks, 1); assert.equal(visits, 1);
    finish.resolve();
    await fourth.locator("#messages .assistant").getByText("First part, completed.", { exact: true }).waitFor();
    await fourth.locator("#stop-button").waitFor({ state: "hidden" });
    const outputs = f.requests.at(-1).input.filter(item => item.type === "function_call_output").map(item => JSON.parse(item.output));
    assert.deepEqual(outputs.filter(output => output.error), []);
    assert.equal(outputs[1].title, "Step Two"); assert.equal(outputs[3].title, "Step Three");
    await source.goBack();
    const back = await panel();
    await back.locator("#messages .assistant").getByText("First part, completed.", { exact: true }).waitFor();
    assert.match(await back.locator("#actions-left").textContent(), /^100\/100 /);
    assert.equal(await prompt(back).inputValue(), "Keep this follow-up draft.");
    const chats = Object.keys(f.data).filter(key => key.startsWith("chat:"));
    assert.equal(chats.length, 1); assert.equal(f.data[chats[0]].messages.length, 2);
    // Some single-page apps replace the entire root. Reopen the dock there, too.
    await source.evaluate(() => document.getElementById("safari-chat-host").remove());
    const replacement = await panel(back);
    await replacement.locator("#messages .assistant").getByText("First part, completed.", { exact: true }).waitFor();
    assert.equal(await prompt(replacement).inputValue(), "Keep this follow-up draft.");
    await replacement.getByRole("button", { name: "Close panel", exact: true }).click();
    await source.locator("#safari-chat-host").waitFor({ state: "detached" });
    await source.reload(); await f.events.updated(1, { status: "complete" }, sourceTab());
    assert.equal(await source.locator("#safari-chat-host").count(), 0);
    assert.deepEqual(f.createdTabs, []); assert.deepEqual(f.createdWindows, []); assert.deepEqual(errors, []);
    const control = source.getByRole("button", { name: "Account", exact: true });
    await source.evaluate(() => {
      const button = document.createElement("button");
      button.style.cssText = "display:block;position:static;margin-left:1150px;width:100px;height:40px";
      button.textContent = "Account";
      button.addEventListener("click", () => { window.accountClicks = (window.accountClicks ?? 0) + 1; });
      document.querySelector("main").append(button);
    });
    await control.scrollIntoViewIfNeeded();
    const before = await control.boundingBox();
    assert.ok(before.x > 1000 && before.x + before.width < 1440);
    await f.events.action(sourceTab());
    const rigidPanel = await panel();
    await rigidPanel.locator("#messages .assistant").getByText("First part, completed.", { exact: true }).waitFor();
    assert.ok(await source.locator("main").evaluate(main => main.scrollWidth > main.clientWidth && getComputedStyle(main).overflowX === "auto"));
    await control.scrollIntoViewIfNeeded();
    await control.click();
    assert.equal(await source.evaluate(() => window.accountClicks), 1);
    const edge = (await source.locator("#safari-chat-host").boundingBox()).x, visible = await control.boundingBox();
    assert.ok(visible.x >= 0 && visible.x + visible.width <= edge + 1);
    await source.evaluate(() => {
      const extra = document.createElement("button");
      extra.id = "fixed-update"; extra.style.cssText = "position:fixed;right:18px;top:40px";
      extra.textContent = "Help"; document.body.append(extra);
    });
    await source.waitForFunction(() => document.getElementById("fixed-update").getBoundingClientRect().right <= document.getElementById("safari-chat-host").getBoundingClientRect().left);
    assert.ok(await source.locator("main").evaluate(main => main.scrollLeft > 0));
    await rigidPanel.getByRole("button", { name: "Close panel", exact: true }).click();
    await source.locator("#safari-chat-host").waitFor({ state: "detached" });
    assert.equal((await control.boundingBox()).x, before.x);
    await source.locator("main").evaluate(main => { main.style.overflowX = "clip"; });
    await f.events.action(sourceTab());
    const clippedPanel = await panel();
    await control.click();
    assert.equal(await source.evaluate(() => window.accountClicks), 2);
    await clippedPanel.getByRole("button", { name: "Close panel", exact: true }).click();
    await source.locator("#safari-chat-host").waitFor({ state: "detached" });
    assert.equal(await source.locator("main").evaluate(main => main.style.overflowX), "clip");
    assert.equal(context.pages().length, 1);
    assert.deepEqual(f.createdTabs, []); assert.deepEqual(f.createdWindows, []); assert.deepEqual(errors, []);
    console.log("Integrated dock passed two reloads, approval and draft recovery, streamed output, navigation and interaction with a rigid website in the same tab.");
  } finally { finish.resolve(); await context.close(); }
}

export async function testVoiceComposer(browser, origin) {
  const page = await browser.newPage({viewport:{width:320,height:640}});
  const f = await fixture({ catalog: { data: [{ id: "gpt-6-sol" }] } });
  try {
    await connectPanel(page, f);
    await page.addInitScript(() => {
      window.spoken = [];
      window.SpeechRecognition = class {
        start() { window.mic = this; this.onstart(); }
        stop() { this.onend(); }
        abort() { window.aborted = true; }
      };
      Object.defineProperty(window, "speechSynthesis", { configurable:true, value:{
        speak(line) { window.spoken.push(line.text); window.line = line; }, cancel() { window.cancelledVoice = true; }
      } });
      window.recognize = (word,final) => mic.onresult({results:[Object.assign([{transcript:word}],{isFinal:final})]});
    });
    await page.goto(origin+"/panel/panel.html?tab=1");
    const prompt = page.locator("#prompt");
    await prompt.fill("old words here");
    await prompt.evaluate(el=>el.setSelectionRange(4,9));
    await page.keyboard.press("Control+Shift+D");
    await page.getByRole("button",{name:"Finish dictation"}).waitFor();
    await page.evaluate(()=>recognize("new",false));
    assert.equal(await prompt.inputValue(),"old words here");
    await page.evaluate(()=>recognize("new",true));
    assert.equal(await prompt.inputValue(),"old new here");
    await page.getByRole("button",{name:"Finish dictation"}).click();
    assert.equal(f.requests.length,0);
    await prompt.fill("");
    await page.locator("#voice-button").click();
    await page.evaluate(()=>line.onend());
    await page.evaluate(()=>{ recognize("A spoken question",true); mic.onend(); });
    await page.waitForFunction(()=>spoken.includes("Hello"));
    assert.equal(f.requests.length,1);
    await page.evaluate(()=>line.onend());
    await page.locator("#voice-status").filter({hasText:"Listening"}).waitFor();
    await page.getByRole("button",{name:"End Voice"}).click();
    await page.evaluate(()=>{ recognize("Late callback",true); mic.onend(); });
    assert.equal(f.requests.length,1);
    await page.locator("#dictate-button").click();
    await page.evaluate(()=>mic.onerror({error:"not-allowed"}));
    await page.locator("#notice").filter({hasText:"microphone"}).waitFor();
    assert.equal(await page.locator("#voice-status").isVisible(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    console.log("Dictation, voice submit/play/listen, rejection and explicit stop passed with deterministic audio fixtures.");
  } finally { await page.close(); }
}
