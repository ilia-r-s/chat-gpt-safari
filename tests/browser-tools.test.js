import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools, readTab, readyTab } from "../extension/core/browser-tools.js";

function fixture(approval = async () => {}) {
  let url = "https://example.com/";
  const writes = [];
  const api = { tabs: {
    get: async id => ({ id, url, title: "Example" }), query: async () => [{ id: 1, url, title: "Example" }],
    create: async params => { writes.push(params); return { id: 2 }; },
    update: async (...params) => { writes.push(params); }, remove: async id => { writes.push(id); },
  }, scripting: { executeScript: async ({ func, args }) => func.name === "snapshotPage" ? [{ result: { url, title: "Example", text: "Page", elements: [{ id: "ref-1", label: "Submit" }] } }] : (writes.push(args), [{ result: { ok: true } }]) } };
  return { api, execute: createBrowserTools({ api, pageChars: 6000, approve: approval }), writes, navigate: value => { url = value; } };
}
const signal = new AbortController().signal;
test("Safari script-result errors retain the concrete read failure", async () => {
  const f = fixture();
  for (const error of [new Error("The page changed while reading."), "The page changed while reading."]) {
    f.api.scripting.executeScript = async () => [{ frameId: 0, error }];
    await assert.rejects(readTab(f.api, 1, 6000), /page changed while reading/);
  }
  f.api.scripting.executeScript = async () => [{ frameId: 0, error: {} }];
  await assert.rejects(readTab(f.api, 1, 6000), /Could not read this page/);
});
test("Safari action-result errors reach the caller and invalidate the old read", async () => {
  const f = fixture();
  await f.execute({ operation: "read", tabId: 1 }, signal);
  f.api.scripting.executeScript = async () => [{ frameId: 0, error: { message: "The gallery changed since approval. Read the page again." } }];
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /gallery changed since approval/);
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /Read the current page/);
});
test("page writes require a fresh read and explicit approval", async () => {
  const approvals = []; const f = fixture(async a => { approvals.push(a.operation); });
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /Read the current page/);
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal);
  assert.deepEqual(approvals, ["read", "click"]); assert.equal(f.writes.length, 1);
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /Read the current page/);
});
test("scroll and form-control actions require read, validation, and separate approvals", async () => {
  const approvals = []; const f = fixture(async a => { approvals.push(a); });
  await assert.rejects(f.execute({ operation: "scroll", tabId: 1, direction: "down" }, signal), /Read the current page/);
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await assert.rejects(f.execute({ operation: "scroll", tabId: 1, direction: "anywhere" }, signal), /valid scroll/);
  await f.execute({ operation: "scroll", tabId: 1, direction: "down" }, signal);
  assert.equal(f.writes.at(-1)[4].direction, "down");
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await f.execute({ operation: "select", tabId: 1, elementId: "ref-1", text: "Canada" }, signal);
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await assert.rejects(f.execute({ operation: "set_checked", tabId: 1, elementId: "ref-1", checked: "yes" }, signal), /boolean/);
  await f.execute({ operation: "set_checked", tabId: 1, elementId: "ref-1", checked: false }, signal);
  assert.deepEqual(approvals.map(a => a.operation), ["read", "scroll", "select", "set_checked"]);
  assert.match(approvals.at(-1).detail, /Uncheck/);
});
test("carousel approval names the gallery and refuses unsupported directions", async () => {
  const approvals = []; const f = fixture(async action => { approvals.push(action); });
  const original = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async args => args.func.name === "snapshotPage"
    ? [{ result: { url: "https://example.com/", elements: [{ id: "gallery", label: "Entertainment", actions: ["scroll"], kind: "carousel", directions: ["left", "right"] }] } }]
    : original(args);
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await assert.rejects(f.execute({ operation: "scroll", tabId: 1, elementId: "gallery", direction: "down" }, signal), /listed scroll directions/);
  assert.equal(approvals.length, 1);
  await f.execute({ operation: "scroll", tabId: 1, elementId: "gallery", direction: "right" }, signal);
  assert.equal(approvals.at(-1).title, "Move this gallery?");
  assert.match(approvals.at(-1).detail, /Entertainment.*\nAdvance gallery right/);
  assert.equal(f.writes.at(-1)[4].direction, "right");
});
test("the source page is the default target but still needs read and scroll approvals", async () => {
  const f = fixture(), approvals = [], reads = [];
  const get = f.api.tabs.get; f.api.tabs.get = async id => { reads.push(id); return get(id); };
  const execute = createBrowserTools({ api: f.api, pageChars: 6000, defaultTabId: 7, protectedTabId: 7, approve: async action => approvals.push(action.operation) });
  await assert.rejects(execute({ operation: "scroll", tabId: null, direction: "down" }, signal), /Read the current page/);
  assert.equal((await execute({ operation: "read", tabId: null }, signal)).tabId, 7);
  await execute({ operation: "scroll", tabId: null, elementId: null, direction: "down" }, signal);
  assert.deepEqual(approvals, ["read", "scroll"]); assert.ok(reads.every(id => id === 7));
  await assert.rejects(execute({ operation: "close_tab", tabId: null }, signal), /chat in its own tab/);
  assert.equal(f.writes.length, 1);
});
test("opening, visiting, and closing tabs each require approval and report the new tab ID", async () => {
  const approvals = []; const f = fixture(async a => { approvals.push(a.operation); });
  const opened = await f.execute({ operation: "open_tab", url: "https://other.example/start" }, signal);
  assert.equal(opened.tabId, 2);
  await f.execute({ operation: "navigate", tabId: 1, url: "https://other.example/next" }, signal);
  await f.execute({ operation: "close_tab", tabId: 1 }, signal);
  assert.deepEqual(approvals, ["open_tab", "navigate", "close_tab"]);
  assert.equal(f.writes.length, 3);
});
test("cancellation during approval prevents tab changes", async () => {
  const controller = new AbortController();
  const f = fixture(async () => controller.abort());
  await assert.rejects(f.execute({ operation: "close_tab", tabId: 1 }, controller.signal), { name: "AbortError" });
  assert.deepEqual(f.writes, []);
});
test("cancellation while rechecking an approved tab prevents the mutation", async () => {
  const controller = new AbortController();
  const f = fixture(); let reads = 0;
  const get = f.api.tabs.get;
  f.api.tabs.get = async id => { if (++reads === 2) controller.abort(); return get(id); };
  await assert.rejects(f.execute({ operation: "close_tab", tabId: 1 }, controller.signal), { name: "AbortError" });
  assert.equal(reads, 2); assert.deepEqual(f.writes, []);
});
test("embedded chat refuses to navigate or close its own tab", async () => {
  const f = fixture();
  const execute = createBrowserTools({ api: f.api, pageChars: 6000, approve: async () => { throw new Error("Approval should not be reached"); }, protectedTabId: 1 });
  for (const operation of ["navigate", "close_tab"]) await assert.rejects(execute({ operation, tabId: 1, url: "https://example.com/next" }, signal), /chat in its own tab/);
  assert.deepEqual(f.writes, []);
});
test("loading waits are event-driven and remove listeners on completion or cancellation", async () => {
  const updates = new Set(), removals = new Set();
  const api = { tabs: { get: async () => ({ id: 1, status: "loading" }), onUpdated: { addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn) }, onRemoved: { addListener: fn => removals.add(fn), removeListener: fn => removals.delete(fn) } } };
  const pending = readyTab(api, 1, signal); await new Promise(resolve => setImmediate(resolve));
  for (const fn of updates) fn(1, { status: "complete" }, { id: 1, status: "complete", url: "https://example.com/" });
  assert.equal((await pending).status, "complete"); assert.equal(updates.size, 0); assert.equal(removals.size, 0);
  const controller = new AbortController();
  const cancelled = readyTab(api, 1, controller.signal); await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(updates.size, 0); assert.equal(removals.size, 0);
});
test("declining an action prevents all browser mutations", async () => {
  const f = fixture(async () => { throw new Error("User declined"); });
  await assert.rejects(f.execute({ operation: "open_tab", url: "https://example.com" }, signal), /declined/);
  assert.equal(f.writes.length, 0);
});
test("navigation during an approval invalidates the action", async () => {
  let f; f = fixture(async a => { if (a.operation === "click") f.navigate("https://example.com/other"); });
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /navigated while awaiting/);
  assert.equal(f.writes.length, 0);
});
test("browser tools reject private schemes and arbitrary operations", async () => {
  const f = fixture();
  await assert.rejects(f.execute({ operation: "open_tab", url: "file:///secret" }, signal), /HTTP/);
  await assert.rejects(f.execute({ operation: "eval", text: "alert(1)" }, signal), /Unknown/);
  assert.equal(f.writes.length, 0);
});
test("tab URLs sent to the model omit query credentials", async () => {
  const f = fixture(); f.navigate("https://example.com/a?code=secret#fragment");
  const tabs = await f.execute({ operation: "list_tabs" }, signal);
  assert.equal(tabs[0].url, "https://example.com/a");
});
test("read consent is scoped to the website, not just a reusable tab ID", async () => {
  const approvals = []; const f = fixture(async action => { approvals.push(action.detail); });
  await f.execute({ operation: "read", tabId: 1 }, signal);
  f.navigate("https://another.example/");
  await f.execute({ operation: "read", tabId: 1 }, signal);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1], "https://another.example/");
});
