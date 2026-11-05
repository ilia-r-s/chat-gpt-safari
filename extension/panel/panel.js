import { DEFAULTS } from "../core/config.js";
import { estimateTokens } from "../core/context.js";
import { markdown } from "./markdown.js";

const $ = id => document.getElementById(id);
const tabParameter = new URL(location.href).searchParams.get("tab");
const sourceTab = tabParameter === null ? null : Number(tabParameter);
let prefs = { ...DEFAULTS };
let auth = { connected: false, account: "local" };
let chat;
let contexts = [];
let port;
let running = false;
let pendingApproval;
let currentAssistant;
let paintScheduled = false;
let noticeTimer;
let chats = [];
let bootstrapPending;
let requestedChat = new URL(location.href).searchParams.get("chat");
let removing = false;
let openingCompanion = false;

const rpc = async (type, payload = {}) => {
  if (removing && !["data.erase", "auth.open", "panel.close"].includes(type)) throw new Error("Local data was erased. Close this panel before removing Safari Chat.");
  if (!globalThis.browser?.runtime) throw new Error("This preview is not connected to Safari. Build and enable the extension to use chat.");
  const result = await browser.runtime.sendMessage({ type, ...payload });
  if (removing && !["data.erase", "auth.open", "panel.close"].includes(type)) throw new Error("Local data was erased. This earlier request was discarded.");
  if (!result?.ok) throw new Error(result?.error || "The extension did not respond. Reopen the panel.");
  return result.value;
};
const guard = action => async event => { try { await action(event); } catch (error) { notice(error.message); } };
function notice(message, temporary = false) {
  clearTimeout(noticeTimer); $("notice").textContent = message; $("notice").hidden = !message;
  if (temporary) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 5000);
}
async function openCompanion() {
  if (openingCompanion) return;
  openingCompanion = true;
  try {
    await rpc("auth.open");
    $("companion-dialog").close();
    notice("Safari Chat is opening. Continue in the companion app, then return here.", true);
  } catch (error) {
    notice(error.message);
    $("companion-error").textContent = error.message;
    if (!$("companion-dialog").open) $("companion-dialog").showModal();
  } finally { openingCompanion = false; }
}
function applyTheme() { document.documentElement.dataset.theme = prefs.theme; }
function freshChat() {
  if (running) return;
  chat = { id: crypto.randomUUID(), account: auth.account ?? "local", title: "New chat", messages: [] };
  contexts = []; renderAttachments(); renderMessages(); $("prompt").value = ""; $("usage").textContent = "Local context";
}
function scrollDown(force = false) {
  const main = $("conversation");
  if (force || main.scrollHeight - main.scrollTop - main.clientHeight < 180) main.scrollTop = main.scrollHeight;
}
function renderMessages() {
  $("messages").replaceChildren(); $("welcome").hidden = chat.messages.length > 0;
  for (const message of chat.messages) appendMessage(message);
}
function appendMessage(message) {
  const article = document.createElement("article"); article.className = `message ${message.role}`;
  if (message.role === "user") article.textContent = message.text;
  else {
    const speaker = document.createElement("div"); speaker.className = "speaker"; speaker.innerHTML = "<span>✳</span> Safari Chat";
    const body = document.createElement("div"); body.className = "message-content"; body.innerHTML = markdown(message.text);
    const tools = document.createElement("div"); tools.className = "message-tools";
    const copy = document.createElement("button"); copy.textContent = "Copy"; copy.onclick = guard(async () => { await navigator.clipboard.writeText(message.text); notice("Copied to clipboard.", true); }); tools.append(copy);
    article.append(speaker, body, tools);
    if (message.error) { const hint = document.createElement("div"); hint.className = "message-error"; hint.textContent = "This response did not complete."; article.append(hint); }
    if (running && message === chat.messages.at(-1)) currentAssistant = body;
  }
  $("messages").append(article);
  return article;
}
function renderAttachments() {
  $("attachments").replaceChildren();
  contexts.forEach((context, index) => {
    const pill = document.createElement("div"); pill.className = "attachment";
    const label = document.createElement("span"); label.textContent = `${context.kind === "selection" ? "❞ " : "▤ "}${context.title}`;
    const remove = document.createElement("button"); remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${context.title}`);
    remove.onclick = () => { contexts.splice(index, 1); renderAttachments(); };
    pill.append(label, remove); $("attachments").append(pill);
  });
  if (!running) $("usage").textContent = contexts.length ? `~${estimateTokens(contexts.map(c => c.text).join(" ")).toLocaleString()} context tokens` : "Local context";
}
function addContext(context) {
  if (removing) return;
  const existing = contexts.findIndex(c => c.key === context.key);
  if (existing >= 0) contexts[existing] = context;
  else if (contexts.length < 6) contexts.push(context);
  else throw new Error("You can attach up to six sources per message.");
  renderAttachments();
  if (context.truncated) notice("This page was trimmed to your context limit.", true);
}
async function attachPage(tabId = sourceTab, selection = false) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Open the extension from the Safari tab you want to read.");
  addContext(await rpc("context.read", { tabId, selection }));
}
function setRunning(value) {
  running = value; $("send-button").hidden = value; $("stop-button").hidden = !value;
  for (const id of ["new-button", "history-button", "model", "save-settings", "signout-button", "account-button", "popout-button"]) $(id).disabled = value || removing;
  if (!value) { $("approval").hidden = true; pendingApproval = null; }
}
async function save() { await rpc("chat.save", { chat }); }
function settle(error, cancelled = false) {
  if (!running) return;
  const last = chat.messages.at(-1);
  if (error) { last.error = true; if (!last.text) last.text = cancelled ? "Response stopped." : "No response received."; notice(error); }
  setRunning(false); renderMessages(); scrollDown();
  save().catch(error => notice(`Could not save this chat: ${error.message}`));
}
function handleStream(event) {
  if (event.type === "data.erasing") { forgetLocalUI(); return; }
  if (removing) return;
  if (event.type === "delta") {
    chat.messages.at(-1).text += event.text;
    if (!paintScheduled) {
      paintScheduled = true;
      requestAnimationFrame(() => { paintScheduled = false; if (currentAssistant && running) currentAssistant.textContent = chat.messages.at(-1).text; scrollDown(); });
    }
  } else if (event.type === "status" && currentAssistant && !chat.messages.at(-1).text) { currentAssistant.textContent = event.text; currentAssistant.classList.add("typing"); }
  else if (event.type === "context" && event.trimmed) notice("Using recent turns and a bounded selection of your attachments.", true);
  else if (event.type === "usage") { $("usage").textContent = `${(event.usage.input + event.usage.output).toLocaleString()} tokens`; $("usage").title = `${event.usage.input} input · ${event.usage.cached} cached · ${event.usage.output} output · ${event.usage.requests} requests`; }
  else if (event.type === "approval") { pendingApproval = event.id; $("approval-title").textContent = event.title; $("approval-detail").textContent = event.detail; $("approval").hidden = false; }
  else if (event.type === "done") settle();
  else if (event.type === "error" || event.type === "cancelled") settle(event.type === "cancelled" ? "Response stopped. Your partial answer is saved." : event.message, event.type === "cancelled");
}
async function send(event) {
  event?.preventDefault(); if (running || removing) return;
  const text = $("prompt").value.trim(); if (!text) return;
  if (!auth.connected || !auth.canInfer) { notice("Connect your ChatGPT account or API key in the companion app first."); return; }
  if (!$("model").value) throw new Error("Choose a model before sending a message.");
  notice("");
  port?.disconnect(); port = null;
  setRunning(true); // Lock submission before asynchronous storage/native calls.
  chat.messages.push({ role: "user", text, contexts: structuredClone(contexts) });
  if (chat.messages.length === 1) chat.title = text.slice(0, 80);
  try { await save(); } catch (error) { chat.messages.pop(); setRunning(false); throw error; }
  contexts = []; renderAttachments(); $("prompt").value = ""; $("prompt").style.height = "auto";
  chat.messages.push({ role: "assistant", text: "" }); renderMessages(); scrollDown(true);
  try { port = browser.runtime.connect({ name: "chat" }); } catch (error) { settle(error.message); return; }
  const currentPort = port;
  port.onMessage.addListener(handleStream);
  port.onDisconnect.addListener(() => { if (running && port === currentPort) settle("The extension disconnected. Reopen the panel and try again."); });
  port.postMessage({ type: "run", chatId: chat.id, title: chat.title, account: chat.account, model: $("model").value, messages: chat.messages.slice(0, -1).filter(m => !m.error) });
}
async function loadBootstrap() {
  if (removing) return;
  const result = await rpc("bootstrap", { tabId: sourceTab });
  if (running || removing) return;
  if (result.removalPrepared) { forgetLocalUI(); return; }
  const previous = auth.account;
  prefs = result.prefs; auth = result.auth;
  applyTheme(); $("connect-card").hidden = auth.connected && auth.canInfer;
  $("account-label").textContent = auth.connected ? auth.label || "Connected" : "Connect account";
  $("model").replaceChildren();
  for (const model of result.models) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.name; $("model").append(option); }
  if (!result.models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "Choose a model"; $("model").append(option); }
  if (result.models.some(m => m.id === prefs.model)) $("model").value = prefs.model;
  if (!chat || previous !== auth.account) freshChat();
  if (requestedChat) {
    const id = requestedChat; requestedChat = null;
    const loaded = await rpc("chat.load", { id });
    if (loaded) { chat = loaded; renderMessages(); scrollDown(true); }
  }
  if (result.draft) addContext({ ...result.draft, kind: "selection", key: `selection:${result.draft.url}`, tabId: sourceTab });
  if (result.modelError || auth.error) notice(result.modelError || auth.error);
  if (auth.connected && !auth.canInfer) notice("Signed in without ChatGPT plan usage. Enable plan usage in the companion app or connect an API key.");
}
function bootstrap() {
  if (!bootstrapPending) bootstrapPending = loadBootstrap().finally(() => { bootstrapPending = null; });
  return bootstrapPending;
}
function forgetLocalUI() {
  removing = true;
  setRunning(false);
  port?.disconnect(); port = null;
  chat = { id: "", account: "local", title: "", messages: [] };
  contexts = []; chats = []; auth = { connected: false, account: "local" }; prefs = { ...DEFAULTS };
  requestedChat = null; currentAssistant = null;
  $("prompt").value = ""; $("history-search").value = ""; $("history-list").replaceChildren(); $("tabs-list").replaceChildren();
  $("approval-detail").textContent = ""; $("approval-title").textContent = "";
  renderMessages(); renderAttachments(); applyTheme();
  $("connect-card").hidden = true; $("account-label").textContent = "Data cleanup";
  $("model").replaceChildren(); $("usage").textContent = ""; $("usage").removeAttribute("title");
  $("file-input").value = "";
  for (const element of document.querySelectorAll("button,input,textarea,select")) element.disabled = true;
  for (const id of ["close-button", "settings-button", "erase-data-button", "finish-removal-button", "retry-companion-button"]) $(id).disabled = false;
  document.querySelectorAll("[data-close]").forEach(button => { button.disabled = false; });
  $("finish-removal-button").hidden = false;
  notice("Local data cleanup has started. Use settings to check the result and finish removal.");
}

if (globalThis.browser?.runtime?.onMessage) browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === browser.runtime.id && message.type === "data.erasing") forgetLocalUI();
});
function openSettings() {
  $("theme-setting").value = prefs.theme; $("tools-setting").checked = prefs.browserTools;
  $("page-setting").value = prefs.pageChars; $("budget-setting").value = prefs.inputChars; $("turns-setting").value = prefs.historyTurns;
  $("settings-dialog").showModal();
}
function renderHistory() {
  $("history-list").replaceChildren();
  const query = $("history-search").value.toLowerCase();
  for (const item of chats.filter(c => c.title.toLowerCase().includes(query))) {
    const row = document.createElement("div"); row.className = "list-row";
    const open = document.createElement("button"); open.textContent = item.title;
    const date = document.createElement("small"); date.textContent = new Date(item.updated).toLocaleDateString(); open.append(date);
    open.onclick = guard(async () => { const loaded = await rpc("chat.load", { id: item.id }); if (!loaded) throw new Error("This chat no longer exists."); chat = loaded; contexts = []; renderAttachments(); renderMessages(); $("history-dialog").close(); scrollDown(true); });
    const remove = document.createElement("button"); remove.className = "icon-button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Delete ${item.title}`);
    remove.onclick = guard(async () => { if (!confirm(`Delete “${item.title}” from this Mac?`)) return; await rpc("chat.delete", { id: item.id }); chats = chats.filter(c => c.id !== item.id); if (chat.id === item.id) freshChat(); renderHistory(); });
    row.append(open, remove); $("history-list").append(row);
  }
  if (!$("history-list").children.length) $("history-list").textContent = "No chats yet.";
}

