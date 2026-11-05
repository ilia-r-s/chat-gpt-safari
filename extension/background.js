import { buildInput, publicURL, safeWebURL } from "./core/context.js";
import { normalizeSettings } from "./core/config.js";
import { settings, saveChat, listChats, chatKey } from "./core/storage.js";
import { readTab, createBrowserTools } from "./core/browser-tools.js";
import { runAgent } from "./core/agent.js";
import { LocalData } from "./core/local-data.js";

const api = browser;
const panelURL = api.runtime.getURL("panel/panel.html");
const activeRuns = new Map();
const localData = new LocalData(api.storage.local);
const modelRequests = new Set();
let cleanupTask;
let catalogCache;

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

async function credential(account) {
  const result = await native("auth.credential");
  if (account && account !== result.account) throw new Error("Your account changed. Start a new message with the selected account.");
  return result.token;
}

async function models(account) {
  if (localData.closed) throw new Error("Local data is being erased.");
  if (catalogCache?.account === account && catalogCache.expires > Date.now()) return catalogCache.models;
  const token = await credential(account);
  if (localData.closed) throw new Error("Local data is being erased.");
  const controller = new AbortController();
  modelRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
  const response = await fetch("https://api.openai.com/v1/models", { credentials: "omit", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  if (!response.ok) throw new Error(`Could not load models (HTTP ${response.status}). Check your connection and account access.`);
  const data = await response.json();
  if (localData.closed) throw new Error("Local data is being erased.");
  const values = data.models ? data.models.filter(model => model.visibility === "list").map(model => ({ id: model.slug, name: model.display_name }))
    : (data.data ?? []).filter(model => /^(gpt-|o[134])/.test(model.id) && !/audio|realtime|transcribe|image|tts|search|instruct/.test(model.id)).map(model => ({ id: model.id, name: model.id }));
  catalogCache = { account, models: values, expires: Date.now() + 300000 };
  return values;
  } finally { clearTimeout(timer); modelRequests.delete(controller); }
}

async function eraseLocalData() {
  localData.stop();
  catalogCache = null;
  for (const run of activeRuns.values()) run.abort();
  for (const request of modelRequests) request.abort();
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

async function showPanel(tab, selection) {
  if (!tab?.id) return;
  if (selection && !localData.closed) await localData.write(storage => storage.set({ [`draft:${tab.id}`]: { text: selection.slice(0, 12000), title: tab.title ?? "Selected text", url: publicURL(tab.url), created: Date.now() } }));
  const url = `${panelURL}?tab=${tab.id}`;
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/mount.js"] });
    await api.tabs.sendMessage(tab.id, { type: "panel.show", url });
  } catch { await api.tabs.create({ url }); }
}

api.action.onClicked.addListener(tab => showPanel(tab).catch(console.error));
api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll().then(() => {
    api.contextMenus.create({ id: "ask", title: "Ask Safari Chat", contexts: ["selection", "page"] });
  }).catch(console.error);
});
api.contextMenus.onClicked.addListener((info, tab) => showPanel(tab, info.selectionText).catch(console.error));
api.tabs.onRemoved.addListener(tabId => api.storage.local.remove(`draft:${tabId}`).catch(() => {}));

