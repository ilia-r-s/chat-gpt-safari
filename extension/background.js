import { buildInput, publicURL, safeWebURL } from "./core/context.js";
import { normalizeSettings } from "./core/config.js";
import { settings, saveChat, listChats, chatKey } from "./core/storage.js";
import { readTab, createBrowserTools, indicatePageAction, sourceWindowId } from "./core/browser-tools.js";
import { TabFocus } from "./core/tab-focus.js";
import { ChatDock, sourceTabId } from "./core/chat-dock.js";
import { ChatRun } from "./core/chat-run.js";
import { FrameDrafts } from "./core/frame-drafts.js";
import { runAgent } from "./core/agent.js";
import { PageInputs } from "./core/page-input.js";
import { MotionSession } from "./core/motion-session.js";
import { LocalData } from "./core/local-data.js";
import { draftKey, sessionKey, saveDraft } from "./core/drafts.js";
import { DesktopController } from "./core/desktop.js";
import { chatFamilies, modelCatalog, resolveEffort } from "./core/models.js";
import { TemporaryChats } from "./core/temporary-chats.js";
import { readyTab } from "./core/tab-navigation.js";
import { accessKey, allowsAction, changeWebsiteAccess, listedTabs, readWebsiteAccess, visibleWebsite } from "./core/website-access.js";

const api = browser;
const panelURL = api.runtime.getURL("panel/panel.html");
const activeRuns = new Map();
const dock = new ChatDock(api, panelURL);
const recentResults = new Map();
const frameDrafts = new FrameDrafts();
const temporaryChats = new TemporaryChats();
const localData = new LocalData(api.storage.local);
const modelRequests = new Map();
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
  recentResults.clear();
  for (const run of activeRuns.values()) {
    if (!auth.generation || run.generation !== auth.generation) run.abort(new Error("The selected account changed."));
  }
  frameDrafts.changeSession(auth.generation);
  temporaryChats.changeAccount(auth.generation);
  for (const [generation, request] of modelRequests) if (generation !== auth.generation) request.controller.abort();
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
  return sender.id === api.runtime.id && dock.panelURLMatches(sender.url);
}

