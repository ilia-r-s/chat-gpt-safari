import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";

function fixture(approval = async () => {}) {
  let url = "https://example.com/";
  const writes = [];
  const api = { tabs: {
    get: async id => ({ id, url, title: "Example" }), query: async () => [{ id: 1, url, title: "Example" }],
    create: async params => { writes.push(params); return { id: 2 }; },
    update: async (...params) => { writes.push(params); }, remove: async id => { writes.push(id); },
  }, scripting: { executeScript: async ({ args }) => args.length === 1 ? [{ result: { url, title: "Example", text: "Page", elements: [{ id: "ref-1", label: "Submit" }] } }] : (writes.push(args), [{ result: { ok: true } }]) } };
  return { execute: createBrowserTools({ api, pageChars: 6000, approve: approval }), writes, navigate: value => { url = value; } };
}
const signal = new AbortController().signal;
test("page writes require a fresh read and explicit approval", async () => {
  const approvals = []; const f = fixture(async a => { approvals.push(a.operation); });
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /Read the current page/);
  await f.execute({ operation: "read", tabId: 1 }, signal);
  await f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal);
  assert.deepEqual(approvals, ["read", "click"]); assert.equal(f.writes.length, 1);
  await assert.rejects(f.execute({ operation: "click", tabId: 1, elementId: "ref-1" }, signal), /Read the current page/);
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