$("composer").onsubmit = guard(send);
$("prompt").onkeydown = guard(event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) return send(event); });
$("prompt").oninput = () => { $("prompt").style.height = "auto"; $("prompt").style.height = `${Math.min(160, $("prompt").scrollHeight)}px`; };
$("stop-button").onclick = () => { port?.postMessage({ type: "cancel" }); $("approval").hidden = true; };
$("new-button").onclick = freshChat;
$("close-button").onclick = guard(async () => { port?.postMessage({ type: "cancel" }); await rpc("panel.close"); if (window.top === window) window.close(); });
for (const id of ["connect-button", "api-key-button", "account-button", "retry-companion-button"]) $(id).onclick = guard(openCompanion);
$("attach-page").onclick = guard(() => attachPage());
$("attach-tabs").onclick = guard(async () => {
  const tabs = await rpc("tabs.list"); $("tabs-list").replaceChildren();
  for (const tab of tabs) {
    const row = document.createElement("div"); row.className = "list-row";
    const button = document.createElement("button"); button.textContent = tab.title;
    const url = document.createElement("small"); url.textContent = tab.url; button.append(url);
    button.onclick = guard(async () => { await attachPage(tab.id); $("tabs-dialog").close(); }); row.append(button); $("tabs-list").append(row);
  }
  if (!tabs.length) $("tabs-list").textContent = "No accessible tabs. Open this panel from a website first.";
  $("tabs-dialog").showModal();
});
$("file-input").onchange = guard(async () => {
  const file = $("file-input").files[0]; $("file-input").value = ""; if (!file) return;
  if (file.size > 200000) throw new Error("Choose a text file smaller than 200 KB.");
  const text = await file.text(); if (text.includes("\u0000")) throw new Error("Only plain text files are supported.");
  addContext({ kind: "file", key: `file:${file.name}`, title: file.name, text: text.slice(0, prefs.pageChars), truncated: text.length > prefs.pageChars });
});
document.querySelectorAll("[data-prompt]").forEach(button => { button.onclick = guard(async () => {
  if (button.dataset.prompt === "summarize") { await attachPage(); $("prompt").value = "Summarize this page. Highlight the key points and anything I should pay attention to."; }
  if (button.dataset.prompt === "explain") { await attachPage(sourceTab, true); $("prompt").value = "Explain this in clear, simple terms."; }
  if (button.dataset.prompt === "write") $("prompt").value = "Help me write ";
  $("prompt").focus();
}); });
$("settings-button").onclick = openSettings;
$("erase-data-button").onclick = guard(async () => {
  if (!confirm("Erase every Safari Chat conversation, attachment, draft and setting in this Safari profile, and all Safari Chat accounts saved on this Mac? Active tasks stop. This cannot be undone.")) return;
  forgetLocalUI();
  $("erase-data-button").disabled = true;
  $("cleanup-result").hidden = false; $("cleanup-result").textContent = "Erasing local data…";
  try {
    const result = await rpc("data.erase");
    const message = result.failures.length ? `Cleanup is incomplete: ${result.failures.join(" ")} Retry before uninstalling.`
      : "This profile's extension storage and saved native accounts were cleared. Open the companion app and choose Erase native data and quit, then uninstall in Safari Settings and remove the app. Other profiles, exported files, backups and system records are separate.";
    $("cleanup-result").textContent = message; notice(message);
  } catch (error) { $("cleanup-result").textContent = `Cleanup is incomplete: ${error.message}`; throw error; }
  finally { $("erase-data-button").disabled = false; $("erase-data-button").textContent = "Retry local cleanup"; }
});
$("finish-removal-button").onclick = guard(openCompanion);
$("popout-button").onclick = guard(async () => {
  if (running) return;
  if (chat.messages.length) await save();
  await rpc("panel.popout", { tabId: sourceTab, chatId: chat.messages.length ? chat.id : null });
  $("settings-dialog").close();
});
$("save-settings").onclick = guard(async () => { prefs = await rpc("settings.save", { settings: { ...prefs, model: $("model").value, theme: $("theme-setting").value, browserTools: $("tools-setting").checked, pageChars: Number($("page-setting").value), inputChars: Number($("budget-setting").value), historyTurns: Number($("turns-setting").value) } }); applyTheme(); $("settings-dialog").close(); });
$("model").onchange = guard(async () => { prefs = await rpc("settings.save", { settings: { ...prefs, model: $("model").value } }); });
$("history-button").onclick = guard(async () => { chats = await rpc("chats.list"); renderHistory(); $("history-dialog").showModal(); });
$("history-search").oninput = renderHistory;
$("signout-button").onclick = guard(async () => { await rpc("auth.signout"); $("settings-dialog").close(); await bootstrap(); });
$("export-button").onclick = () => {
  const text = chat.messages.map(m => `## ${m.role === "user" ? "You" : "Safari Chat"}\n\n${m.text}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a"); link.href = url; link.download = "safari-chat.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const [id, allow] of [["approve-button", true], ["decline-button", false]]) $(id).onclick = () => { port?.postMessage({ type: "approval", id: pendingApproval, allow }); pendingApproval = null; $("approval").hidden = true; };
document.querySelectorAll("[data-close]").forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !running) bootstrap().catch(error => notice(error.message)); });
window.addEventListener("focus", () => { if (!running) bootstrap().catch(error => notice(error.message)); });
freshChat();
bootstrap().catch(error => { $("connect-card").hidden = false; notice(error.message); });
