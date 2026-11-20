import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { readyTab } from "../extension/core/tab-navigation.js";
import { sitePermissionPattern } from "../extension/core/website-access.js";

const target = "https://finance.yahoo.com/quote/example";
const origin = new URL(target).origin;

test("a manually opened tab is counted while redacted and read by its original ID after website access", async () => {
  const signal = new AbortController().signal, queries = [], reads = [], prompts = [];
  const apple = { id: 10, windowId: 5, url: "https://www.apple.com/", title: "Apple", index: 0 };
  const yahoo = { id: 42, windowId: 5, url: "", title: "Hidden title must stay private", index: 1 };
  const tabs = [apple], access = { mode: "auto", allowed: [], blocked: ["blocked.example"] };
  const api = { tabs: { get: async id => tabs.find(tab => tab.id === id), query: async filter => { queries.push(filter); return tabs; } },
    scripting: { executeScript: async ({target, args}) => { reads.push(target.tabId); return [{result:{url:args[3],elements:[],text:"Yahoo fixture"}}]; } } };
  const run = createBrowserTools({ api, defaultTabId: apple.id, pageChars: 5000, readAccess: async () => access,
    requestTabAccess: async (id, label) => { prompts.push([id,label]); yahoo.url = "https://www.yahoo.com/?private=1"; yahoo.title = "Yahoo"; return "https://www.yahoo.com"; } });
  const list = () => run({operation:"list_tabs"},signal);
  assert.equal((await list()).length,1);
  tabs.push(yahoo,{id:43, url:"https://blocked.example/"},{id:44,url:"safari-web-extension://extension/panel.html"});
  assert.deepEqual((await list())[1],{tabId:42, title:"Tab 2", url:"", needsWebsiteAccess:true});
  assert.deepEqual(reads,[]); assert.deepEqual(prompts,[]);
  assert.equal((await run({operation:"read",tabId:42},signal)).text,"Yahoo fixture");
  assert.deepEqual(reads,[42]); assert.deepEqual(prompts,[[42,"Tab 2"]]);
  assert.deepEqual((await list())[1],{tabId:42,title:"Yahoo",url:"https://www.yahoo.com/"});
  assert.ok(queries.every(filter => filter.windowId === 5));
});

async function openDestination(mode = "auto") {
  const f = { url: "", granted: false, reads: [], prompts: [], opens: [], approvals: [], access: { mode, allowed: [], blocked: [] } };
  const controller = new AbortController();
  const api = { tabs: {
    get: async id => ({ id, windowId: 8, status: "complete", url: id === 1 ? "https://www.apple.com/" : f.url }),
    create: async options => { f.opens.push(options); return { id: 72 }; },
  }, permissions: { contains: async ({ origins }) => {
    assert.deepEqual(origins, ["https://finance.yahoo.com/*"]); return f.granted;
  } }, scripting: { executeScript: async ({ target: tab, args }) => {
    f.beforeCapture?.();
    assert.equal(tab.tabId, 72); assert.equal(args[3], f.url); f.reads.push(f.url);
    f.afterCapture?.();
    return [{ result: { url: f.url, elements: [], text: "Destination content" } }];
  } } };
  const execute = createBrowserTools({ api, pageChars: 12000, defaultTabId: 1,
    approve: async request => { f.approvals.push(request.operation); return "once"; },
    requestSiteAccess: async site => { f.prompts.push(site); if (f.onPrompt) return f.onPrompt(); f.granted = true; f.url = target; },
    readAccess: async () => f.access, verifySession: async () => { if (f.obsolete) throw Error("Account changed"); } });
  const opened = await execute({ operation: "open_tab", url: target }, controller.signal);
  f.read = () => execute({ operation: "read", tabId: opened.tabId }, controller.signal);
  f.controller = controller;
  return f;
}

test("reading a newly opened redacted tab obtains only its website grant and resumes the original read", async () => {
  for (const mode of ["auto", "ask"]) {
    const f = await openDestination(mode);
    assert.deepEqual(f.prompts, []); assert.deepEqual(f.reads, []);
    assert.equal((await f.read()).text, "Destination content");
    assert.equal((await f.read()).tabId, 72);
    assert.deepEqual(f.prompts, [origin]); assert.deepEqual(f.reads, [target, target]);
    assert.deepEqual(f.approvals, mode === "ask" ? ["open_tab"] : []);
    assert.deepEqual(f.opens, [{ url: target, active: false, windowId: 8 }]);
  }
});

