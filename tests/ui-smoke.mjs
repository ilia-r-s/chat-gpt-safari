/** Optional browser checks. Uses an existing Playwright module and isolated Chrome profile. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotPage, actOnPage } from "../extension/content/page.js";
import { testPageInteractions } from "./page-interactions.mjs";
import { testGalleryInteractions } from "./gallery-interactions.mjs";
import { testSideChatIntegration, testDockWorkflow } from "./side-chat-integration.mjs";
import { testBrowserAgent } from "./browser-agent.mjs";
import { testWebKitDock } from "./webkit-dock.mjs";
import { testPanelMount } from "./panel-mount.mjs";
import { testComposerFeatures } from "./composer-features.mjs";

const modulePath = process.env.SAFARI_CHAT_PLAYWRIGHT;
if (!modulePath) throw new Error("Set SAFARI_CHAT_PLAYWRIGHT to an existing playwright/index.mjs. No dependencies are installed automatically.");
const { chromium } = await import(pathToFileURL(modulePath).href);
const root = path.resolve("extension");
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/__workflow/")) {
    const step = request.url.endsWith("/three") ? "Three" : request.url.endsWith("/two") ? "Two" : "One";
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Step ${step}</title><style>*{box-sizing:border-box}body{margin:0}main{width:100vw;height:230vh;padding:75px 24px}header{position:fixed;inset:0 0 auto;width:100vw}button{position:fixed;right:16px;bottom:16px}@media(max-width:1050px){main{display:grid;align-content:start;gap:16px}}</style><header>Workflow</header><main>Workflow step ${step}<a href="/__workflow/three">Continue</a></main><button>Page help</button>`); return;
  }
  const filename = path.resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
  if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" })[path.extname(filename)] ?? "text/plain");
    response.end(await readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SAFARI_CHAT_CHROME ? { executablePath: process.env.SAFARI_CHAT_CHROME } : {}) });
  const context = await browser.newContext({ viewport: { width: 440, height: 900 }, colorScheme: "light" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.context().addInitScript(() => {
    const state = JSON.parse(sessionStorage.getItem("fixture") || "null") ?? { data: {}, drafts: {}, sessions: {}, prefs: { theme: "system", model: "test-model", pageChars: 12000, inputChars: 48000, historyTurns: 8, maxToolRounds: 6, browserTools: false } };
    const { data, drafts, sessions, prefs } = state;
    const persist = () => sessionStorage.setItem("fixture", JSON.stringify(state));
    let count = 0;
    globalThis.__data = data; globalThis.__drafts = drafts;
    globalThis.__runs = [];
    globalThis.__reads = [];
    globalThis.browser = { storage: { onChanged: { addListener: listener => { globalThis.__storageChange = listener; } } }, runtime: {
      id: "ui-test", onMessage: { addListener: listener => { globalThis.__runtimeMessage = listener; } },
      sendMessage: async message => {
        const account = globalThis.__account ?? "test-account";
        let value;
        if (message.type === "auth.check") value = { generation: account };
        if (message.type === "bootstrap") value = globalThis.__companionError
          ? { prefs, auth: { connected: false, error: globalThis.__companionError }, models: [] }
          : { prefs, auth: { connected: true, canInfer: true, account, generation: account, label: account === "test-account" ? "Test account" : "Other account" }, models: [{ id: "test-model", name: "Test model", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "basic-model", name: "Basic model", reasoningEfforts: [] }], activeChat: sessions[account], access: state.access?.[account] };
        if (["auth.open", "auth.signin", "auth.apikey"].includes(message.type)) {
          if (globalThis.__companionError) return { ok: false, error: globalThis.__companionError };
          globalThis.__companionOpened = true; globalThis.__companionRoute = message.type; globalThis.__signInStarted = message.type === "auth.signin"; value = { ok: true };
        }
        if (message.type === "tabs.list") value = [{ id: 1, title: "A useful page", url: "https://example.com/" }, { id: 2, title: "Guide", url: "https://example.com/guide" }, { id: 3, title: "Notes", url: "https://example.com/notes" }];
        if (message.type === "context.read") {
          globalThis.__reads.push(message.tabId);
          if (globalThis.__contextErrorId === message.tabId) return { ok: false, error: "Safari website access was denied" };
          if (globalThis.__contextGate === message.tabId) await new Promise(resolve => { globalThis.__releaseContext = resolve; });
          value = { kind: "page", key: `page:${message.tabId}`, title: ({ 1: "A useful page", 2: "Guide", 3: "Notes" })[message.tabId], url: `https://example.com/${message.tabId}`, text: message.tabId === 2 ? "Prototype review: Thursday at 11 am. Final handoff: Friday at 3 pm." : "A short reference.", tabId: message.tabId };
        }
        if (message.type === "chat.save") {
          if (globalThis.__saveError) return { ok: false, error: "Storage unavailable" };
          value = { ...structuredClone(message.chat), revision: (data[message.chat.id]?.revision ?? 0) + 1 }; data[value.id] = value;
        }
        if (message.type === "chat.load") value = data[message.id]?.account === account ? data[message.id] : undefined;
        if (message.type === "draft.load") value = drafts[message.id]?.account === account ? drafts[message.id] : undefined;
        if (message.type === "draft.save") {
          if (globalThis.__saveError) return { ok: false, error: "Storage unavailable" };
          if (message.draft.account !== account) return { ok: false, error: "Your account changed" };
          value = structuredClone(message.draft);
          if (globalThis.__forkNextDraft && value.text) {
            globalThis.__forkNextDraft = false;
            const base = data[value.id]; value.id = crypto.randomUUID();
            value.title = base.title + " (draft copy)"; value.chatRevision = 1;
            data[value.id] = { ...structuredClone(base), id: value.id, title: value.title, revision: 1 };
          }
          sessions[account] = value.id;
          if (value.text || value.contexts.length) drafts[value.id] = value; else delete drafts[value.id];
        }
        if (message.type === "chats.list") {
          const items = new Map(Object.values(data).filter(chat => chat.account === account).map(chat => [chat.id, { id: chat.id, title: chat.title, updated: Date.now() }]));
          for (const draft of Object.values(drafts).filter(draft => draft.account === account)) items.set(draft.id, { id: draft.id, title: data[draft.id]?.title ?? draft.text, updated: Date.now(), draft: true });
          value = [...items.values()];
        }
        if (message.type === "chat.delete") { delete data[message.id]; delete drafts[message.id]; if (sessions[account] === message.id) delete sessions[account]; }
        if (message.type === "settings.save") {
          if (globalThis.__settingsDelay) await new Promise(resolve => setTimeout(resolve, globalThis.__settingsDelay));
          if (globalThis.__settingsError) return { ok: false, error: "Settings storage unavailable" };
          const oldValue = { ...prefs };
          Object.assign(prefs, message.settings); value = { ...prefs };
          globalThis.__storageChange?.({ settings: { oldValue, newValue: { ...prefs } } }, "local");
        }
        if (message.type === "panel.source") { globalThis.__returned = (globalThis.__returned ?? 0) + 1; value = { ok: true }; }
        if (message.type === "data.erase") { for (const store of [data, drafts, sessions]) for (const key of Object.keys(store)) delete store[key]; globalThis.__erased = true; value = { browserCleared: true, nativeCleared: true, failures: [] }; }
        value = structuredClone(value);
        if (message.type === "bootstrap" && globalThis.__holdBootstrap) {
          globalThis.__holdBootstrap = false;
          await new Promise(resolve => { globalThis.__releaseBootstrap = resolve; });
        }
        persist();
        return { ok: true, value };
      },
      connect: () => {
        let onMessage = () => {}; let onDisconnect = () => {}; let timer, run, answer = "";
        const finish = (type, message) => {
          const saved = data[run.chatId];
          saved.messages = [...run.messages, { role: "assistant", text: answer || "No response received.", ...(type === "done" ? {} : { error: true }) }];
          saved.revision++; persist();
          onMessage({ type, message, saved: { id: saved.id, revision: saved.revision, title: saved.title }, workMs: globalThis.__browserActivity ? 2000 : undefined });
        };
        return {
          onMessage: { addListener: callback => { onMessage = callback; } }, onDisconnect: { addListener: callback => { onDisconnect = callback; } },
          postMessage: message => {
            if (message.type === "cancel") { clearTimeout(timer); if (run) finish("cancelled", "Response stopped."); return; }
            if (message.type !== "run") return;
            run = message; globalThis.__runs.push(message); count++;
            if (globalThis.__browserActivity) onMessage({ type: "activity", operation: "fill", state: "working" });
            if (globalThis.__responseError) { finish("error", "Connection interrupted"); return; }
            answer = globalThis.__answer ?? `Response ${count}: **Hello** <img src=x onerror=alert(1)>`; onMessage({ type: "delta", text: answer });
            timer = setTimeout(() => {
              if (globalThis.__browserActivity) onMessage({ type: "activity", operation: "fill", state: "done", detail: "Text entered; the form was not submitted." });
              if (message.webSearch) { answer = "A sourced answer. [Reference](https://example.com/source)"; onMessage({ type: "replace", text: answer }); }
              onMessage({ type: "usage", usage: { input: 100, cached: 25, output: 20, requests: 1 } }); finish("done");
            }, globalThis.__responseDelay ?? 100);
          }, disconnect: () => { clearTimeout(timer); setTimeout(onDisconnect, 0); },
        };
      },
    } };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/panel/panel.html?tab=1`);
  await page.waitForFunction(() => document.getElementById("account-label").textContent === "Test account");
  const effort = page.getByRole("combobox", { name: "Reasoning effort" });
  assert.equal(await effort.inputValue(), "auto");
  assert.deepEqual(await effort.locator("option").evaluateAll(options => options.map(option => option.value)), ["auto", "low", "medium", "high", "xhigh", "max"]);
  await effort.selectOption("high");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("account-label").textContent === "Test account");
  assert.equal(await effort.inputValue(), "high", "effort survives reopening the panel");
  await page.locator("#model").selectOption("basic-model");
  assert.equal(await page.locator("#effort-control").isVisible(), false);
  assert.equal(await page.locator("#effort").inputValue(), "auto");
  await page.locator("#model").selectOption("test-model");
  assert.equal(await effort.inputValue(), "auto", "a model change cannot retain an unsupported effort");
  await effort.selectOption("high");
  await page.locator("#settings-button").click();
  await page.getByText("Context and usage", { exact: true }).click();
  for (const [id, key, value] of [["page-setting", "pageChars", 6000], ["budget-setting", "inputChars", 96000], ["turns-setting", "historyTurns", 16]]) {
    await page.locator("#" + id).selectOption(String(value));
    await page.waitForFunction(([key, value]) => JSON.parse(sessionStorage.getItem("fixture")).prefs[key] === value, [key, value]);
  }
  await page.getByText("Context and usage", { exact: true }).click();
  const appearance = page.getByLabel("Appearance", { exact: true });
  await page.evaluate(() => { globalThis.__settingsDelay = 150; });
  for (const theme of ["dark", "light", "system"]) {
    await appearance.selectOption(theme);
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme, "theme changes before saving completes");
  }
  await page.locator("#theme-status").filter({ hasText: "Appearance saved." }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("fixture")).prefs.theme), "system", "rapid changes save in order");
  await page.evaluate(() => { globalThis.__holdBootstrap = true; window.dispatchEvent(new Event("focus")); });
  await page.waitForFunction(() => typeof globalThis.__releaseBootstrap === "function");
  await appearance.selectOption("dark");
  await page.locator("#theme-status").filter({ hasText: "Appearance saved." }).waitFor();
  await page.evaluate(() => globalThis.__releaseBootstrap());
  await page.waitForTimeout(50);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "a stale bootstrap cannot restore the previous theme");
  await page.evaluate(() => { globalThis.__settingsError = true; });
  await appearance.selectOption("light");
  await page.locator("#theme-status").filter({ hasText: "could not be saved" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light", "a save failure keeps the immediate preview and reports it");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("account-label").textContent === "Test account");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "reopening restores the last successfully saved theme");
  await page.evaluate(() => browser.runtime.sendMessage({ type: "settings.save", settings: { theme: "light" } }));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light", "another panel's storage change applies without a focus refresh");
  await page.evaluate(() => browser.runtime.sendMessage({ type: "settings.save", settings: { theme: "system" } }));
  assert.equal(await page.locator("#actions-guidance").isVisible(), true);
  await page.evaluate(() => { delete globalThis.__browserActivity; });
  assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(27, 27, 27)", "system theme follows dark appearance");
  await page.emulateMedia({ colorScheme: "light" });
  await mkdir("build/screenshots", { recursive: true });
  await page.screenshot({ path: "build/screenshots/panel-light.png" });
  const panelURL = page.url();
  await page.evaluate(() => {
    globalThis.__companionError = "The Safari Chat companion app is unavailable. A temporary extension can preview the interface, but connecting an account requires the packaged Safari Chat app and its extension.";
    window.dispatchEvent(new Event("focus"));
  });
  await page.locator("#connect-card").waitFor({ state: "visible" });
  for (const id of ["account-button", "connect-button", "api-key-button"]) {
    if (id === "account-button") await page.locator("#settings-button").click();
    await page.locator(`#${id}`).click();
    await page.locator("#companion-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#companion-error").textContent(), /companion app is unavailable/);
    assert.equal(page.url(), panelURL); assert.equal(page.context().pages().length, 1);
    await page.getByRole("button", { name: "Close app setup", exact: true }).click();
    if (id === "account-button") await page.getByRole("button", { name: "Close settings" }).click();
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator("#connect-button").click();
  await page.locator("#companion-dialog").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: "build/screenshots/panel-companion-setup.png" });
  await page.evaluate(() => { delete globalThis.__companionError; });
  await page.getByRole("button", { name: "Try opening app again" }).click();
  await page.locator("#companion-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => globalThis.__companionRoute), "auth.signin");
  await page.locator("#api-key-button").click();
  assert.equal(await page.evaluate(() => globalThis.__companionRoute), "auth.apikey");
  await page.locator("#connect-button").click();
  assert.equal(await page.evaluate(() => globalThis.__signInStarted), true, "sign-in starts from the panel without opening a separate account-picker step");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.getElementById("account-label").textContent === "Test account");
  await page.setViewportSize({ width: 440, height: 900 });
  await page.locator("#add-button").click(); await page.locator("#menu-page").click();
  await page.evaluate(() => { globalThis.__browserActivity = true; });
  await page.getByRole("textbox", { name: "Message Safari Chat" }).fill("Summarize this page.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#messages .assistant").count(), 1);
  assert.equal(await page.locator("#messages img").count(), 0);
  assert.match(await page.locator("#activity-label").textContent(), /Fill field.*Done/);
  assert.match(await page.locator("#activity-detail").textContent(), /not submitted/);
  await page.evaluate(() => { delete globalThis.__browserActivity; });
  await page.getByRole("textbox", { name: "Message Safari Chat" }).fill("And the next point?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("#messages .assistant").count(), 2);
  assert.ok((await page.locator("#messages").textContent()).includes("Response 2"));
  assert.equal(await page.locator(".message-error").count(), 0, `disconnecting the old port must not interrupt the new run: ${await page.locator("#notice").textContent()}`);
  assert.equal((await page.evaluate(() => globalThis.__runs))[0].messages[0].contexts.length, 1);
  assert.equal((await page.evaluate(() => globalThis.__runs))[0].effort, "high");
  const originalId = (await page.evaluate(() => globalThis.__runs))[0].chatId;
  const prompt = page.getByRole("textbox", { name: "Message Safari Chat" });
  await prompt.fill("An unsent follow-up");
  await page.locator("#add-button").click(); await page.locator("#menu-page").click();
  await page.waitForFunction(() => document.getElementById("draft-status").textContent === "Draft saved");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("prompt").value === "An unsent follow-up");
  assert.equal(await page.locator("#messages .assistant").count(), 2, "reopening restores the current conversation");
  assert.equal(await page.locator("#attachments .attachment").count(), 1, "reopening restores opted-in attachments");
  await page.locator("#messages .user").first().getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Revised message" }).fill("Summarize this page in one sentence.");
  await page.evaluate(() => { globalThis.__saveError = true; });
  await page.getByRole("button", { name: "Send revision" }).click();
  await page.locator("#edit-error").filter({ hasText: "Storage unavailable" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Revised message" }).inputValue(), "Summarize this page in one sentence.");
  await page.evaluate(() => { globalThis.__saveError = false; });
  await page.getByRole("button", { name: "Cancel editing" }).click();
  assert.equal(await prompt.inputValue(), "An unsent follow-up", "cancelling an edit preserves the composer");
  await page.locator("#messages .user").first().getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Revised message" }).fill("Summarize this page in one sentence.");
  await page.screenshot({ path: "build/screenshots/panel-edit.png" });
  await page.getByRole("button", { name: "Send revision" }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  const revised = (await page.evaluate(() => globalThis.__runs)).at(-1);
  assert.notEqual(revised.chatId, originalId);
  assert.equal(revised.messages.length, 1, "editing removes later turns from the new request");
  assert.equal(revised.messages[0].text, "Summarize this page in one sentence.");
  assert.equal(revised.messages[0].contexts.length, 1);
  assert.equal(new URL(page.url()).searchParams.get("chat"), revised.chatId, "standalone reloads target the revised conversation");
  const preserved = await page.evaluate(id => ({ chat: globalThis.__data[id], draft: globalThis.__drafts[id] }), originalId);
  assert.equal(preserved.chat.messages.length, 4, "editing keeps the original history");
  assert.equal(preserved.draft.text, "An unsent follow-up", "editing keeps the original unsent draft");
  await page.evaluate(() => { globalThis.__responseError = true; });
  await prompt.fill("One more question");
  await prompt.press("Enter");
  await page.locator(".message-error").waitFor();
  assert.match(await page.locator("#notice").textContent(), /Connection interrupted/);
  await page.evaluate(() => { globalThis.__responseError = false; globalThis.__responseDelay = 1000; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await effort.isDisabled(), true, "effort cannot change during a response");
  assert.equal(await page.getByRole("button", { name: "Done", exact: true }).isEnabled(), true, "settings can be dismissed while streaming");
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isDisabled(), true);
  await appearance.selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "appearance can change during a response");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  const retried = (await page.evaluate(() => globalThis.__runs)).at(-1);
  assert.notEqual(retried.chatId, revised.chatId);
  assert.equal(retried.messages.at(-1).text, "One more question");
  assert.ok(retried.messages.every(message => !message.error));
  await prompt.fill("Draft while streaming");
  await page.getByRole("button", { name: "Stop response" }).click();
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "hidden" });
  assert.equal(await prompt.inputValue(), "Draft while streaming");
  assert.equal(await page.locator("#effort").isDisabled(), false);
  assert.equal(await page.locator(".message-error").count(), 1);
  await page.evaluate(() => { globalThis.__responseDelay = 100; globalThis.__saveError = true; });
  const beforeFailure = await page.locator("#messages .message").count();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator("#notice").filter({ hasText: "Storage unavailable" }).waitFor();
  assert.equal(await prompt.inputValue(), "Draft while streaming", "failed persistence must retain unsent text");
  assert.equal(await page.locator("#messages .message").count(), beforeFailure);
  await page.evaluate(() => { globalThis.__saveError = false; });
  await prompt.fill("Draft for my account");
  await page.locator("#add-button").click(); await page.locator("#menu-page").click();
  await page.waitForFunction(() => document.getElementById("draft-status").textContent === "Draft saved");
  await page.evaluate(() => { globalThis.__account = "other-account"; window.dispatchEvent(new Event("focus")); });
  await page.waitForFunction(() => document.getElementById("account-label").textContent === "Other account" && !document.getElementById("prompt").disabled);
  assert.equal(await prompt.inputValue(), "");
  assert.equal(await page.locator("#messages .message").count(), 0);
  assert.equal(await page.locator("#attachments .attachment").count(), 0);
  await prompt.fill("Other account's draft");
  await page.waitForFunction(() => document.getElementById("draft-status").textContent === "Draft saved");
  await page.evaluate(() => { globalThis.__account = "test-account"; window.dispatchEvent(new Event("focus")); });
  await page.waitForFunction(() => document.getElementById("prompt").value === "Draft for my account");
  assert.equal(await page.locator("#attachments .attachment").count(), 1);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await prompt.fill("First line");
  await prompt.press("Shift+Enter");
  await prompt.pressSequentially("Second line");
  assert.equal(await prompt.inputValue(), "First line\nSecond line");
  await prompt.fill("A separate draft");
  await page.waitForFunction(() => document.getElementById("draft-status").textContent === "Draft saved");
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search chats" }).fill("nothing matches this");
  assert.equal(await page.locator("#history-list").textContent(), "No matching chats.");
  await page.getByRole("searchbox", { name: "Search chats" }).fill("A separate draft");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete A separate draft", exact: true }).click();
  assert.equal(await prompt.inputValue(), "", "deleting the active draft clears the composer");
  assert.ok(!(await page.evaluate(() => Object.values(globalThis.__drafts))).some(draft => draft.text === "A separate draft"));
  await page.getByRole("searchbox", { name: "Search chats" }).fill("Summarize this page.");
  await page.locator("#history-list .list-row > button:first-child").first().click();
  await page.waitForFunction(() => document.getElementById("prompt").value === "An unsent follow-up");
  await page.getByRole("button", { name: "Return to source tab", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.__returned), 1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(27, 27, 27)");
  await page.screenshot({ path: "build/screenshots/panel-dark-chat.png" });
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.locator("#history-list .list-row > button:first-child").first().waitFor();
  await page.getByRole("button", { name: "Close recent chats" }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "small panel must not overflow horizontally");
  await page.screenshot({ path: "build/screenshots/panel-small.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Remove your data", { exact: true }).click();
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
  assert.deepEqual(await page.evaluate(() => globalThis.__drafts), {}, "cleanup removes saved composers");
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => globalThis.__drafts), {}, "autosave cannot recreate a draft after cleanup");
  await page.screenshot({ path: "build/screenshots/panel-cleanup.png" });
  await page.close();
  await testComposerFeatures(await context.newPage(), origin);
  const dom = await browser.newPage();
  await dom.setContent('<main><h1>Readable title</h1><p>Useful text.</p><p hidden>HIDDEN SECRET</p><input type="password" value="SECRET"><input id="email" aria-label="Email"><button id="submit">Submit</button><script>evil()</script></main>');
  const snapshot = await dom.evaluate(source => eval(`(${source})`)(2000, true), snapshotPage.toString());
  assert.ok(snapshot.text.includes("Useful text")); assert.ok(!snapshot.text.includes("SECRET")); assert.ok(!snapshot.text.includes("evil"));
  const field = snapshot.elements.find(element => element.label === "Email");
  await dom.evaluate(({ fn, id }) => eval(`(${fn})`)("fill", id, "a@example.com", location.href), { fn: actOnPage.toString(), id: field.id });
  assert.equal(await dom.locator("#email").inputValue(), "a@example.com");
  await assert.rejects(dom.evaluate(({ fn, id }) => eval(`(${fn})`)("fill", id, "other", location.href), { fn: actOnPage.toString(), id: field.id }), /Read it again/);
  assert.deepEqual(errors, []);
  await testPageInteractions(browser);
  await testGalleryInteractions(browser);
  await testBrowserAgent(browser, origin);
  await testSideChatIntegration(browser, origin);
  await testPanelMount(browser, origin);
  await testDockWorkflow(browser, origin);
  if (process.env.SAFARI_CHAT_WEBKIT === "1") {
    const { stdout } = await promisify(execFile)("swift", ["-module-cache-path", path.resolve(".cache/swift"), "tests/webkit-panel.swift", `${origin}/panel/panel.html?tab=1`], { timeout: 90000 });
    process.stdout.write(stdout);
    await testWebKitDock(origin);
  }
  console.log("UI smoke passed: chat and browser tools, composer settings, approvals, account isolation, page actions, galleries, narrow layout and multi-page workflows.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
