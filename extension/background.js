import { buildInput, publicURL, safeWebURL } from "./core/context.js";
import { normalizeSettings } from "./core/config.js";
import { settings, saveChat, listChats, chatKey } from "./core/storage.js";
import { readTab, createBrowserTools } from "./core/browser-tools.js";
import { runAgent } from "./core/agent.js";
import { LocalData } from "./core/local-data.js";
import { draftKey, sessionKey, saveDraft } from "./core/drafts.js";
import { DesktopController } from "./core/desktop.js";
import { modelCatalog, resolveEffort } from "./core/models.js";

const api = browser;
const panelURL = api.runtime.getURL("panel/panel.html");
const activeRuns = new Map();
const dockedTabs = new Map();
const localData = new LocalData(api.storage.local);
const modelRequests = new Set();
let cleanupTask;
let catalogCache;
let nativePort;
let accountNotice = 0;
const desktop = new DesktopController({
  api, preferences: () => settings(api.storage.local), isClosed: () => localData.closed,
  verify: async sessionId => native("desktop.verify", { sessionId }),
  reply: async payload => native("desktop.reply", { payload }),
});

async function notifyAccountChange() {
  if (localData.closed) return;
  const notice = ++accountNotice;
  const auth = await native("auth.status").catch(() => ({}));
  if (notice !== accountNotice || localData.closed) return;
  catalogCache = null;
  for (const run of activeRuns.values()) {
    if (!auth.generation || run.generation !== auth.generation) run.abort(new Error("The selected account changed."));
  }
  for (const request of modelRequests) if (request.generation !== auth.generation) request.abort();
  const cancelled = desktop.cancelAll();
  await api.runtime.sendMessage({ type: "auth.changed", generation: auth.generation }).catch(() => {});
  await cancelled;
}

function connectNativeEvents() {
  if (nativePort || localData.closed || !api.runtime.connectNative) return;
  try {
    const port = api.runtime.connectNative("org.safarichat.app"); nativePort = port;
    port.onDisconnect.addListener(() => { if (nativePort === port) nativePort = null; desktop.cancelAll().catch(() => {}); });
    port.onMessage.addListener(message => {
      const payload = message?.userInfo ?? message?.message ?? message;
      if (payload?.type === "auth.changed") {
        if (payload.error) api.runtime.sendMessage({ type: "auth.changed", error: payload.error }).catch(() => {});
        else notifyAccountChange().catch(() => {});
      }
      else if (payload?.type === "desktop.request") desktop.handle(payload).catch(() => {});
    });
  } catch { nativePort = null; } // Temporary extensions have no native bridge.
}
connectNativeEvents();

