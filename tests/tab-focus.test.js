import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { TabFocus, waitForVisiblePage } from "../extension/core/tab-focus.js";

function fixture() {
  const records = [1,2,3,4].map(id => ({ id, title: "Tab " + id, url: "https://site" + id + ".example/", windowId: id === 4 ? 2 : 1, active: id === 1 || id === 4 }));
  const get = async id => ({ ...records[id - 1] });
  const selected = [];
  const update = async (id, change) => {
    assert.deepEqual(change, { active: true });
    selected.push(id);
    for (const tab of records) if (tab.windowId === records[id - 1].windowId) tab.active = tab.id === id;
    return get(id);
  };
  const tabs = { get, update, query: async ({ windowId }) => records.filter(tab => tab.windowId === windowId && tab.active) };
  const api = { tabs, scripting: { executeScript: async () => { throw Error("Unexpected page read"); } } };
  return { api, focus: new TabFocus(api, 1), records, selected };
}
const verify = async () => {}, signal = new AbortController().signal;

test("switching authorizes the target, selects without a page read, and leaves an explicitly selected tab open", async () => {
  const { api, focus, records, selected } = fixture();
  const grants = [];
  const execute = createBrowserTools({ api, tabFocus: focus, defaultTabId: 1, approve: async details => { grants.push(details); return "once"; } });
  const result = await execute({ operation: "switch_tab", tabId: 2 }, signal);
  assert.equal(result.active, true); assert.deepEqual(grants[0].hosts, ["site2.example"]);
  await focus.returnSelection(false, verify);
  assert.deepEqual(selected, [2]);
  const switching = { operation: "switch_tab", tabId: 3 };
  const denied = createBrowserTools({ api, defaultTabId: 1, approve: async () => { throw Error("Declined"); } });
  await assert.rejects(denied(switching, signal), /Declined/);
  const blocked = createBrowserTools({ api, defaultTabId: 1, readAccess: async () => ({ mode:"auto", blocked:["site3.example"], allowed:[] }) });
  await assert.rejects(blocked(switching, signal), /blocked/);
  const redirect = createBrowserTools({ api, defaultTabId: 1, approve: async () => { records[2].url += "new"; } });
  await assert.rejects(redirect(switching, signal), /navigated/);
  await assert.rejects(execute({ operation: "switch_tab", tabId: 4 }, signal), /same Safari window/);
  records[2].url = undefined;
  await assert.rejects(execute(switching, signal), /Read the tab/);
  assert.deepEqual(selected, [2]);
});

test("temporary selections return for approval or completion and respect a manual tab change", async () => {
  const { focus, records, api, selected } = fixture();
  await focus.show(2, records[1].url, verify, true);
  await focus.show(3, records[2].url, verify, true);
  await focus.returnSelection(false, verify);
  assert.deepEqual(selected, [2,3,1]);
  await focus.show(2, records[1].url, verify);
  await focus.returnSelection(true, verify);
  assert.deepEqual(selected.slice(-2), [2,1]);
  await focus.show(2, records[1].url, verify, true);
  await api.tabs.update(3, { active: true });
  await focus.returnSelection(true, verify);
  assert.equal((await api.tabs.get(3)).active, true);
  await assert.rejects(focus.show(2, records[1].url, async () => { throw Error("Signed out"); }), /Signed out/);
  assert.equal((await api.tabs.get(3)).active, true);
  await focus.show(2, records[1].url, verify, true);
  await focus.returnSelection(false, async () => { await api.tabs.update(1, { active:true }); });
  assert.equal((await api.tabs.get(1)).active, true, "preserve a tab chosen while the account check was pending");
});

test("foreground motion waits for visibility and stops before input if the user switches or the document changes", async () => {
  const { api, records } = fixture();
  let probes = 0;
  api.scripting.executeScript = async () => [{ result: ++probes === 1 ? "hidden" : "visible" }];
  await waitForVisiblePage(api, 1, records[0].url, signal);
  assert.equal(probes, 2);
  api.scripting.executeScript = async () => [{ result: "hidden" }];
  await assert.rejects(waitForVisiblePage(api, 2, records[1].url, signal), /Another tab/);
  api.scripting.executeScript = async () => [{ result: "changed" }];
  await assert.rejects(waitForVisiblePage(api, 1, records[0].url, signal), /changed/);
  const tools = createBrowserTools({ api, defaultTabId: 1, motionSession: { last: { tabId: 2, reason: "tab hidden" } } });
  await assert.rejects(tools({ operation: "drag", tabId: 2 }, signal), /Leave it stopped/);
});
