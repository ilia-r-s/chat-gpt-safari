import test from "node:test";
import assert from "node:assert/strict";
import { ChatDock } from "../extension/core/chat-dock.js";
import { chatPort, fixture } from "./background-fixture.mjs";

const source = { id: 1, windowId: 4, index: 0, active: true, url: "https://example.com/" };
const manager = f => new ChatDock(f.api, f.api.runtime.getURL("panel/panel.html"));
async function setup(options) {
  const f = await fixture(options);
  const shown = [];
  f.api.scripting = { executeScript: async spec => { assert.deepEqual(Array.from(spec.files), ["content/mount.js"]); return []; } };
  f.api.tabs.sendMessage = async (id, message) => { if (message.type === "panel.show") shown.push(message); return { ok: true }; };
  await f.events.action(source);
  const sender = { id: f.sender.id, url: shown[0].url, tab: source, frameId: 7 };
  return { f, shown, sender, dockToken: shown[0].token };
}

test("the dock restores its width and grant on refresh, reuses one source, and closes without removing the website", async () => {
  const { f, shown, sender, dockToken } = await setup();
  const original = await f.api.windows.get(4);
  assert.ok(!sender.url.includes(dockToken));
  const token = dockToken;
  await f.events.message({ type: "dock.width", width: 550, token }, { ...sender, frameId: 0, url: source.url });
  await Promise.all([f.events.action(source), f.events.updated(1, { status: "complete" }, source)]);
  assert.equal(shown.length, 3); assert.ok(shown.every(item => item.url === sender.url && item.token === token)); assert.equal(shown[2].width, 550);
  const fresh = manager(f);
  await fresh.open(source, { restore: true }); assert.equal(shown.at(-1).width, 550);
  await fresh.open({ ...source, id: 22 }); assert.notEqual(shown.at(-1).url, sender.url);
  assert.deepEqual(f.createdWindows, []); assert.deepEqual(f.createdTabs, []);
  await f.events.message({ type: "panel.close", dockToken }, sender);
  await f.events.updated(1, { status: "complete" }, source);
  assert.equal(shown.length, 5); assert.equal(f.session.chatDocks?.[1], undefined);
  assert.deepEqual(await f.api.windows.get(4), original);
});

test("a framed panel needs the grant for this source and an ordinary webpage cannot issue native commands", async () => {
  const { f, sender, dockToken } = await setup();
  for (const [fake, proof] of [[{ ...sender, frameId: 0 }, dockToken], [{ ...sender, tab: { ...source, id: 11 } }, dockToken],
    [sender, undefined], [sender, crypto.randomUUID()]]) {
    const reply = await f.events.message({ type: "auth.open", dockToken: proof }, fake); assert.equal(reply.ok, false);
  }
  assert.equal(await f.events.message({ type: "auth.open" }, { ...sender, frameId: 0, url: source.url }), undefined);
  assert.equal(f.nativeRequests.includes("app.open"), false);
  assert.equal((await f.events.message({ type: "auth.open", dockToken }, sender)).ok, true);
  await f.events.message({ type: "panel.close", dockToken }, sender);
  assert.equal((await f.events.message({ type: "auth.open", dockToken }, sender)).ok, false);
});

test("denied access and failed mounts report the problem in the source tab and recover there", async () => {
  const { f, shown, dockToken } = await setup();
  const script = f.api.scripting.executeScript, send = f.api.tabs.sendMessage;
  const selected = []; f.api.tabs.update = async id => selected.push(id);
  f.api.scripting.executeScript = async () => { throw Error("Access denied"); };
  await f.events.action(source);
  assert.equal(f.badges.get(1), "!"); assert.match(f.titles.get(1), /access to this website/);
  f.api.scripting.executeScript = script;
  for (const reply of [async () => ({ ok: false }), async () => { throw Error("No receiver"); }]) {
    f.api.tabs.sendMessage = reply;
    await f.events.action(source);
    assert.equal(f.badges.get(1), "!"); assert.match(f.titles.get(1), /Reload the page/);
  }
  f.api.tabs.sendMessage = send;
  await f.events.updated(1, { status: "complete" }, source);
  assert.equal(f.badges.get(1), ""); assert.equal(shown.at(-1).token, dockToken);
  assert.deepEqual(selected, []); assert.deepEqual(f.createdTabs, []); assert.deepEqual(f.createdWindows, []);
});

