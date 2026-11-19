import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

export async function fixture({ nativeFailure = false, nativeUnavailable = false, launchFailure = false, responseGate, toolRequest, responseForRequest, scriptEncoding = "utf-8" } = {}) {
  const events = {};
  const data = {};
  const nativeRequests = [];
  const requests = [];
  const createdTabs = [];
  const createdWindows = [];
  const badges = new Map(), titles = new Map();
  const windows = new Map([[4, { id: 4, left: 40, top: 30, width: 1440, height: 900, state: "normal" }]]);
  const panelTabs = new Map();
  const session = {};
  let account = "account-a", generation = "session-a";
  const listen = name => {
    const listeners = new Set();
    events[name] = (...args) => {
      const results = [...listeners].map(listener => listener(...args));
      return results.length > 1 ? Promise.all(results) : results[0];
    };
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
  };
  const api = {
    runtime: { id: "test-extension", getURL: file => `safari-web-extension://test/${file}`,
      sendMessage: async () => {},
      connectNative: () => ({ onMessage: listen("nativeEvent"), onDisconnect: listen("nativeDisconnect"), disconnect() {} }),
      onMessage: listen("message"), onConnect: listen("connect"), onInstalled: listen("installed"),
      sendNativeMessage: async (_, message) => {
        nativeRequests.push(message.type);
        if (nativeUnavailable) throw new Error("No native app for temporary extension");
        if (["app.open", "auth.signin", "auth.apikey"].includes(message.type)) return launchFailure ? { ok: false, error: "macOS could not open Safari Chat" } : { ok: true };
        if (message.type === "data.erase") return nativeFailure ? { ok: false, error: "Keychain is locked" } : { ok: true };
        return message.type === "auth.credential" ? { ok: true, token: "mock-private-token", account, generation }
          : { ok: true, connected: true, canInfer: true, account, generation, label: "Account A" };
      },
    }, action: { onClicked: listen("action"),
      setBadgeText: async ({ tabId, text }) => badges.set(tabId, text),
      setTitle: async ({ tabId, title }) => titles.set(tabId, title),
    }, tabs: {
      onRemoved: listen("removed"), onUpdated: listen("updated"),
      get: async id => panelTabs.get(id) ?? { id, windowId: 4, url: "https://example.com/" },
      update: async (id, options) => Object.assign(await api.tabs.get(id), options),
      sendMessage: async () => ({ ok: true }),
      query: async () => [], create: async options => { createdTabs.push(options); const tab = { ...options, id: 1 + createdTabs.length }; panelTabs.set(tab.id, tab); return tab; },
      remove: async id => { panelTabs.delete(id); await events.removed(id); },
    },
    windows: {
      onRemoved: listen("windowRemoved"),
      get: async id => { if (!windows.has(id)) throw Error("Window closed"); return { ...windows.get(id) }; },
      create: async options => {
        const id = 10 + createdWindows.length, tab = { id: 100 + id, windowId: id, url: options.url };
        const win = { state: "normal", ...options, id, tabs: [tab] };
        windows.set(id, win); panelTabs.set(tab.id, tab); createdWindows.push(win); return { ...win };
      },
      update: async (id, options) => Object.assign(windows.get(id), options),
    },
    contextMenus: { onClicked: listen("menu"), removeAll: async () => {}, create() {} },
    storage: { local: { get: async key => key === null ? data : { [key]: data[key] }, set: async value => Object.assign(data, value), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, clear: async () => { for (const key of Object.keys(data)) delete data[key]; } },
      session: { get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(session[k])])), set: async items => Object.assign(session, structuredClone(items)), remove: async key => { delete session[key]; } } },
  };
  const context = vm.createContext({ browser: api, console, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: webcrypto, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ models: [{ visibility: "list", slug: "model-a", display_name: "Model A", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] }));
      requests.push(JSON.parse(options.body));
      if (responseGate) { responseGate.started(); await responseGate.promise; }
      const response = responseForRequest?.(requests.length);
      if (response) return response;
      const action = Array.isArray(toolRequest) ? toolRequest[requests.length - 1] : requests.length === 1 && toolRequest;
      if (action) {
        const call = { type: "function_call", name: "browser", call_id: "1", arguments: JSON.stringify(action) };
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [call] } })}\n\n`);
      }
      return new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
    },
  });
  vm.runInContext(new TextDecoder(scriptEncoding).decode(await readFile("extension/background.bundle.js")), context);
  const sender = { id: "test-extension", url: "safari-web-extension://test/panel/panel.html?tab=1" };
  return { api, events, data, nativeRequests, requests, createdTabs, createdWindows, badges, titles, session, sender, setAccount: (value, session = value === "account-a" ? "session-a" : "session-b") => { account = value; generation = session; } };
}
export function chatPort(f, emit, sender = f.sender) {
  let receive, disconnect;
  f.events.connect({ name: "chat", sender, onMessage: { addListener: fn => { receive = fn; } },
    onDisconnect: { addListener: fn => { disconnect = fn; } }, postMessage: emit, disconnect() {} });
  receive.disconnect = () => disconnect?.();
  return receive;
}
