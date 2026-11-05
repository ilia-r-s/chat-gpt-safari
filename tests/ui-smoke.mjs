/** Optional browser checks. Uses an existing Playwright module and isolated Chrome profile. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotPage, actOnPage } from "../extension/content/page.js";

const modulePath = process.env.SAFARI_CHAT_PLAYWRIGHT;
if (!modulePath) throw new Error("Set SAFARI_CHAT_PLAYWRIGHT to an existing playwright/index.mjs. No dependencies are installed automatically.");
const { chromium } = await import(pathToFileURL(modulePath).href);
const root = path.resolve("extension");
const server = createServer(async (request, response) => {
  const filename = path.resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
  if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png" })[path.extname(filename)] ?? "text/plain");
    response.end(await readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SAFARI_CHAT_CHROME ? { executablePath: process.env.SAFARI_CHAT_CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 }, colorScheme: "light" });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const data = {}; let count = 0;
    const prefs = { theme: "system", model: "test-model", pageChars: 12000, inputChars: 48000, historyTurns: 8, maxToolRounds: 6, browserTools: false };
    globalThis.__runs = [];
    globalThis.browser = { runtime: {
      id: "ui-test", onMessage: { addListener: listener => { globalThis.__runtimeMessage = listener; } },
      sendMessage: async message => {
        let value;
        if (message.type === "bootstrap") value = globalThis.__companionError
          ? { prefs, auth: { connected: false, error: globalThis.__companionError }, models: [] }
          : { prefs, auth: { connected: true, canInfer: true, account: "test-account", label: "Test account" }, models: [{ id: "test-model", name: "Test model" }] };
        if (message.type === "auth.open") {
          if (globalThis.__companionError) return { ok: false, error: globalThis.__companionError };
          globalThis.__companionOpened = true; value = { ok: true };
        }
        if (message.type === "context.read") value = { kind: "page", key: "page:test", title: "A useful page", url: "https://example.com/", text: "A short reference.", tabId: 1 };
        if (message.type === "chat.save") { data[message.chat.id] = structuredClone(message.chat); value = message.chat; }
        if (message.type === "chat.load") value = data[message.id];
        if (message.type === "chats.list") value = Object.values(data).map(chat => ({ id: chat.id, title: chat.title, updated: Date.now() }));
        if (message.type === "settings.save") { Object.assign(prefs, message.settings); value = prefs; }
        if (message.type === "panel.popout") { globalThis.__popout = message; value = { ok: true }; }
        if (message.type === "data.erase") { for (const key of Object.keys(data)) delete data[key]; globalThis.__erased = true; value = { browserCleared: true, nativeCleared: true, failures: [] }; }
        return { ok: true, value };
      },
      connect: () => {
        let onMessage = () => {}; let onDisconnect = () => {}; let timer;
        return {
          onMessage: { addListener: callback => { onMessage = callback; } }, onDisconnect: { addListener: callback => { onDisconnect = callback; } },
          postMessage: message => {
            if (message.type === "cancel") { clearTimeout(timer); onMessage({ type: "cancelled" }); return; }
            if (message.type !== "run") return;
            globalThis.__runs.push(message); count++;
            onMessage({ type: "delta", text: `Response ${count}: **Hello** <img src=x onerror=alert(1)>` });
            timer = setTimeout(() => { onMessage({ type: "usage", usage: { input: 100, cached: 25, output: 20, requests: 1 } }); onMessage({ type: "done" }); }, 100);
          }, disconnect: () => { clearTimeout(timer); setTimeout(onDisconnect, 0); },
        };
      },
    } };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/panel/panel.html?tab=1`);
  await page.getByText("Test account", { exact: true }).waitFor();
  await mkdir("build/screenshots", { recursive: true });
  await page.screenshot({ path: "build/screenshots/panel-light.png" });
  const panelURL = page.url();
  await page.evaluate(() => {
    globalThis.__companionError = "The Safari Chat companion app is unavailable. A temporary extension can preview the interface, but connecting an account requires the packaged Safari Chat app and its extension.";
    window.dispatchEvent(new Event("focus"));
  });
  await page.locator("#connect-card").waitFor({ state: "visible" });
  for (const id of ["account-button", "connect-button", "api-key-button"]) {
    await page.locator(`#${id}`).click();
    await page.locator("#companion-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#companion-error").textContent(), /companion app is unavailable/);
    assert.equal(page.url(), panelURL); assert.equal(page.context().pages().length, 1);
    await page.getByRole("button", { name: "Close app setup", exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator("#account-button").click();
  await page.locator("#companion-dialog").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: "build/screenshots/panel-companion-setup.png" });
  await page.evaluate(() => { delete globalThis.__companionError; });
  await page.getByRole("button", { name: "Try opening app again" }).click();
  await page.locator("#companion-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => globalThis.__companionOpened), true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("Test account", { exact: true }).waitFor();
  await page.setViewportSize({ width: 440, height: 900 });
  await page.getByRole("button", { name: "Add current page" }).click();
  await page.getByRole("textbox", { name: "Message Safari Chat" }).fill("Summarize this page.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#messages .assistant").count(), 1);
  assert.equal(await page.locator("#messages img").count(), 0);
  await page.getByRole("textbox", { name: "Message Safari Chat" }).fill("And the next point?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#messages .assistant").count(), 2);
  assert.ok((await page.locator("#messages").textContent()).includes("Response 2"));
  assert.equal(await page.locator(".message-error").count(), 0, "disconnecting the old port must not interrupt the new run");
  assert.equal((await page.evaluate(() => globalThis.__runs))[0].messages[0].contexts.length, 1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "Save settings" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: "build/screenshots/panel-dark-chat.png" });
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("button", { name: /^Summarize this page/ }).waitFor();
  await page.getByRole("button", { name: "Close recent chats" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open chat in a tab" }).click();
  assert.equal((await page.evaluate(() => globalThis.__popout)).tabId, 1);
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "small panel must not overflow horizontally");
  await page.screenshot({ path: "build/screenshots/panel-small.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Erase local data" }).click();
  assert.equal(await page.evaluate(() => globalThis.__erased), undefined, "cancelling cleanup must preserve stored data");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Erase local data" }).click();
  await page.locator("#cleanup-result").filter({ hasText: "were cleared" }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.__erased), true);
  assert.equal(await page.locator("#messages .message").count(), 0);
  assert.equal(await page.locator("#attachments").textContent(), "");
  assert.equal(await page.locator("#prompt").isDisabled(), true);
  await page.screenshot({ path: "build/screenshots/panel-cleanup.png" });
  const dom = await browser.newPage();
  await dom.setContent('<main><h1>Readable title</h1><p>Useful text.</p><p hidden>HIDDEN SECRET</p><input type="password" value="SECRET"><input id="email" aria-label="Email"><button id="submit">Submit</button><script>evil()</script></main>');
  const snapshot = await dom.evaluate(snapshotPage, 2000);
  assert.ok(snapshot.text.includes("Useful text")); assert.ok(!snapshot.text.includes("SECRET")); assert.ok(!snapshot.text.includes("evil"));
  const field = snapshot.elements.find(element => element.label === "Email");
  await dom.evaluate(({ fn, id }) => eval(`(${fn})`)("fill", id, "a@example.com", location.href), { fn: actOnPage.toString(), id: field.id });
  assert.equal(await dom.locator("#email").inputValue(), "a@example.com");
  await assert.rejects(dom.evaluate(({ fn, id }) => eval(`(${fn})`)("fill", id, "other", location.href), { fn: actOnPage.toString(), id: field.id }), /Read it again/);
  assert.deepEqual(errors, []);
  console.log("UI smoke passed: companion setup and launch retry, streaming, escaped output, attachments, settings, history, narrow layout, cleanup confirmation and memory clearing, DOM extraction, stale actions.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