test("an upgrade forgets the detached-tab mapping and restores the saved pane width on the source", async () => {
  const f = await fixture(), token = crypto.randomUUID(), shown = [];
  f.session.chatDocks = { 1: { token, width: 520, tab: 42 } };
  const touched = [];
  f.api.tabs.update = f.api.tabs.remove = async id => touched.push(id);
  f.api.scripting = { executeScript: async () => [] };
  f.api.tabs.sendMessage = async (id, message) => { shown.push([id, message.width, message.token]); return { ok: true }; };
  const fresh = manager(f);
  await fresh.open(source); await fresh.removed(42); await fresh.open(source, { restore: true });
  assert.deepEqual(shown, [[1, 520, token], [1, 520, token]]);
  assert.deepEqual(f.session.chatDocks, { 1: { token, width: 520 } });
  assert.deepEqual(touched, []); assert.deepEqual(f.createdTabs, []); assert.deepEqual(f.createdWindows, []);
});

test("upgrading restores only a window with the extension's recorded frame", async () => {
  for (const changed of [false, true]) {
    const f = await fixture(), original = await f.api.windows.get(4);
    const applied = { left: 40, top: 30, width: 900, height: 900 };
    f.session.chatWindows = [{ windowId: 4, original: { left: 40, top: 30, width: original.width, height: 900 }, applied, state: "normal" }];
    await f.api.windows.update(4, { ...applied, width: changed ? 760 : 900 });
    await manager(f).load(); assert.deepEqual(f.session, {});
    assert.equal((await f.api.windows.get(4)).width, changed ? 760 : original.width);
  }
});

test("a dock can verify and retry erasure after its persisted restore grant is removed", async () => {
  const { f, sender, dockToken } = await setup({ nativeFailure: true });
  const erase = () => f.events.message({ type: "data.erase", dockToken }, sender);
  const first = await erase(); assert.equal(first.value.browserCleared, true); assert.equal(first.value.nativeCleared, false);
  assert.deepEqual(f.session, {});
  const retry = await erase(); assert.equal(retry.ok, true);
  assert.equal(f.nativeRequests.filter(type => type === "data.erase").length, 2);
  assert.equal((await f.events.message({ type: "bootstrap", dockToken }, sender)).value.removalPrepared, true);
});

test("a detached port cannot approve, another source cannot resume, and reattachment executes one action", { timeout: 3000 }, async () => {
  const { f, sender, dockToken } = await setup({ toolRequest: { operation: "open_tab", url: "https://example.com/next" } });
  const prompt = Promise.withResolvers(), start = { type: "run", dockToken, chatId: crypto.randomUUID(), title: "Open a tab", messages: [{ role: "user", text: "Open it" }], model: "model-a", account: "account-a", generation: "session-a" };
  const detached = chatPort(f, event => { if (event.type === "approval") prompt.resolve(event); }, sender);
  const run = detached(start), approval = await prompt.promise;
  detached.disconnect();
  const hint = (await f.events.message({ type: "bootstrap", tabId: 1, dockToken }, { ...sender, frameId: 8 })).value.run;
  const request = { ...hint, type: "resume", generation: start.generation, account: start.account };
  const other = [];
  await chatPort(f, event => other.push(event), { ...f.sender, url: f.sender.url.replace("tab=1", "tab=9") })(request);
  assert.equal(other[0].type, "run.ended"); assert.equal(other[0].saved, undefined);
  const events = [], fresh = chatPort(f, event => events.push(event), { ...sender, frameId: 8 });
  await fresh({ ...request, dockToken });
  assert.equal(events[0].type, "resumed"); assert.equal(events[0].events.at(-1).id, approval.id);
  const allow = { type: "approval", allow: true, id: approval.id };
  await detached(allow); assert.equal(f.createdTabs.length, 0);
  await Promise.all([fresh(allow), fresh(allow)]); await run;
  assert.equal(events.at(-1).type, "done"); assert.equal(f.createdTabs.length, 1); assert.equal(f.requests.length, 2);
  const late = []; await chatPort(f, event => late.push(event), sender)({ ...request, dockToken });
  assert.equal(late[0].type, "run.ended"); assert.equal(late[0].saved.id, hint.chatId);
});