test("a visible tab with temporary site access reads directly without a persistent permission request", async () => {
  const f = await openDestination();
  f.url = target;
  assert.equal((await f.read()).url, target); assert.deepEqual(f.prompts, []);
});

test("a browser reply alone cannot grant access, and denial is remembered for this run", async () => {
  for (const decline of [false, true]) {
    const f = await openDestination();
    f.onPrompt = () => { if (decline) throw Error("Declined"); };
    await assert.rejects(f.read(), /declined|did not grant/i);
    await assert.rejects(f.read(), /declined for this task/);
    f.url = target;
    await assert.rejects(f.read(), /declined for this task/);
    assert.deepEqual(f.reads, []); assert.deepEqual(f.prompts, [origin]); assert.equal(f.opens.length, 1);
  }
});

test("a visible URL with a refused injection recovers once and unrelated errors keep their own diagnosis", async () => {
  const f = await openDestination(); f.url = target;
  f.beforeCapture = () => { if (!f.granted) throw Error("The extension does not have access to this tab"); };
  assert.equal((await f.read()).text, "Destination content");
  assert.deepEqual(f.prompts, [origin]); assert.equal(f.opens.length, 1); assert.deepEqual(f.reads, [target]);
  const other = await openDestination(); other.url = target;
  other.beforeCapture = () => { throw Error("Document was unloaded"); };
  await assert.rejects(other.read(), /Document was unloaded/);
  assert.deepEqual(other.prompts, []); assert.deepEqual(other.reads, []);
});

test("revoking Safari access as the page is read discards the snapshot", async () => {
  const f = await openDestination();
  f.afterCapture = () => { f.granted = false; };
  await assert.rejects(f.read(), /Safari website permission changed/);
  assert.deepEqual(f.prompts, [origin]); assert.equal(f.opens.length, 1);
});

test("a redirect, a website block, a session change or a cancellation during the sheet prevents reading", async () => {
  for (const reason of ["redirect", "block", "account", "cancel"]) {
    const f = await openDestination();
    f.onPrompt = () => {
      f.granted = true; f.url = target;
      if (reason === "redirect") f.url = "https://another.example/";
      if (reason === "block") f.access.blocked.push("finance.yahoo.com");
      if (reason === "account") f.obsolete = true;
      if (reason === "cancel") f.controller.abort();
    };
    await assert.rejects(f.read(), /changed websites|blocked|Account changed|aborted/);
    assert.deepEqual(f.reads, []); assert.equal(f.opens.length, 1);
  }
  const f = await openDestination();
  f.access.blocked.push("finance.yahoo.com");
  await assert.rejects(f.read(), /blocked/);
  assert.deepEqual(f.prompts, []); assert.deepEqual(f.reads, []);
});

test("a newly granted URL can appear without a navigation event", { timeout: 1500 }, async () => {
  const f = await openDestination();
  f.onPrompt = () => { f.granted = true; setTimeout(() => { f.url = target; }, 20); };
  assert.equal((await f.read()).url, target);
  assert.deepEqual(f.prompts, [origin]);
});

test("a completion for about:blank cannot satisfy a pending destination read", async () => {
  const listeners = new Set(), installed = Promise.withResolvers();
  const init = { id: 72, status: "complete", url: "about:blank" };
  const api = { tabs: { get: async () => init, onUpdated: {
    addListener: listener => { listeners.add(listener); installed.resolve(); }, removeListener: listener => listeners.delete(listener),
  } } };
  const wait = readyTab(api, 72, new AbortController().signal, tab => tab.url === target);
  await installed.promise;
  for (const listener of listeners) listener(72, { status: "complete" }, init);
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener(72, { url: target }, { ...init, url: target });
  assert.equal((await wait).url, target); assert.equal(listeners.size, 0);
});

test("Safari match patterns contain only an exact web scheme and hostname", () => {
  for (const bad of ["<all_urls>", "https://*/*", "https://*.yahoo.com/", "file:///secret", "https://user:secret@example.com/"]) {
    assert.equal(sitePermissionPattern(bad), null);
  }
  assert.equal(sitePermissionPattern("https://finance.yahoo.com:8443/path?key=private"), "https://finance.yahoo.com/*");
  assert.equal(sitePermissionPattern("http://[::1]:8000/"), "http://[::1]/*");
});