async function handleMessage(message, sender) {
  if (!isPanel(sender)) throw new Error("Untrusted extension message.");
  if (message.type === "data.erase") {
    if (!cleanupTask) cleanupTask = eraseLocalData().finally(() => { cleanupTask = null; });
    return cleanupTask;
  }
  if (localData.closed && !["bootstrap", "auth.open", "panel.close"].includes(message.type)) throw new Error("Local data was erased. Close the extension before removing the app.");
  switch (message.type) {
    case "bootstrap": {
      if (localData.closed) return { prefs: normalizeSettings(), auth: { connected: false, account: "local" }, models: [], removalPrepared: true };
      const prefs = await settings(api.storage.local);
      let auth;
      try { auth = await native("auth.status"); } catch (error) { auth = { connected: false, error: error.message }; }
      let catalog = [];
      let modelError;
      if (auth.connected && auth.canInfer) try { catalog = await models(auth.account); } catch (error) { modelError = error.message; }
      const key = `draft:${message.tabId}`;
      const stored = await api.storage.local.get(key);
      await api.storage.local.remove(key);
      return { prefs, auth, models: catalog, modelError, draft: stored[key]?.created > Date.now() - 300000 ? stored[key] : null };
    }
    case "settings.save": { const prefs = normalizeSettings(message.settings); await localData.write(storage => storage.set({ settings: prefs })); return prefs; }
    case "auth.open": await native("app.open"); return { ok: true };
    case "auth.signout": {
      for (const run of activeRuns.values()) run.abort();
      catalogCache = null;
      return native("auth.signout");
    }
    case "context.read": {
      const prefs = await settings(api.storage.local);
      const page = await readTab(api, message.tabId, prefs.pageChars);
      return { kind: message.selection && page.selection ? "selection" : "page", key: `${message.selection ? "selection" : "page"}:${publicURL(page.url)}`, tabId: message.tabId, title: page.title, url: publicURL(page.url), text: message.selection && page.selection ? page.selection : page.text, truncated: page.truncated };
    }
    case "tabs.list": return (await api.tabs.query({ currentWindow: true })).filter(tab => safeWebURL(tab.url)).map(tab => ({ id: tab.id, title: tab.title ?? "Untitled", url: publicURL(tab.url) }));
    case "chats.list": { const auth = await native("auth.status"); return listChats(api.storage.local, auth.account ?? "local"); }
    case "chat.load": {
      const auth = await native("auth.status");
      const data = (await api.storage.local.get(chatKey(message.id)))[chatKey(message.id)];
      if (data?.account !== (auth.account ?? "local")) throw new Error("This chat belongs to a different account.");
      return data;
    }
    case "chat.save": {
      const auth = await native("auth.status");
      if (message.chat.account !== (auth.account ?? "local")) throw new Error("Your account changed. This chat was not saved to the new account.");
      return localData.write(storage => saveChat(storage, message.chat));
    }
    case "chat.delete": {
      const auth = await native("auth.status");
      const data = (await api.storage.local.get(chatKey(message.id)))[chatKey(message.id)];
      if (data && data.account !== (auth.account ?? "local")) throw new Error("This chat belongs to a different account.");
      await api.storage.local.remove(chatKey(message.id)); return { ok: true };
    }
    case "panel.close": if (sender.tab?.id) await api.tabs.sendMessage(sender.tab.id, { type: "panel.close" }).catch(() => {}); return { ok: true };
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
    activeRuns.set(port, controller);
    // A finite deadline also bounds abandoned network reads and approval prompts.
    const timer = setTimeout(() => controller.abort(new Error("This task timed out. Please try again.")), 300000);
    let runChat;
    let partialText = "";
    const runEmit = event => { if (event.type === "delta") partialText += event.text; emit(event); };
    try {
      const auth = await native("auth.status");
      if (!auth.connected || !auth.canInfer) throw new Error("Connect ChatGPT plan usage or an API key in the companion app first.");
      if (message.account !== auth.account) throw new Error("Your account changed. Refresh the panel before continuing.");
      if (typeof message.chatId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.chatId)) throw new Error("Invalid chat identifier. Start a new chat.");
      runChat = { id: message.chatId, title: String(message.title || "New chat"), account: auth.account, messages: message.messages };
      const prefs = await settings(api.storage.local);
      const built = buildInput(message.messages, prefs);
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
      const executeTool = createBrowserTools({ api, pageChars: prefs.pageChars, approve, initialTabs });
      const result = await runAgent({ input: built.input, model: message.model, settings: prefs, signal: controller.signal }, { credential: () => credential(auth.account), executeTool, emit: runEmit });
      await localData.write(storage => saveChat(storage, { ...runChat, messages: [...runChat.messages, { role: "assistant", text: result.text }] }));
      emit({ type: "done", usage: result.usage });
    } catch (error) {
      if (runChat && !localData.closed) {
        try { await localData.write(storage => saveChat(storage, { ...runChat, messages: [...runChat.messages, { role: "assistant", text: partialText || "Response did not complete.", error: true }] })); }
        catch { /* The UI also reports storage failures; never obscure the original request error. */ }
      }
      emit({ type: controller.signal.aborted ? "cancelled" : "error", message: error?.message ?? "The request could not finish." });
    } finally {
      clearTimeout(timer); busy = false; approval = null; activeRuns.delete(port);
    }
  });
});