function isPanel(sender) {
  return sender.id === api.runtime.id && typeof sender.url === "string" && sender.url.split(/[?#]/)[0] === panelURL;
}

async function native(type, extra = {}) {
  let response;
  try { response = await api.runtime.sendNativeMessage("org.safarichat.app", { type, ...extra }); }
  catch { throw new Error("The Safari Chat companion app is unavailable. A temporary extension can preview the interface, but connecting an account requires the packaged Safari Chat app and its extension."); }
  if (!response?.ok) throw new Error(response?.error || "The companion app could not complete this request.");
  return response;
}

function checkSession(auth, account, generation) {
  if (!generation || generation !== auth.generation || account !== auth.account) throw new Error("Your account changed. Refresh the panel before continuing.");
  return auth;
}

async function credential(auth) {
  const result = await native("auth.credential", { generation: auth.generation });
  checkSession(result, auth.account, auth.generation);
  return result.token;
}

async function models(auth) {
  if (localData.closed) throw new Error("Local data is being erased.");
  if (catalogCache?.generation === auth.generation && catalogCache.expires > Date.now()) return catalogCache.models;
  const token = await credential(auth);
  if (localData.closed) throw new Error("Local data is being erased.");
  const controller = new AbortController();
  controller.generation = auth.generation;
  modelRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
  const response = await fetch("https://api.openai.com/v1/models", { credentials: "omit", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  if (!response.ok) throw new Error(`Could not load models (HTTP ${response.status}). Check your connection and account access.`);
  const data = await response.json();
  if (localData.closed) throw new Error("Local data is being erased.");
  const values = modelCatalog(data);
  controller.signal.throwIfAborted();
  catalogCache = { generation: auth.generation, models: values, expires: Date.now() + 300000 };
  return values;
  } finally { clearTimeout(timer); modelRequests.delete(controller); }
}

async function eraseLocalData() {
  localData.stop();
  dockedTabs.clear();
  catalogCache = null;
  for (const run of activeRuns.values()) run.abort();
  for (const request of modelRequests) request.abort();
  await desktop.cancelAll();
  nativePort?.disconnect(); nativePort = null;
  // Every open panel drops in-memory chat, input, and attachments before cancellation finishes.
  await api.runtime.sendMessage({ type: "data.erasing" }).catch(() => {});
  const failures = [];
  let browserCleared = false;
  let nativeCleared = false;
  try { await localData.clear(); browserCleared = true; } catch (error) { failures.push(error.message); }
  try { await native("data.erase"); nativeCleared = true; } catch (error) { failures.push(error.message); }
  try { await api.contextMenus.removeAll(); } catch (error) { failures.push(`Could not remove the context menu: ${error.message}`); }
  return { browserCleared, nativeCleared, failures };
}

async function mountPanel(tabId, url) {
  await api.scripting.executeScript({ target: { tabId }, files: ["content/mount.js"] });
  return api.tabs.sendMessage(tabId, { type: "panel.show", url });
}

async function showPanel(tab, share = false, selection = "") {
  if (!Number.isInteger(tab?.id)) return;
  if (share && !localData.closed) {
    try {
      const auth = await native("auth.status");
      const limit = (await settings(api.storage.local)).pageChars;
      const page = selection ? { text: selection, title: tab.title, url: tab.url } : await readTab(api, tab.id, limit, { expectedURL: tab.url });
      if (!safeWebURL(tab.url) || safeWebURL(page.url) !== safeWebURL(tab.url)) throw new Error("The page changed. Choose Ask Safari Chat on the page you want to share.");
      await localData.write(async storage => {
        checkSession(await native("auth.status"), auth.account, auth.generation);
        const kind = selection ? "selection" : "page", url = publicURL(page.url);
        await storage.set({ [`draft:${tab.id}`]: { kind, key: `${kind}:${tab.id}:${url}`, tabId: tab.id, text: page.text.slice(0, limit), title: page.title ?? "Page", url, truncated: !!page.truncated || page.text.length > limit, generation: auth.generation, created: Date.now() } });
      });
    } catch (error) {
      if (!localData.closed) await localData.write(storage => storage.set({ [`draft:${tab.id}`]: { error: error.message, created: Date.now() } }));
    }
  }
  const url = `${panelURL}?tab=${tab.id}`;
  try {
    const result = await mountPanel(tab.id, url);
    if (result?.standalone) await api.tabs.create({ url });
    else if (result?.ok && !localData.closed) dockedTabs.set(tab.id, url);
  } catch { await api.tabs.create({ url }); }
  if (share) await api.runtime.sendMessage({ type: "context.available", tabId: tab.id }).catch(() => {});
}

api.action.onClicked.addListener(tab => showPanel(tab).catch(console.error));
api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll().then(() => {
    api.contextMenus.create({ id: "ask", title: "Ask Safari Chat", contexts: ["selection", "page"] });
  }).catch(console.error);
});
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask") return showPanel(tab, true, info.selectionText).catch(console.error);
});
api.tabs.onRemoved.addListener(tabId => { dockedTabs.delete(tabId); api.storage.local.remove(`draft:${tabId}`).catch(() => {}); });
api.tabs.onUpdated?.addListener(async (tabId, change, tab) => {
  const url = dockedTabs.get(tabId);
  if (!url || localData.closed || change.status !== "complete" || !safeWebURL(tab.url)) return;
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ["content/mount.js"] });
    if (dockedTabs.get(tabId) === url && !localData.closed) await api.tabs.sendMessage(tabId, { type: "panel.show", url, restore: true });
  } catch { /* Safari can withhold website access on the new page. */ }
});