test("closing the pane while an approval is pending cancels the run and prevents later restore", { timeout: 3000 }, async () => {
  const { f, sender, dockToken, shown } = await setup({ toolRequest: { operation: "open_tab", url: "https://example.com/next" } });
  const waiting = Promise.withResolvers(), events = [];
  const port = chatPort(f, event => { events.push(event); if (event.type === "approval") waiting.resolve(event); }, sender);
  const run = port({ type: "run", chatId: crypto.randomUUID(), dockToken, generation: "session-a", account: "account-a", model: "model-a", messages: [{ role: "user", text: "Open it" }] });
  const approval = await waiting.promise;
  const top = { ...sender, url: source.url, frameId: 0 };
  await f.events.message({ type: "dock.dismiss", token: crypto.randomUUID() }, top);
  assert.ok(f.session.chatDocks[1]);
  await f.events.message({ type: "dock.dismiss", token: dockToken }, top);
  await run;
  await port({ type: "approval", id: approval.id, allow: true });
  await f.events.updated(1, { status: "complete" }, source);
  assert.equal(events.at(-1).type, "cancelled"); assert.equal(shown.length, 1);
  assert.deepEqual(f.createdTabs, []); assert.deepEqual(f.session, {});
});

test("reload recovers a just-typed draft against its original revision and keeps the other editor's copy", async () => {
  const { f, sender, dockToken } = await setup();
  const generation = "session-a", account = "account-a", id = crypto.randomUUID(), editor = crypto.randomUUID();
  const rpc = (type, extra = {}) => f.events.message({ type, tabId: 1, dockToken, generation, ...extra }, sender);
  const draft = { account, id, text: "First draft", contexts: [], revision: 0 };
  const initial = (await rpc("draft.save", { draft })).value;
  const edit = { ...draft, revision: initial.revision, text: "Typed just before reload" };
  await rpc("draft.stage", { editor, sequence: 3, draft: edit });
  await rpc("draft.stage", { editor, sequence: 1, draft: { ...edit, text: "Older keystroke" } });
  await rpc("draft.save", { draft: { ...draft, revision: initial.revision, text: "Other editor" } });
  const restored = (await rpc("bootstrap", { openEditor: crypto.randomUUID() })).value.activeChat;
  assert.ok(restored && restored !== id);
  assert.equal(f.data["composer:" + restored].text, edit.text);
  assert.equal(f.data["composer:" + restored].sourceChatId, id);
  assert.equal(f.data["composer:" + id].text, "Other editor");
  const stale = (await rpc("draft.save", { editor, sequence: 4, draft: edit })).value;
  assert.equal(stale.id, restored);
  assert.equal(Object.keys(f.data).filter(key => key.startsWith("composer:")).length, 2);
  await rpc("draft.stage", { editor: crypto.randomUUID(), sequence: 1, draft: { ...edit, text: "Old generation" } });
  f.setAccount("account-a", "new-session");
  await rpc("bootstrap", { openEditor: crypto.randomUUID() });
  assert.equal(f.data["composer:" + restored].text, edit.text);
});