function ownedRun(sender, account, generation, chatId) {
  const source = sourceTabId(sender);
  return [...activeRuns.values()].find(run => run.matches(source, sender.tab?.id, account, generation) && (!chatId || run.chat.id === chatId));
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

function saveWebsiteAccess(account, generation, change, signal, hosts = []) {
  return localData.write(async storage => {
    const access = await readWebsiteAccess(storage, account);
    allowsAction(access, hosts); // An inline approval cannot override a newly blocked host.
    const updated = changeWebsiteAccess(access, change);
    const auth = checkSession(await native("auth.status"), account, generation);
    if (!auth.connected) throw new Error("Connect an account to manage website access.");
    signal?.throwIfAborted();
    await storage.set({ [accessKey(account)]: updated });
    return updated;
  });
}

async function checkCapture(account, url) {
  const safe = safeWebURL(url);
  if (!safe) throw new Error("Safari protects this page. Choose an accessible website.");
  // Picking a source explicitly authorizes the excerpt, subject to saved blocks.
  const access = await readWebsiteAccess(api.storage.local, account);
  allowsAction(access, [new URL(safe).hostname]);
  return access;
}

async function credential(auth) {
  const result = await native("auth.credential", { generation: auth.generation });
  checkSession(result, auth.account, auth.generation);
  return result.token;
}

async function models(auth, refresh = false) {
  if (localData.closed) throw new Error("Local data is being erased.");
  const pending = modelRequests.get(auth.generation);
  if (pending && !pending.controller.signal.aborted) return pending.task;
  if (!refresh && catalogCache?.generation === auth.generation && catalogCache.expires > Date.now()) return catalogCache.models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const task = (async () => {
    const token = await credential(auth);
    checkSession(await native("auth.status"), auth.account, auth.generation);
    controller.signal.throwIfAborted();
    const response = await fetch("https://api.openai.com/v1/models", { credentials: "omit", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load models (HTTP ${response.status}). Check your connection and account access.`);
    const values = modelCatalog(await response.json());
    checkSession(await native("auth.status"), auth.account, auth.generation);
    controller.signal.throwIfAborted();
    if (localData.closed) throw new Error("Local data is being erased.");
    catalogCache = values.length ? { generation: auth.generation, models: values, expires: Date.now() + 300000 } : null;
    return values;
  })();
  modelRequests.set(auth.generation, { controller, task });
  try { return await task; } finally {
    clearTimeout(timer);
    if (modelRequests.get(auth.generation)?.task === task) modelRequests.delete(auth.generation);
  }
}

async function eraseLocalData() {
  localData.stop();
  frameDrafts.clear();
  temporaryChats.tabs.clear();
  catalogCache = null;
  recentResults.clear();
  for (const run of activeRuns.values()) run.abort();
  for (const request of modelRequests.values()) request.controller.abort();
  await desktop.cancelAll();
  nativePort?.disconnect(); nativePort = null;
  // Every open panel drops in-memory chat, input, and attachments before cancellation finishes.
  await api.runtime.sendMessage({ type: "data.erasing" }).catch(() => {});
  const failures = [];
  let browserCleared = false;
  let nativeCleared = false;
  try { await dock.clear(); } catch (error) { failures.push(error.message); }
  try { await localData.clear(); browserCleared = !failures.length; } catch (error) { failures.push(error.message); }
  try { await native("data.erase"); nativeCleared = true; } catch (error) { failures.push(error.message); }
  try { await api.contextMenus.removeAll(); } catch (error) { failures.push(`Could not remove the context menu: ${error.message}`); }
  return { browserCleared, nativeCleared, failures };
}

async function showPanel(tab, share) {
  if (!Number.isInteger(tab?.id) || dock.panelURLMatches(tab.url) || localData.closed) return;
  if (share && !localData.closed) {
    const temporary = temporaryChats.tabs.get(tab.id);
    const selection = share.selectionText;
    const frameURL = share.frameId ? share.frameUrl : tab.url;
    let auth;
    try {
      auth = await native("auth.status");
      await checkCapture(auth.account, tab.url);
      const limit = (await settings(api.storage.local)).pageChars;
      const page = selection ? { text: selection, title: tab.title, url: tab.url } : await readTab(api, tab.id, limit, { expectedURL: tab.url });
      if (!safeWebURL(tab.url) || safeWebURL(page.url) !== safeWebURL(tab.url)) throw new Error("The page changed. Choose Ask Safari Chat on the page you want to share.");
      const markSelection = await localData.write(async storage => {
        const access = await checkCapture(auth.account, tab.url);
        checkSession(await native("auth.status"), auth.account, auth.generation);
        const kind = selection ? "selection" : "page", url = publicURL(page.url);
        temporaryChats.get(tab.id, temporary?.id ?? null, auth.generation);
        await (temporary?.store ?? storage).set({ [`draft:${tab.id}`]: { kind, key: `${kind}:${tab.id}:${url}`, tabId: tab.id, text: page.text.slice(0, limit), title: page.title ?? "Page", url, truncated: !!page.truncated || page.text.length > limit, generation: auth.generation, created: Date.now() } });
        return selection && visibleWebsite(frameURL, access);
      });
      if (markSelection) await indicatePageAction(api, tab.id, frameURL, "selection", "copy", share.frameId);
    } catch (error) {
      if (!localData.closed) await localData.write(async storage => {
        if (auth) checkSession(await native("auth.status"), auth.account, auth.generation);
        temporaryChats.get(tab.id, temporary?.id ?? null, auth?.generation);
        await (temporary?.store ?? storage).set({ [`draft:${tab.id}`]: { error: error.message, ...(auth ? { generation: auth.generation } : {}), created: Date.now() } });
      }).catch(() => {});
    }
  }
  if (localData.closed) return;
  await dock.open(tab);
  if (share) await api.runtime.sendMessage({ type: "context.available", tabId: tab.id }).catch(() => {});
}

async function dockStatus(tabId, message = "") {
  await Promise.allSettled([
    api.action.setBadgeText?.({ tabId, text: message ? "!" : "" }),
    api.action.setTitle?.({ tabId, title: message || "Open Safari Chat" }),
  ]);
}
async function focusSource(panel) {
  const source = sourceTabId(panel);
  if (source === null) throw new Error("This chat has no source tab.");
  let tab;
  try {
    tab = await api.tabs.update(source, { active: true });
    if (!Number.isInteger(tab?.id)) tab = await api.tabs.get(source);
  }
  catch { throw new Error("The source tab is no longer available. Your chat is saved here."); }
  if (Number.isInteger(tab.windowId)) await api.windows.update(tab.windowId, { focused: true });
  return tab;
}
async function openFromSafari(tab, share) {
  if (!Number.isInteger(tab?.id)) return;
  try {
    if (!share && dock.panelURLMatches(tab.url)) tab = await focusSource(tab);
    await showPanel(tab, share);
    await dockStatus(tab.id);
  }
  catch (error) { await dockStatus(tab.id, error.message); }
}
async function restoreDock(tab) {
  try { if (await dock.open(tab, { restore: true })) await dockStatus(tab.id); }
  catch (error) { await dockStatus(tab.id, error.message); }
}
async function dismissDock(source, token) {
  const dismissed = await dock.dismiss(source, token, () => {
    temporaryChats.tabs.delete(source);
    for (const run of activeRuns.values()) if (run.source === source) run.abort();
  });
  if (dismissed) await dockStatus(source);
}
api.action.onClicked.addListener(tab => openFromSafari(tab));
api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll().then(() => {
    api.contextMenus.create({ id: "ask", title: "Ask Safari Chat", contexts: ["selection", "page"] });
  }).catch(console.error);
});
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask") return openFromSafari(tab, info);
});
api.tabs.onRemoved.addListener(tabId => {
  temporaryChats.tabs.delete(tabId);
  for (const run of activeRuns.values()) {
    if (run.source === tabId || run.panelTab === tabId) run.abort(new Error("The chat or its source tab was closed."));
  }
  api.storage.local.remove(`draft:${tabId}`).catch(() => {});
  frameDrafts.pending.delete(tabId);
  return dock.removed(tabId).catch(console.error);
});
api.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === "complete" && tab && !localData.closed) return restoreDock(tab);
});

async function handleMessage(message, sender) {
  if (!await dock.trusted(sender, message.dockToken)) throw new Error("Untrusted chat panel.");
  if (message.type === "panel.present") return true;
  if (message.type === "panel.visible") {
    if (sender.frameId) await api.tabs.sendMessage(sender.tab.id, { type: "panel.ready", token: message.dockToken }, { frameId: 0 });
    return true;
  }
  if (message.type === "data.erase") {
    if (!cleanupTask) cleanupTask = eraseLocalData().finally(() => { cleanupTask = null; });
    return cleanupTask;
  }
  if (localData.closed && !["bootstrap", "auth.open", "panel.close"].includes(message.type)) throw new Error("Local data was erased. Close the extension before removing the app.");
  const ownerTab = sourceTabId(sender) ?? sender.tab?.id;
  const temporary = () => temporaryChats.get(ownerTab, message.temporaryId ?? null, message.generation);
  switch (message.type) {
    case "temporary.start":
    case "temporary.end": return localData.write(async () => {
      const auth = checkSession(await native("auth.status"), message.account, message.generation);
      if (ownedRun(sender, auth.account, auth.generation)) throw new Error("Wait for the current reply before changing chats.");
      const existing = temporary();
      if (message.type === "temporary.start") return temporaryChats.start(ownerTab, auth.account, auth.generation);
      if (existing) temporaryChats.tabs.delete(ownerTab);
      return true;
    });
    case "bootstrap": {
      connectNativeEvents();
      if (localData.closed) return { prefs: normalizeSettings(), auth: { connected: false, account: "local" }, models: [], removalPrepared: true };
      const prefs = await settings(api.storage.local);
      let auth;
      try { auth = await native("auth.status"); } catch (error) { auth = { connected: false, error: error.message }; }
      const source = sourceTabId(sender);
      if (auth.generation) temporaryChats.changeAccount(auth.generation);
      const temp = temporaryChats.tabs.get(ownerTab);
      if (temp && (auth.generation !== temp.generation || auth.account !== temp.account)) throw new Error("Could not verify the temporary chat's account.");
      const store = temp?.store ?? api.storage.local, drafts = temp?.drafts ?? frameDrafts;
      if (message.openEditor && auth.generation && drafts.pending.has(source)) {
        await localData.write(() => drafts.recover(store, source, message.openEditor, auth, async () => checkSession(await native("auth.status"), auth.account, auth.generation)));
      }
      const cached = catalogCache?.generation === auth.generation && catalogCache?.expires > Date.now();
      const catalog = auth.connected && auth.canInfer ? (cached ? catalogCache.models : null) : [];
      const pointer = sessionKey(auth.account ?? "local", message.tabId);
      const session = (await store.get(pointer))[pointer];
      const key = `draft:${message.tabId}`;
      const hasContext = Number.isInteger(message.tabId) && !!(await store.get(key))[key];
      const access = auth.connected ? await readWebsiteAccess(api.storage.local, auth.account) : undefined;
      let run = ownedRun(sender, auth.account, auth.generation, message.chatId);
      let draftChatId;
      const editorId = message.chatId || session?.id;
      if (activeRuns.size && editorId && editorId !== run?.chat.id) {
        const key = draftKey(editorId), draft = (await store.get(key))[key];
        run = ownedRun(sender, auth.account, auth.generation, message.chatId);
        if (draft?.account === auth.account && draft.sourceChatId) {
          run ??= ownedRun(sender, auth.account, auth.generation, draft.sourceChatId);
          if (run?.chat.id === draft.sourceChatId) draftChatId = editorId;
        }
      }
      return { prefs, auth, temporaryId: temp?.id ?? null, models: catalog, activeChat: session?.id, hasContext, access, ...(run ? { run: { id: run.id, chatId: run.chat.id, draftChatId, interactionMode: run.mode } } : {}) };
    }
    case "models.list": {
      const auth = checkSession(await native("auth.status"), message.account, message.generation);
      if (!auth.connected || !auth.canInfer) throw new Error("Connect an account with model access first.");
      const catalog = await models(auth, message.refresh === true);
      checkSession(await native("auth.status"), message.account, message.generation);
      return catalog;
    }
    case "access.change": return saveWebsiteAccess(message.account, message.generation, message.change);
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
    case "auth.signin": case "auth.apikey": await native(message.type); return { ok: true };
    case "auth.signout": {
      const result = await native("auth.signout", { generation: message.generation });
      await notifyAccountChange(); return result;
    }
    case "context.take": return localData.write(async storage => {
      storage = temporary()?.store ?? storage;
      if (!Number.isInteger(message.tabId)) return null;
      const key = `draft:${message.tabId}`, item = (await storage.get(key))[key];
      if (!item) return null;
      if (!item.error) checkSession(await native("auth.status"), message.account, message.generation);
      await storage.remove(key);
      if (item.created <= Date.now() - 300000 || ((!item.error || item.generation) && item.generation !== message.generation)) return null;
      if (!item.error) await checkCapture(message.account, item.url);
      const { created, generation, ...source } = item;
      return source;
    });
    case "context.read": {
      const prefs = await settings(api.storage.local);
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const tab = await api.tabs.get(message.tabId);
      if (message.expectedOrigin && (!safeWebURL(tab.url) || new URL(tab.url).origin !== message.expectedOrigin)) throw new Error("The tab's website changed. Select it again.");
      await checkCapture(auth.account, tab.url);
      const page = await readTab(api, message.tabId, prefs.pageChars, { selectionOnly: message.selection === true, expectedURL: tab.url });
      if (safeWebURL(page.url) !== safeWebURL(tab.url) || (await api.tabs.get(message.tabId)).url !== tab.url) throw new Error("The tab changed while reading. Choose the page again.");
      await checkCapture(auth.account, page.url);
      checkSession(await native("auth.status"), auth.account, auth.generation);
      if (message.selection && !page.selection) throw new Error("Select a passage on the page first.");
      return { kind: message.selection ? "selection" : "page", key: `${message.selection ? "selection" : "page"}:${message.tabId}:${publicURL(page.url)}`, tabId: message.tabId, title: page.title, url: publicURL(page.url), text: message.selection ? page.selection : page.text, truncated: page.truncated };
    }
    case "tabs.list": {
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const windowId = await sourceWindowId(api, sourceTabId(sender));
      const tabs = await api.tabs.query(Number.isInteger(windowId) ? { windowId } : { currentWindow: true });
      const access = await readWebsiteAccess(api.storage.local, auth.account);
      checkSession(await native("auth.status"), auth.account, auth.generation);
      return listedTabs(tabs, access, 200, sender.frameId ? null : sender.tab?.id);
    }
    case "tabs.origin": {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("Select an existing tab.");
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const windowId = await sourceWindowId(api, sourceTabId(sender));
      const tab = message.wait ? await readyTab(api, message.tabId, AbortSignal.timeout(10500),
        current => !!current.url && current.url !== "about:blank", "Safari still hides this tab's address. Check the website address and try again.") : await api.tabs.get(message.tabId);
      if (tab.windowId !== windowId) throw new Error("This tab moved to another window. List the tabs again.");
      if (tab.url) await checkCapture(auth.account, tab.url);
      checkSession(await native("auth.status"), auth.account, auth.generation);
      return tab.url ? new URL(tab.url).origin : null;
    }
    case "chats.list": { const auth = await native("auth.status"); checkSession(auth, auth.account, message.generation); return listChats(api.storage.local, auth.account); }
    case "chat.load": {
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const data = (await (temporary()?.store ?? api.storage.local).get(chatKey(message.id)))[chatKey(message.id)];
      if (data && data.account !== (auth.account ?? "local")) throw new Error("This chat belongs to a different account.");
      return data && { ...data, revision: data.revision ?? 1 };
    }
    case "draft.load": {
      const auth = await native("auth.status");
      checkSession(auth, auth.account, message.generation);
      const data = (await (temporary()?.store ?? api.storage.local).get(draftKey(message.id)))[draftKey(message.id)];
      if (data && data.account !== (auth.account ?? "local")) throw new Error("This draft belongs to a different account.");
      return data && { ...data, revision: data.revision ?? 1 };
    }
    case "draft.stage":
      if (sender.frameId && /^[a-f0-9-]{36}$/i.test(message.draft?.id)) (temporary()?.drafts ?? frameDrafts).stage(sourceTabId(sender), message);
      return true;
    case "draft.save": return localData.write(async storage => {
      const auth = await native("auth.status");
      checkSession(auth, message.draft.account, message.generation);
      if (typeof message.draft.id !== "string" || !/^[a-f0-9-]{36}$/i.test(message.draft.id)) throw new Error("Invalid draft identifier.");
      const source = sourceTabId(sender);
      if (sender.frameId && message.tabId !== source) throw new Error("This draft belongs to another tab.");
      const temp = temporary(), drafts = temp?.drafts ?? frameDrafts;
      const recovered = drafts.receipt(source, message);
      if (recovered) return recovered;
      const saved = await saveDraft(temp?.store ?? storage, message.draft, message.tabId);
      drafts.saved(source, message, saved);
      return saved;
    });
    case "chat.save": {
      return localData.write(async storage => {
        checkSession(await native("auth.status"), message.chat.account, message.generation);
        return saveChat(temporary()?.store ?? storage, message.chat);
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
    case "panel.close": {
      if (sender.frameId) await dismissDock(sourceTabId(sender), message.dockToken);
      else if (Number.isInteger(sender.tab?.id)) {
        await api.tabs.remove(sender.tab.id);
      }
      return { ok: true };
    }
    case "panel.source": {
      const tab = await focusSource(sender);
      await openFromSafari(tab);
      return { ok: true };
    }
    default: throw new Error("Unknown extension request.");
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === api.runtime.id && !sender.frameId && Number.isInteger(sender.tab?.id) && !isPanel(sender) && !localData.closed) {
    if (message.type === "dock.width") return dock.width(sender.tab.id, message.token, message.width);
    if (message.type === "dock.dismiss") return dismissDock(sender.tab.id, message.token);
    if (message.type === "dock.restore") return restoreDock(sender.tab);
    if (message.type === "dock.removed") {
      return dock.owns(sender.tab.id, message.token).then(owned => {
        if (owned) return dockStatus(sender.tab.id, "This website removed the pane. Click Safari Chat to reopen it.");
      });
    }
  }
  if (!isPanel(sender)) return;
  return handleMessage(message, sender).then(value => ({ ok: true, value })).catch(error => ({ ok: false, error: error.message }));
});

api.runtime.onConnect.addListener(port => {
  if (port.name !== "chat" || !isPanel(port.sender)) { port.disconnect(); return; }
  let attached, dockToken, disconnected = false;
  const source = sourceTabId(port.sender);
  const host = port.sender.tab?.id;
  port.onDisconnect.addListener(() => { disconnected = true; attached?.ports.delete(port); });
  port.onMessage.addListener(async message => {
    if (disconnected) return;
    dockToken ??= message.dockToken;
    if (!await dock.trusted(port.sender, dockToken)) { port.disconnect(); return; }
    if (disconnected && message.type !== "run") return;
    if (localData.closed) { port.postMessage({ type: "data.erasing" }); return; }
    if (message.type === "cancel") { if (attached?.ports.has(port)) attached.abort(); return; }
    if (message.type === "motion.stop") { if (typeof message.id === "string" && attached?.ports.has(port) && attached.motionSession?.current?.id === message.id) await attached.motionSession.stop("stopped by user"); return; }
    if (message.type === "motion.speed") {
      if (typeof message.id === "string" && attached?.ports.has(port) && attached.motionSession?.current?.id === message.id) {
        try { await attached.motionSession.adjust(attached.motionSession.current, message.speed); }
        catch (error) { if (attached.ports.has(port)) port.postMessage({ type: "motion.error", message: error.message }); }
      }
      return;
    }
    if (message.type === "approval") { if (attached?.ports.has(port)) attached.answer(message); return; }
    if (message.type === "resume") {
      try {
        checkSession(await native("auth.status"), message.account, message.generation);
        temporaryChats.get(source ?? host, message.temporaryId ?? null, message.generation);
        if (localData.closed || disconnected) return;
        const run = activeRuns.get(message.id);
        if (run?.matches(source, host, message.account, message.generation) && run.chat.id === message.chatId && run.temporaryId === (message.temporaryId ?? null)) {
          if (port.sender.frameId) run.panelTab = source;
          attached = run; run.attach(port, true);
        } else {
          const recent = recentResults.get(message.id);
          const own = !message.temporaryId && recent && recent.source === source && (source !== null || recent.host === host) && recent.generation === message.generation && recent.account === message.account;
          port.postMessage({ type: "run.ended", saved: own ? recent.saved : undefined, message: own ? recent.message : undefined });
        }
      } catch (error) { port.postMessage({ type: "run.ended", message: error.message }); }
      return;
    }
    if (message.type !== "run" || (attached && activeRuns.has(attached.id))) return;
    let temporary;
    try { temporary = temporaryChats.get(source ?? host, message.temporaryId ?? null, message.generation); }
    catch (error) { port.postMessage({ type: "error", message: error.message }); return; }
    const existing = ownedRun(port.sender, message.account, message.generation, message.chatId);
    if (existing) {
      try {
        checkSession(await native("auth.status"), message.account, message.generation);
        if (disconnected || localData.closed) return;
        if (!activeRuns.has(existing.id)) port.postMessage({ type: "run.ended", saved: recentResults.get(existing.id)?.saved });
        else if (existing.chat.revision === message.revision) { attached = existing; existing.attach(port, true); }
        else port.postMessage({ type: "error", message: "This chat already has an active response. Reopen it to continue." });
      } catch (error) { port.postMessage({ type: "error", message: error.message }); }
      return;
    }
    const run = new ChatRun(message, source, host);
    attached = run;
    if (!disconnected) run.attach(port);
    activeRuns.set(run.id, run);
    const controller = run.controller;
    const emit = event => run.emit(event);
    let runChat, timer, timeoutError;
    let writing = false;
    const started = Date.now();
    let usedTools = false, workMs;
    const verifySession = async () => checkSession(await native("auth.status"), message.account, message.generation);
    const finish = (text, errorMessage) => localData.write(async storage => {
      await verifySession();
      const drafts = temporary?.drafts ?? frameDrafts;
      const pointer = !run.ports.size && !drafts.pending.has(source) ? sessionKey(run.account, source) : undefined;
      const browserActions = run.state.get("browser.actions")?.actions;
      const saved = await saveChat(temporary?.store ?? storage, { ...runChat, messages: [...runChat.messages, { role: "assistant", text, workMs, browserActions, toolErrors: run.toolErrors, ...(errorMessage ? { error: true, errorMessage } : {}) }] }, pointer);
      return { id: saved.id, title: saved.title, revision: saved.revision };
    });
    const runEmit = event => { controller.signal.throwIfAborted(); if (event.type === "activity") usedTools = true; emit(event); };
    const terminal = event => {
      if (!temporary && !localData.closed && (event.saved || !controller.signal.aborted)) {
        recentResults.set(run.id, { source, host, account: run.account, generation: run.generation, saved: event.saved, message: event.saveError || (!event.saved ? event.message : undefined) });
        if (recentResults.size > 16) recentResults.delete(recentResults.keys().next().value);
      }
      emit(event);
    };
    try {
      const prefs = { ...await settings(api.storage.local), interactionMode: run.mode, webSearch: message.webSearch === true };
      const expire = () => {
        timeoutError = new Error(`This message reached its ${prefs.turnMinutes}-minute time limit.` + (usedTools ? " Check the page before continuing." : ""));
        controller.abort(timeoutError);
      };
      const remaining = started + prefs.turnMinutes * 60000 - Date.now();
      if (remaining <= 0) expire();
      else timer = setTimeout(expire, remaining);
      controller.signal.throwIfAborted();
      const auth = await verifySession();
      if (!auth.connected || !auth.canInfer) throw new Error("Connect ChatGPT plan usage or an API key in the companion app first.");
      if (typeof message.chatId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.chatId)) throw new Error("Invalid chat identifier. Start a new chat.");
      runChat = run.chat;
      controller.signal.throwIfAborted();
      const requestedEffort = message.effort ?? "auto";
      const choices = await models(auth);
      let route;
      if (run.mode === "chat") {
        const family = chatFamilies(choices).find(item => item.id === message.model);
        route = family && Object.hasOwn(family.routes, requestedEffort) && family.routes[requestedEffort];
        if (!route?.model) throw new Error("This Chat model or thinking level is unavailable. Reopen the model picker.");
      } else {
        const selected = choices.find(model => model.id === message.model);
        if (!selected) throw new Error("This model is no longer listed for this connection. Reload models and choose an available one.");
        route = { model: message.model, effort: resolveEffort(selected, requestedEffort) };
      }
      const built = buildInput(message.messages.filter(m => !m.error), prefs);
      emit({ type: "context", chars: built.chars, trimmed: built.trimmed });
      const defaultTabId = sourceTabId(port.sender);
      const tabFocus = new TabFocus(api, defaultTabId);
      const promptInChat = async (details, signal) => {
        await tabFocus.returnSelection(true, verifySession);
        signal.throwIfAborted();
        return run.prompt(details, signal);
      };
      const approve = async (details, signal) => {
        const scope = await promptInChat(details, signal);
        if (scope === "once") return scope;
        if (scope === "site" && details.hosts.length !== 1) throw new Error("This action involves more than one website.");
        const change = scope === "site" ? { host: details.hosts[0], rule: "allow" } : { mode: "auto" };
        await saveWebsiteAccess(auth.account, auth.generation, change, signal, details.hosts);
        return scope;
      };
      const initialTabs = (message.messages.at(-1)?.contexts ?? []).map(c => ({ id: c.tabId, url: c.url }));
      const requestSiteAccess = (siteOrigin, signal) => promptInChat({ operation: "read", siteOrigin,
        title: "Read " + new URL(siteOrigin).hostname + "?",
        detail: "Allow website access in Safari to let this chat read the open tab and continue." }, signal);
      const requestTabAccess = (tabId, tabLabel, signal) => promptInChat({ operation: "read", tabId, tabLabel,
        title: "Read " + tabLabel + "?", detail: "Safari is hiding this tab's title and address. Allow access to identify and read it here." }, signal);
      const motionSession = new MotionSession(api, state => emit({ type: "motion.state", state }));
      run.motionSession = motionSession;
      const inputs = new PageInputs(api, {
        write: text => native("clipboard.write", { generation: auth.generation, text }),
        read: async () => (await native("clipboard.read", { generation: auth.generation })).text,
      });
      const executeTool = createBrowserTools({ api, pageChars: prefs.pageChars, motionSession, inputs, tabFocus, approve, requestSiteAccess, requestTabAccess, readAccess: () => readWebsiteAccess(api.storage.local, auth.account), verifySession: async () => {
        try { await verifySession(); } catch (error) { controller.abort(error); throw error; }
      }, initialTabs, defaultTabId, protectedTabId: port.sender.frameId ? null : host });
      const stopMotion = reason => motionSession.stop(reason);
      const result = await runAgent({ input: built.input, ...route, settings: prefs, signal: controller.signal }, { credential: () => credential(auth), executeTool, stopMotion, emit: runEmit, browserAPI: api })
        .finally(async () => {
          await Promise.all([stopMotion("task ended"), inputs.release()]);
          await tabFocus.returnSelection(false, verifySession);
        });
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      writing = true;
      workMs = usedTools ? Date.now() - started : undefined;
      terminal({ type: "done", workMs, usage: result.usage, saved: await finish(result.text) });
    } catch (error) {
      let saved, saveError;
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const timedOut = !!timeoutError && reason === timeoutError;
      const message = (controller.signal.aborted && reason?.name === "AbortError" ? "Response stopped." : reason?.message || "The request could not finish.").slice(0, 1000);
      workMs = usedTools ? Date.now() - started : undefined;
      if (runChat && !localData.closed && !writing) {
        try { saved = await finish(run.text || message, message); }
        catch (failure) { saveError = failure.message; }
      }
      terminal({ type: controller.signal.aborted && !timedOut ? "cancelled" : "error", workMs, saved, saveError: saveError || (writing ? error.message : undefined), message });
    } finally {
      clearTimeout(timer); activeRuns.delete(run.id); run.release();
    }
  });
});