async function handleMessage(message, sender) {
  if (!isPanel(sender)) throw new Error("Untrusted extension message.");
  if (message.type === "data.erase") {
    if (!cleanupTask) cleanupTask = eraseLocalData().finally(() => { cleanupTask = null; });
    return cleanupTask;
  }
  if (localData.closed && !["bootstrap", "auth.open", "panel.close"].includes(message.type)) throw new Error("Local data was erased. Close the extension before removing the app.");
  switch (message.type) {
    case "bootstrap": {
      connectNativeEvents();
      if (localData.closed) return { prefs: normalizeSettings(), auth: { connected: false, account: "local" }, models: [], removalPrepared: true };
      const prefs = await settings(api.storage.local);
      let auth;
      try { auth = await native("auth.status"); } catch (error) { auth = { connected: false, error: error.message }; }
      let catalog = [];
      let modelError;
      if (auth.connected && auth.canInfer) try { catalog = await models(auth); } catch (error) { modelError = error.message; }
      const pointer = sessionKey(auth.account ?? "local", message.tabId);
      const session = (await api.storage.local.get(pointer))[pointer];
      const key = `draft:${message.tabId}`;
      const hasContext = Number.isInteger(message.tabId) && !!(await api.storage.local.get(key))[key];
      return { prefs, auth, models: catalog, modelError, activeChat: session?.id, hasContext };
    }
    case "settings.save": {
      let prefs;
      await localData.write(async storage => {
        const before = await settings(storage);
        prefs = normalizeSettings({ ...before, ...message.settings });
        if (before.desktopControl !== prefs.desktopControl) {
          await desktop.cancelAll(); await native("desktop.enable", { enabled: prefs.desktopControl });
        }
        await storage.set({ settings: prefs });
      });
      return prefs;
    }
    case "auth.open": await native("app.open"); return { ok: true };
    case "auth.check": return { generation: (await native("auth.status")).generation };
    case "auth.signin": await native("auth.signin"); return { ok: true };
    case "auth.signout": {
      const result = await native("auth.signout", { generation: message.generation });
      await notifyAccountChange(); return result;
    }
    case "context.take": return localData.write(async storage => {
      if (!Number.isInteger(message.tabId)) return null;
      const key = `draft:${message.tabId}`, item = (await storage.get(key))[key];
      if (!item) return null;
      if (!item.error) checkSession(await native("auth.status"), message.account, message.generation);
      await storage.remove(key);
      if (item.created <= Date.now() - 300000 || (!item.error && item.generation !== message.generation)) return null;
      const { created, generation, ...source } = item;
      return source;
    });
    case "context.read": {
      const prefs = await settings(api.storage.local);
      const page = await readTab(api, message.tabId, prefs.pageChars, { selectionOnly: message.selection === true });
      if (message.selection && !page.selection) throw new Error("Select a passage on the page first.");
      return { kind: message.selection ? "selection" : "page", key: `${message.selection ? "selection" : "page"}:${message.tabId}:${publicURL(page.url)}`, tabId: message.tabId, title: page.title, url: publicURL(page.url), text: message.selection ? page.selection : page.text, truncated: page.truncated };
    }
    case "tabs.list": return (await api.tabs.query({ currentWindow: true })).filter(tab => safeWebURL(tab.url)).slice(0, 200).map(tab => ({ id: tab.id, title: (tab.title ?? "Untitled").slice(0, 160), url: publicURL(tab.url) }));
    case "chats.list": { const auth = await native("auth.status"); checkSession(auth, auth.account, message.generation); return listChats(api.storage.local, auth.account); }
    case "chat.load": {
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const data = (await api.storage.local.get(chatKey(message.id)))[chatKey(message.id)];
      if (data && data.account !== (auth.account ?? "local")) throw new Error("This chat belongs to a different account.");
      return data && { ...data, revision: data.revision ?? 1 };
    }
    case "draft.load": {
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const data = (await api.storage.local.get(draftKey(message.id)))[draftKey(message.id)];
      if (data && data.account !== (auth.account ?? "local")) throw new Error("This draft belongs to a different account.");
      return data && { ...data, revision: data.revision ?? 1 };
    }
    case "draft.save": return localData.write(async storage => {
      const auth = await native("auth.status");
      checkSession(auth, message.draft.account, message.generation);
      if (typeof message.draft.id !== "string" || !/^[a-f0-9-]{36}$/i.test(message.draft.id)) throw new Error("Invalid draft identifier.");
      return saveDraft(storage, message.draft, message.tabId);
    });
    case "chat.save": {
      return localData.write(async storage => {
        checkSession(await native("auth.status"), message.chat.account, message.generation);
        return saveChat(storage, message.chat);
      });
    }
    case "chat.delete": {
      return localData.write(async storage => {
        const auth = await native("auth.status");
        checkSession(auth, auth.account, message.generation);
        const all = await storage.get(null);
        const data = all[chatKey(message.id)] ?? all[draftKey(message.id)];
        if (data && data.account !== (auth.account ?? "local")) throw new Error("This chat belongs to a different account.");
        const pointers = Object.entries(all).filter(([key, value]) => key.startsWith("panel:") && value.account === (auth.account ?? "local") && value.id === message.id).map(([key]) => key);
        await storage.remove([chatKey(message.id), draftKey(message.id), ...pointers]); return { ok: true };
      });
    }
    case "panel.close": if (sender.tab?.id) { dockedTabs.delete(sender.tab.id); await api.tabs.sendMessage(sender.tab.id, { type: "panel.close" }).catch(() => {}); } return { ok: true };
    case "panel.popout": {
      const url = new URL(panelURL);
      if (Number.isInteger(message.tabId)) url.searchParams.set("tab", message.tabId);
      if (typeof message.chatId === "string" && /^[a-f0-9-]{36}$/i.test(message.chatId)) url.searchParams.set("chat", message.chatId);
      await api.tabs.create({ url: url.href }); return { ok: true };
    }
    default: throw new Error("Unknown extension request.");
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (!isPanel(sender)) return;
  return handleMessage(message, sender).then(value => ({ ok: true, value })).catch(error => ({ ok: false, error: error.message }));
});

