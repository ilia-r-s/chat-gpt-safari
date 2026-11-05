import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

async function fixture({ nativeFailure = false, nativeUnavailable = false, launchFailure = false, responseGate, scriptEncoding = "utf-8" } = {}) {
  const events = {};
  const data = {};
  const nativeRequests = [];
  const createdTabs = [];
  const listen = name => ({ addListener: callback => { events[name] = callback; } });
  const api = {
    runtime: { id: "test-extension", getURL: file => `safari-web-extension://test/${file}`,
      sendMessage: async () => {},
      onMessage: listen("message"), onConnect: listen("connect"), onInstalled: listen("installed"),
      sendNativeMessage: async (_, message) => {
        nativeRequests.push(message.type);
        if (nativeUnavailable) throw new Error("No native app for temporary extension");
        if (message.type === "app.open") return launchFailure ? { ok: false, error: "macOS could not open Safari Chat" } : { ok: true };
        if (message.type === "data.erase") return nativeFailure ? { ok: false, error: "Keychain is locked" } : { ok: true };
        return message.type === "auth.credential" ? { ok: true, token: "mock-private-token", account: "account-a" }
          : { ok: true, connected: true, canInfer: true, account: "account-a", label: "Account A" };
      },
    }, action: { onClicked: listen("action") }, tabs: { onRemoved: listen("removed"), query: async () => [], create: async options => { createdTabs.push(options); return { id: 2 }; } },
    contextMenus: { onClicked: listen("menu"), removeAll: async () => {}, create() {} },
    storage: { local: { get: async key => key === null ? data : { [key]: data[key] }, set: async value => Object.assign(data, value), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, clear: async () => { for (const key of Object.keys(data)) delete data[key]; } } },
  };
  const context = vm.createContext({ browser: api, console, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: webcrypto, setTimeout, clearTimeout,
    fetch: async url => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ models: [{ visibility: "list", slug: "model-a", display_name: "Model A" }] }));
      if (responseGate) { responseGate.started(); await responseGate.promise; }
      return new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
    },
  });
  vm.runInContext(new TextDecoder(scriptEncoding).decode(await readFile("extension/background.bundle.js")), context);
  const sender = { id: "test-extension", url: "safari-web-extension://test/panel/panel.html?tab=1" };
  return { events, data, nativeRequests, createdTabs, sender };
}
test("classic Safari background registers listeners synchronously", async () => {
  const f = await fixture();
  for (const name of ["message", "connect", "installed", "action", "menu", "removed"]) assert.equal(typeof f.events[name], "function");
});
test("webpages and content scripts cannot invoke privileged panel messages", async () => {
  const f = await fixture();
  assert.equal(f.events.message({ type: "bootstrap" }, { ...f.sender, url: "https://evil.example" }), undefined);
  assert.equal(f.events.message({ type: "bootstrap" }, { ...f.sender, id: "other-extension" }), undefined);
  assert.equal(f.events.message({ type: "auth.open" }, { ...f.sender, url: "https://evil.example" }), undefined);
  assert.equal(f.nativeRequests.length, 0);
  const result = await f.events.message({ type: "auth.credential" }, f.sender);
  assert.equal(result.ok, false); assert.equal(f.nativeRequests.length, 0);
});
test("bootstrap never returns the bearer credential to the UI", async () => {
  const f = await fixture();
  const result = await f.events.message({ type: "bootstrap", tabId: 1 }, f.sender);
  assert.equal(result.ok, true); assert.equal(result.value.models[0].id, "model-a");
  assert.ok(!JSON.stringify(result).includes("mock-private-token"));
});
test("a temporary extension explains setup without opening an invalid Safari tab", async () => {
  const f = await fixture({ nativeUnavailable: true });
  const state = await f.events.message({ type: "bootstrap", tabId: 1 }, f.sender);
  assert.equal(state.value.auth.connected, false);
  assert.match(state.value.auth.error, /temporary extension.*packaged Safari Chat app/);
  const result = await f.events.message({ type: "auth.open" }, f.sender);
  assert.equal(result.ok, false); assert.match(result.error, /companion app is unavailable/);
  assert.deepEqual(f.createdTabs, []);
});
test("Connect account requests native app launch without touching credentials or opening a tab", async () => {
  const f = await fixture();
  const result = await f.events.message({ type: "auth.open" }, f.sender);
  assert.equal(result.ok, true);
  assert.deepEqual(f.nativeRequests, ["app.open"]); assert.deepEqual(f.createdTabs, []);
});
test("native launch failures stay visible without a custom-scheme fallback", async () => {
  const f = await fixture({ launchFailure: true });
  const result = await f.events.message({ type: "auth.open" }, f.sender);
  assert.equal(result.ok, false); assert.match(result.error, /macOS could not open/);
  assert.deepEqual(f.createdTabs, []);
});
for (const scriptEncoding of ["utf-8", "windows-1252"]) test(`background preserves status text, streams and saves a response with ${scriptEncoding} script decoding`, async () => {
  const f = await fixture({ scriptEncoding }); const messages = []; let listener;
  const port = { name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage: message => messages.push(message), disconnect() {} };
  f.events.connect(port);
  const id = "00000000-0000-4000-8000-000000000001";
  await listener({ type: "run", chatId: id, title: "Hello", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Hello", contexts: [] }] });
  assert.equal(messages.find(message => message.type === "status").text, "Thinking\u2026");
  assert.ok(messages.some(m => m.type === "delta" && m.text === "Hello"));
  assert.equal(messages.at(-1).type, "done");
  assert.equal(f.data[`chat:${id}`].messages.at(-1).text, "Hello");
  assert.equal(f.data[`chat:${id}`].account, "account-a");
});
test("a changed account fails before inference and cannot overwrite another account's chat", async () => {
  const f = await fixture(); const messages = []; let listener;
  f.events.connect({ name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage: message => messages.push(message), disconnect() {} });
  await listener({ type: "run", account: "account-b", messages: [{ role: "user", text: "Hello" }] });
  assert.equal(messages.at(-1).type, "error"); assert.match(messages.at(-1).message, /account changed/);
  assert.ok(!f.nativeRequests.includes("auth.credential"));
});
test("cleanup clears this profile, requests native erasure, and blocks stale panel writes", async () => {
  const f = await fixture(); f.data.settings = { theme: "dark" }; f.data["chat:old"] = { text: "private" }; f.data["draft:1"] = "private";
  const result = await f.events.message({ type: "data.erase" }, f.sender);
  assert.equal(result.value.browserCleared, true); assert.equal(result.value.nativeCleared, true);
  assert.equal(result.value.failures.length, 0); assert.deepEqual(f.data, {});
  assert.ok(f.nativeRequests.includes("data.erase"));
  const stale = await f.events.message({ type: "settings.save", settings: { theme: "light" } }, f.sender);
  assert.equal(stale.ok, false); assert.deepEqual(f.data, {});
  const state = await f.events.message({ type: "bootstrap" }, f.sender);
  assert.equal(state.value.removalPrepared, true);
});
test("native cleanup failure is reported even when browser erasure succeeds", async () => {
  const f = await fixture({ nativeFailure: true }); f.data.secret = "private";
  const result = await f.events.message({ type: "data.erase" }, f.sender);
  assert.equal(result.value.browserCleared, true); assert.equal(result.value.nativeCleared, false);
  assert.match(result.value.failures[0], /Keychain is locked/); assert.deepEqual(f.data, {});
});
test("an aborted response cannot recreate a chat after cleanup", async () => {
  let release; let started;
  const promise = new Promise(resolve => { release = resolve; });
  const beginning = new Promise(resolve => { started = resolve; });
  const f = await fixture({ responseGate: { promise, started } });
  let listener;
  f.events.connect({ name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} });
  const run = listener({ type: "run", chatId: "00000000-0000-4000-8000-000000000001", title: "Private", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Private" }] });
  await beginning;
  const result = await f.events.message({ type: "data.erase" }, f.sender);
  assert.equal(result.value.browserCleared, true);
  release(); await run;
  assert.deepEqual(f.data, {});
});