test("a task from an older chat tab reconnects to the pane and survives closing the old tab", { timeout: 3000 }, async () => {
  const { f, sender, dockToken } = await setup({ toolRequest: { operation: "open_tab", url: "https://example.com/next" } });
  const waiting = Promise.withResolvers(), chatId = crypto.randomUUID(), generation = "session-a", account = "account-a";
  const legacy = { ...f.sender, frameId: 0, tab: { id: 42, windowId: 4, url: f.sender.url } };
  const old = chatPort(f, event => { if (event.type === "approval") waiting.resolve(event); }, legacy);
  const run = old({ type: "run", chatId, generation, account, model: "model-a", messages: [{ role: "user", text: "Open it" }] });
  const approval = await waiting.promise;
  assert.equal((await f.events.message({ type: "panel.source" }, legacy)).ok, true);
  const hint = (await f.events.message({ type: "bootstrap", tabId: 1, chatId, dockToken }, sender)).value.run;
  const events = [], fresh = chatPort(f, event => events.push(event), sender);
  await fresh({ type: "resume", ...hint, account, generation, dockToken });
  assert.equal(events[0].events.at(-1).id, approval.id);
  old.disconnect(); await f.api.tabs.remove(42);
  assert.deepEqual(f.createdTabs, []);
  await fresh({ type: "approval", allow: true, id: approval.id });
  await run;
  assert.equal(events.at(-1).type, "done"); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.createdTabs.map(tab => tab.url), ["https://example.com/next"]);
  assert.equal(f.session.chatDocks[1].token, dockToken);
});

test("a reconnected run restores the follow-up editor's fork after a conflicting autosave", { timeout: 3000 }, async () => {
  const gate = Promise.withResolvers(), pending = Promise.withResolvers();
  const { f, sender, dockToken } = await setup({ responseGate: { started: pending.resolve, promise: gate.promise } });
  const account = "account-a", generation = "session-a", id = crypto.randomUUID(), editor = crypto.randomUUID();
  const rpc = (type, extra = {}) => f.events.message({ type, tabId: 1, generation, dockToken, ...extra }, sender);
  const chat = { id, account, title: "Work", messages: [{ role: "user", text: "Work" }] };
  const saved = (await rpc("chat.save", { chat })).value;
  const old = chatPort(f, () => {}, sender);
  const run = old({ type: "run", account, generation, chatId: id, model: "model-a", revision: saved.revision, messages: chat.messages, dockToken });
  await pending.promise;
  const draft = { id, account, revision: 0, chatRevision: saved.revision, text: "Other editor", contexts: [] };
  await rpc("draft.save", { draft });
  await rpc("draft.stage", { editor, sequence: 1, draft: { ...draft, text: "My follow-up" } });
  old.disconnect();
  const boot = (await rpc("bootstrap", { openEditor: crypto.randomUUID() })).value;
  assert.notEqual(boot.activeChat, id); assert.equal(boot.run.chatId, id); assert.equal(boot.run.draftChatId, boot.activeChat);
  assert.equal(f.data["composer:" + boot.activeChat].text, "My follow-up");
  assert.equal(f.data["composer:" + id].text, "Other editor");
  gate.resolve(); await run;
  assert.equal((await rpc("bootstrap")).value.activeChat, boot.activeChat);
  assert.equal(f.data["chat:" + id].messages.at(-1).text, "Hello");
});

test("a response that finishes between panels restores its saved branch after another editor changed the chat", { timeout: 3000 }, async () => {
  const gate = Promise.withResolvers(), pending = Promise.withResolvers();
  const { f, sender, dockToken } = await setup({ responseGate: { started: pending.resolve, promise: gate.promise } });
  const account = "account-a", generation = "session-a", id = crypto.randomUUID();
  const rpc = (type, extra = {}) => f.events.message({ type, tabId: 1, generation, dockToken, ...extra }, sender);
  const chat = { id, account, title: "Work", messages: [{ role: "user", text: "Work" }] };
  const saved = (await rpc("chat.save", { chat })).value;
  await rpc("draft.save", { draft: { id, account, text: "", contexts: [] } });
  const old = chatPort(f, () => {}, sender);
  const run = old({ type: "run", account, generation, chatId: id, model: "model-a", revision: saved.revision, messages: chat.messages, dockToken });
  await pending.promise; old.disconnect();
  await rpc("chat.save", { chat: { ...saved, title: "Edited independently" } });
  gate.resolve(); await run;
  const active = (await rpc("bootstrap")).value.activeChat;
  assert.ok(active && active !== id);
  assert.equal(f.data["chat:" + active].messages.at(-1).text, "Hello");
  assert.equal(f.data["chat:" + id].title, "Edited independently");
});