api.runtime.onConnect.addListener(port => {
  if (port.name !== "chat" || !isPanel(port.sender)) { port.disconnect(); return; }
  let controller;
  let approval;
  let busy = false;
  const emit = event => { try { port.postMessage(event); } catch { controller?.abort(); } };
  port.onDisconnect.addListener(() => { controller?.abort(); approval?.reject(new Error("Panel closed.")); activeRuns.delete(port); });
  port.onMessage.addListener(async message => {
    if (localData.closed) { emit({ type: "data.erasing" }); return; }
    if (message.type === "cancel") { controller?.abort(); return; }
    if (message.type === "approval") {
      if (approval && approval.id === message.id) {
        const pending = approval; approval = null;
        message.allow ? pending.resolve() : pending.reject(new Error("The user declined this action. Do not retry it."));
      }
      return;
    }
    if (message.type !== "run" || busy) return;
    busy = true;
    controller = new AbortController();
    controller.generation = message.generation;
    activeRuns.set(port, controller);
    // A finite deadline also bounds abandoned network reads and approval prompts.
    const timer = setTimeout(() => controller.abort(new Error("This task timed out. Please try again.")), 300000);
    let runChat;
    let partialText = "";
    let writing = false;
    const started = Date.now();
    let usedTools = false, workMs;
    const verifySession = async () => checkSession(await native("auth.status"), message.account, message.generation);
    const finish = (text, error = false) => localData.write(async storage => {
      await verifySession();
      const saved = await saveChat(storage, { ...runChat, messages: [...runChat.messages, { role: "assistant", text, workMs, ...(error ? { error: true } : {}) }] });
      return { id: saved.id, title: saved.title, revision: saved.revision };
    });
    const runEmit = event => { controller.signal.throwIfAborted(); if (event.type === "activity") usedTools = true; if (event.type === "delta") partialText += event.text; else if (event.type === "replace") partialText = event.text; emit(event); };
    try {
      const auth = await verifySession();
      if (!auth.connected || !auth.canInfer) throw new Error("Connect ChatGPT plan usage or an API key in the companion app first.");
      if (typeof message.chatId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.chatId)) throw new Error("Invalid chat identifier. Start a new chat.");
      runChat = { id: message.chatId, revision: message.revision, title: String(message.title || "New chat"), account: auth.account, messages: message.messages };
      const prefs = { ...await settings(api.storage.local), webSearch: message.webSearch === true };
      controller.signal.throwIfAborted();
      const requestedEffort = message.effort ?? "auto";
      const selectedModel = requestedEffort === "auto" ? undefined : (await models(auth)).find(model => model.id === message.model);
      const effort = resolveEffort(selectedModel, requestedEffort);
      const built = buildInput(message.messages.filter(m => !m.error), prefs);
      emit({ type: "context", chars: built.chars, trimmed: built.trimmed });
      const approve = (details, signal) => new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const id = crypto.randomUUID();
        const abort = () => { if (approval?.id === id) approval = null; reject(signal.reason); };
        const finish = callback => value => { signal.removeEventListener("abort", abort); callback(value); };
        approval = { id, resolve: finish(resolve), reject: finish(reject) };
        signal.addEventListener("abort", abort, { once: true });
        emit({ type: "approval", id, ...details });
      });
      const initialTabs = (message.messages.at(-1)?.contexts ?? []).map(c => ({ id: c.tabId, url: c.url }));
      const source = new URL(port.sender.url).searchParams.get("tab");
      const defaultTabId = source !== null && /^\d+$/.test(source) ? Number(source) : null;
      const executeTool = createBrowserTools({ api, pageChars: prefs.pageChars, approve, verifySession: async () => {
        try { await verifySession(); } catch (error) { controller.abort(error); throw error; }
      }, initialTabs, defaultTabId, protectedTabId: message.embedded ? port.sender.tab?.id : null });
      const result = await runAgent({ input: built.input, model: message.model, effort, settings: prefs, signal: controller.signal }, { credential: () => credential(auth), executeTool, emit: runEmit });
      controller.signal.throwIfAborted();
      writing = true;
      workMs = usedTools ? Date.now() - started : undefined;
      emit({ type: "done", workMs, usage: result.usage, saved: await finish(result.text) });
    } catch (error) {
      let saved, saveError;
      if (runChat && !localData.closed && !writing) {
        try { saved = await finish(partialText || (controller.signal.aborted ? "Response stopped." : "No response received."), true); }
        catch (failure) { saveError = failure.message; }
      }
      emit({ type: controller.signal.aborted ? "cancelled" : "error", saved, saveError: saveError || (writing ? error.message : undefined), message: (controller.signal.aborted ? controller.signal.reason?.message : error?.message) ?? "The request could not finish." });
    } finally {
      clearTimeout(timer); busy = false; approval = null; activeRuns.delete(port);
    }
  });
});
