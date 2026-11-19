import test from "node:test";
import assert from "node:assert/strict";
import { chatPort, fixture } from "./background-fixture.mjs";

const turn = { type: "run", generation: "session-a", chatId: "00000000-0000-4000-8000-000000000011", title: "First", account: "account-a", model: "model-a", messages: [{ role: "user", text: "First" }] };
for (const notify of [true, false]) test(`a pending approval cannot cross a same-account reconnection, native event ${notify}`, { timeout: 3000 }, async () => {
  const f = await fixture({ toolRequest: { operation: "open_tab", url: "https://example.com/" } });
  const terminal = [], pending = Promise.withResolvers();
  const receive = chatPort(f, event => { terminal.push(event); if (event.type === "approval") pending.resolve(event); });
  const run = receive(turn);
  const approval = await pending.promise;
  f.setAccount("account-b"); f.setAccount("account-a", "new-session");
  if (notify) f.events.nativeEvent({ type: "auth.changed" });
  else await receive({ type: "approval", id: approval.id, allow: true });
  await run;
  if (notify) await receive({ type: "approval", id: approval.id, allow: true });
  assert.deepEqual(f.createdTabs, []); assert.equal(f.requests.length, 1);
  assert.equal(terminal.at(-1).type, "cancelled"); assert.equal(f.data[`chat:${turn.chatId}`], undefined);
  const stale = await f.events.message({ type: "chat.delete", generation: turn.generation, id: turn.chatId }, f.sender);
  assert.equal(stale.ok, false);
});
test("a delayed response forks when a second editor changes its starting revision", async () => {
  const pending = Promise.withResolvers(), gate = Promise.withResolvers();
  const f = await fixture({ responseGate: { promise: gate.promise, started: pending.resolve } });
  const initial = { id: turn.chatId, title: turn.title, account: turn.account, messages: turn.messages };
  const save = chat => f.events.message({ type: "chat.save", chat, generation: turn.generation }, f.sender);
  const first = (await save(initial)).value;
  const events = [], run = chatPort(f, event => events.push(event))({ ...turn, revision: first.revision });
  await pending.promise;
  const edited = await save({ ...first, messages: [{ role: "user", text: "Second editor" }] });
  assert.equal(edited.value.id, turn.chatId);
  gate.resolve(); await run;
  const receipt = events.at(-1).saved;
  assert.notEqual(receipt.id, turn.chatId);
  assert.equal(f.data[`chat:${receipt.id}`].messages.at(-1).text, "Hello");
  assert.equal(f.data[`chat:${turn.chatId}`].messages[0].text, "Second editor");
});
test("restoring a dock reads no page and context-menu excerpts are session-bound and consumed once", async () => {
  const f = await fixture(), reads = [];
  const tab = { id: 7, windowId: 4, title: "Example", url: "https://example.com/?private=1" };
  f.api.scripting = { executeScript: async spec => {
    if (spec.files) { assert.deepEqual(Array.from(spec.files), ["content/mount.js"]); return []; }
    reads.push(spec); return [{ result: { text: "Shared page body", url: tab.url, title: tab.title } }];
  } };
  await f.events.action(tab); await f.events.updated(7, { status: "complete" }, tab);
  assert.equal(f.createdWindows.length, 0); assert.equal(reads.length, 0);
  const take = (generation = "session-a") => f.events.message({ type: "context.take", generation, account: "account-a", tabId: 7 }, f.sender);
  await f.events.menu({ menuItemId: "ask", selectionText: "Only this passage" }, tab);
  assert.equal(reads.length, 0);
  assert.equal((await f.events.message({ type: "bootstrap", tabId: 7 }, f.sender)).value.hasContext, true);
  const passage = (await take()).value;
  assert.equal(passage.kind, "selection"); assert.equal(passage.text, "Only this passage"); assert.equal(passage.url, "https://example.com/");
  assert.equal((await take()).value, null);
  await f.events.menu({ menuItemId: "ask" }, tab);
  assert.equal(reads.length, 1);
  f.setAccount("account-a", "replacement");
  assert.equal((await take()).ok, false); assert.equal((await take("replacement")).value, null);
  assert.equal(f.createdTabs.length, 0);
  assert.equal((await f.api.windows.get(4)).width, 1440);
});
test("classic Safari background registers listeners synchronously", async () => {
  const f = await fixture();
  for (const name of ["message", "connect", "installed", "action", "menu", "removed"]) assert.equal(typeof f.events[name], "function");
});
test("a protected Safari page explains why the pane cannot open and keeps the current tab selected", async () => {
  const f = await fixture();
  const tab = { id: 7, windowId: 4, index: 3, url: "about:blank" };
  f.api.tabs.get = async () => tab;
  await f.events.action(tab);
  assert.deepEqual(f.createdWindows, []); assert.deepEqual(f.createdTabs, []);
  assert.equal(f.badges.get(7), "!"); assert.match(f.titles.get(7), /Safari protects this page/);
  assert.deepEqual(f.nativeRequests, []);
});
test("webpages and content scripts cannot invoke privileged panel messages", async () => {
  const f = await fixture();
  assert.equal(f.events.message({ type: "bootstrap" }, { ...f.sender, url: "https://evil.example" }), undefined);
  assert.equal(f.events.message({ type: "bootstrap" }, { ...f.sender, id: "other-extension" }), undefined);
  assert.equal((await f.events.message({ type: "panel.close" }, { ...f.sender, frameId: 8 })).ok, false);
  assert.equal(f.events.message({ type: "auth.open" }, { ...f.sender, url: "https://evil.example" }), undefined);
  assert.equal(f.events.message({ type: "auth.signin" }, { ...f.sender, url: "https://evil.example" }), undefined);
  assert.equal(f.nativeRequests.length, 0);
  const result = await f.events.message({ type: "auth.credential" }, f.sender);
  assert.equal(result.ok, false); assert.equal(f.nativeRequests.length, 0);
  for (const type of ["desktop.verify", "desktop.reply", "desktop.request"]) {
    assert.equal((await f.events.message({ type }, f.sender)).ok, false);
  }
  assert.equal(f.nativeRequests.length, 0);
});
test("bootstrap never returns the bearer credential to the UI", async () => {
  const f = await fixture();
  const result = await f.events.message({ type: "bootstrap", tabId: 1 }, f.sender);
  assert.equal(result.ok, true); assert.equal(result.value.models, null);
  assert.ok(!f.nativeRequests.includes("auth.credential"), "opening local chat does not wait for a model catalog request");
  const catalog = await f.events.message({ type: "models.list", account: turn.account, generation: turn.generation }, f.sender);
  assert.equal(catalog.value[0].id, "model-a");
  assert.ok(!JSON.stringify(catalog).includes("mock-private-token"));
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
for (const [type, nativeType] of [["auth.open", "app.open"], ["auth.signin", "auth.signin"], ["auth.apikey", "auth.apikey"]]) test(`${type} requests a fixed native route without returning credentials or opening a tab`, async () => {
  const f = await fixture();
  const result = await f.events.message({ type }, f.sender);
  assert.equal(result.ok, true);
  assert.deepEqual(f.nativeRequests, [nativeType]); assert.deepEqual(f.createdTabs, []);
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
  await listener({ type: "run", generation: "session-a", chatId: id, title: "Hello", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Hello", contexts: [] }] });
  assert.equal(messages.find(message => message.type === "status").text, "Thinking\u2026");
  assert.ok(messages.some(m => m.type === "delta" && m.text === "Hello"));
  assert.equal(messages.at(-1).type, "done");
  assert.equal(f.data[`chat:${id}`].messages.at(-1).text, "Hello");
  assert.equal(f.data[`chat:${id}`].account, "account-a");
});
test("every chat receives browser tools even with an obsolete disabled mode saved", async () => {
  const f = await fixture(); let listener;
  f.data.settings = { browserTools: false, webSearch: true };
  f.events.connect({ name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} });
  const run = { type: "run", generation: "session-a", chatId: "00000000-0000-4000-8000-000000000001", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Hello" }] };
  await listener(run);
  assert.deepEqual(f.requests[0].tools.map(tool => tool.type), ["namespace"]);
  await listener({ ...run, webSearch: true });
  assert.deepEqual(f.requests[1].tools.map(tool => tool.type), ["namespace", "web_search"]);
});
test("a changed account fails before inference and cannot overwrite another account's chat", async () => {
  const f = await fixture(); const messages = []; let listener;
  f.events.connect({ name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage: message => messages.push(message), disconnect() {} });
  await listener({ type: "run", generation: "session-a", account: "account-b", messages: [{ role: "user", text: "Hello" }] });
  assert.equal(messages.at(-1).type, "error"); assert.match(messages.at(-1).message, /account changed/);
  assert.ok(!f.nativeRequests.includes("auth.credential"));
});

test("effort uses the sending panel's choice and rejects unavailable levels before inference", async () => {
  const f = await fixture(); const messages = []; let listener;
  f.data.settings = { reasoningEffort: "low" };
  f.events.connect({ name: "chat", sender: f.sender, onMessage: { addListener: fn => { listener = fn; } }, onDisconnect: { addListener() {} }, postMessage: message => messages.push(message), disconnect() {} });
  const run = { type: "run", generation: "session-a", chatId: "00000000-0000-4000-8000-000000000001", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Hello" }] };
  await listener({ ...run, effort: "high" });
  assert.deepEqual(f.requests[0].reasoning, { effort: "high" });
  await listener({ ...run, effort: "auto" });
  assert.equal(f.requests[1].reasoning, undefined);
  await listener({ ...run, effort: "max" });
  assert.equal(f.requests.length, 2);
  assert.equal(messages.at(-1).type, "error"); assert.match(messages.at(-1).message, /not available/);
});
test("partial setting saves merge serially without resetting other preferences or desktop consent", async () => {
  const f = await fixture();
  f.data.settings = { theme: "system", model: "model-a", reasoningEffort: "high", desktopControl: true, pageChars: 9000 };
  const results = await Promise.all([
    f.events.message({ type: "settings.save", settings: { theme: "dark" } }, f.sender),
    f.events.message({ type: "settings.save", settings: { reasoningEffort: "low" } }, f.sender),
  ]);
  assert.ok(results.every(result => result.ok));
  assert.equal(f.data.settings.theme, "dark"); assert.equal(f.data.settings.reasoningEffort, "low");
  assert.equal(f.data.settings.model, "model-a"); assert.equal(f.data.settings.pageChars, 9000);
  assert.equal(f.data.settings.desktopControl, true);
  assert.ok(!f.nativeRequests.includes("desktop.enable"));
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
  const run = listener({ type: "run", generation: "session-a", chatId: "00000000-0000-4000-8000-000000000001", title: "Private", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Private" }] });
  await beginning;
  const result = await f.events.message({ type: "data.erase" }, f.sender);
  assert.equal(result.value.browserCleared, true);
  release(); await run;
  assert.deepEqual(f.data, {});
});

test("draft RPCs restore the active chat, reject account changes, and remove drafts with chats", async () => {
  const f = await fixture();
  const id = "00000000-0000-4000-8000-000000000002";
  const send = message => f.events.message({ generation: "session-a", ...message }, f.sender);
  const draft = { id, account: "account-a", text: "Unsent message", contexts: [{ kind: "file", key: "file:a", title: "Notes", text: "Private notes" }] };
  assert.equal((await send({ type: "draft.save", draft, tabId: 1 })).ok, true);
  assert.equal((await send({ type: "bootstrap", tabId: 1 })).value.activeChat, id);
  assert.equal((await send({ type: "draft.load", id })).value.text, "Unsent message");
  assert.equal((await send({ type: "chat.load", id })).value, undefined, "a draft need not have sent messages");
  f.setAccount("account-b");
  assert.equal((await send({ type: "draft.load", id })).ok, false);
  assert.equal((await send({ type: "draft.save", draft, tabId: 1 })).ok, false);
  assert.equal((await send({ type: "chat.delete", id })).ok, false);
  assert.equal((await send({ type: "bootstrap", tabId: 1 })).value.activeChat, undefined);
  f.setAccount("account-a");
  assert.equal((await send({ type: "chat.delete", id })).ok, true);
  assert.equal((await send({ type: "draft.load", id })).value, undefined);
  assert.equal((await send({ type: "bootstrap", tabId: 1 })).value.activeChat, undefined);
});
test("cleanup blocks queued and late composer writes and removes active-chat pointers", async () => {
  const f = await fixture();
  const draft = { id: "00000000-0000-4000-8000-000000000003", account: "account-a", text: "Private draft" };
  const send = message => f.events.message({ generation: "session-a", ...message }, f.sender);
  await send({ type: "draft.save", draft, tabId: 1 });
  const queued = send({ type: "draft.save", draft: { ...draft, text: "Late draft" }, tabId: 1 });
  await send({ type: "data.erase" }); await queued;
  assert.deepEqual(f.data, {});
  assert.equal((await send({ type: "draft.save", draft, tabId: 1 })).ok, false);
  assert.deepEqual(f.data, {});
});

test("remembering a website comes from the pending operation and survives the next chat", async () => {
  const f = await fixture({ toolRequest: { operation: "open_tab", url: "https://example.com/path" } });
  const events = [], pending = Promise.withResolvers();
  const receive = chatPort(f, event => { events.push(event); if (event.type === "approval") pending.resolve(event); });
  const run = receive({ ...turn, approvalMode: "auto" });
  const request = await pending.promise;
  assert.deepEqual(Array.from(request.hosts), ["example.com"]);
  await receive({ type: "approval", id: "wrong", allow: true, scope: "all" });
  assert.deepEqual(f.createdTabs, []);
  await receive({ type: "approval", id: request.id, allow: true, scope: "site", host: "unrelated.example" });
  await run;
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(Array.from(f.data["website-access:account-a"].allowed), ["example.com"]);
  f.requests.length = 0; events.length = 0;
  await receive(turn);
  assert.equal(events.some(event => event.type === "approval"), false);
  assert.equal(f.createdTabs.length, 2);
});

test("all-sites access belongs to the connection, respects blocks and cannot be granted by an old session", async () => {
  const f = await fixture({ toolRequest: { operation: "open_tab", url: "https://example.com/" } });
  const change = patch => f.events.message({ type: "access.change", generation: turn.generation, account: turn.account, change: patch }, f.sender);
  const updates = await Promise.all([change({ mode: "auto" }), change({ host: "Example.COM", rule: "block" })]);
  assert.ok(updates.every(result => result.ok));
  const messages = [], receive = chatPort(f, event => messages.push(event));
  await receive(turn);
  assert.equal(f.createdTabs.length, 0);
  assert.match(f.requests[1].input.at(-1).output, /example.com is blocked/);
  await change({ host: "example.com", rule: "remove" });
  f.requests.length = 0;
  await receive(turn);
  assert.equal(f.createdTabs.length, 1);
  assert.equal(messages.some(event => event.type === "approval"), false);
  f.setAccount("account-b");
  assert.equal((await f.events.message({ type: "bootstrap" }, f.sender)).value.access.mode, "ask");
  f.setAccount("account-a", "new-session");
  assert.equal((await change({ mode: "ask" })).ok, false);
  assert.equal(f.data["website-access:account-a"].mode, "auto");
  assert.equal(f.events.message({ type: "access.change" }, { ...f.sender, url: "https://example.com/" }), undefined);
});

test("an automatic action rechecks the native generation and a cancelled prompt cannot save a grant", async () => {
  const f = await fixture({ toolRequest: { operation: "open_tab", url: "https://example.com/" } });
  const events = [], pending = Promise.withResolvers();
  const receive = chatPort(f, event => { events.push(event); if (event.type === "approval") pending.resolve(event); });
  const run = receive(turn);
  const request = await pending.promise;
  await receive({ type: "cancel" });
  await receive({ type: "approval", id: request.id, allow: true, scope: "all" });
  await run;
  assert.equal(f.data["website-access:account-a"], undefined);
  f.requests.length = 0; events.length = 0;
  f.data["website-access:account-a"] = { mode: "auto", blocked: [], allowed: [] };
  const get = f.api.storage.local.get;
  f.api.storage.local.get = async key => {
    if (key === "website-access:account-a") f.setAccount("account-a", "reconnected");
    return get(key);
  };
  await receive(turn);
  assert.equal(events.at(-1).type, "cancelled");
  assert.deepEqual(f.createdTabs, []);
});

test("blocked websites are omitted from the picker and cannot be captured by selection or direct sharing", async () => {
  const f = await fixture(), tab = { id: 7, windowId: 4, title: "Private page", url: "https://example.com/notes" };
  const send = message => f.events.message({ generation: turn.generation, account: turn.account, ...message }, f.sender);
  await send({ type: "access.change", change: { host: tab.url, rule: "block" } });
  f.api.tabs.get = async () => tab;
  f.api.tabs.query = async () => [tab];
  f.api.scripting = { executeScript: async spec => { assert.ok(spec.files, "no page capture should run"); return []; } };
  f.api.tabs.sendMessage = async () => ({ ok: true });
  assert.equal((await send({ type: "tabs.list" })).value.length, 0);
  assert.match((await send({ type: "context.read", tabId: tab.id })).error, /blocked/);
  await f.events.menu({ menuItemId: "ask", selectionText: "private selection" }, tab);
  assert.match((await send({ type: "context.take", tabId: tab.id })).value.error, /blocked/);
  assert.ok(!JSON.stringify(f.data).includes("private selection"));
});

test("a previously detached chat returns to its originating tab and opens the integrated pane", async () => {
  const f = await fixture(), activated = [], shown = [];
  f.api.scripting = { executeScript: async () => [] };
  f.api.tabs.sendMessage = async (id, message) => { shown.push([id, message.type]); return { ok: true }; };
  f.api.tabs.update = async (id, options) => { activated.push([id, options.active]); return f.api.tabs.get(id); };
  f.api.windows = { update: async (id, options) => activated.push([id, options.focused]) };
  const result = await f.events.message({ type: "panel.source", tabId: 99 }, f.sender);
  assert.equal(result.ok, true); assert.deepEqual(activated, [[1, true], [4, true]]);
  assert.deepEqual(shown, [[1, "panel.show"]]); assert.deepEqual(f.createdTabs, []);
  await f.events.action({ id: 42, windowId: 4, url: f.sender.url });
  assert.deepEqual(shown, [[1, "panel.show"], [1, "panel.show"]]); assert.deepEqual(f.createdTabs, []);
  assert.equal((await f.events.message({ type: "panel.source" }, { ...f.sender, url: f.sender.url.split("?")[0] })).ok, false);
});

test("tab mentions and agent tab operations use the source window while the chat has focus", async () => {
  const f = await fixture({ toolRequest: [{ operation: "list_tabs" }, { operation: "open_tab", url: "https://one.example/" }] });
  f.sender.tab = { id: 77, windowId: 88 };
  f.data["website-access:account-a"] = { mode: "auto", allowed: [], blocked: [] };
  const scopes = [];
  f.api.tabs.query = async query => { scopes.push(query); return []; };
  const listed = await f.events.message({ type: "tabs.list", generation: "session-a", tabId: 77 }, f.sender);
  assert.equal(listed.ok, true);
  const events = [];
  await chatPort(f, event => events.push(event))(turn);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(scopes.map(scope => scope.windowId), [4, 4]);
  assert.equal(f.createdTabs[0].windowId, 4);
  f.api.tabs.get = async () => { throw Error("Tab was closed"); };
  const missing = await f.events.message({ type: "tabs.list", generation: "session-a" }, f.sender);
  assert.match(missing.error, /source tab was closed/);
});
