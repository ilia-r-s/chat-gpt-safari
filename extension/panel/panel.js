import { DEFAULTS } from "../core/config.js";
import { estimateTokens } from "../core/context.js";
import { markdown } from "./markdown.js";
import { branchChat } from "./conversation.js";
import { EFFORT_LABELS } from "../core/models.js";
import { setupAttachments } from "./attachments.js";

const $ = id => document.getElementById(id);
const tabParameter = new URL(location.href).searchParams.get("tab");
const sourceTab = tabParameter === null ? null : Number(tabParameter);
let prefs = { ...DEFAULTS };
let modelChoices = [];
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
let companionSignIn = false;
let ready = false;
let switching = false;
let draftTimer;
let draftTail = Promise.resolve();
let draftVersion = 0;
let editingIndex = null;
let savedDraft = "";
let preparing = false;
let cancelPreparation = false;
let preferenceRevision = 0;
let themeRevision = 0;
let themeOverride = null;
let themeSave = Promise.resolve();

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
  clearTimeout(noticeTimer); $("notice").replaceChildren(); $("notice").hidden = !message;
  if (message) {
    const text = document.createElement("span"); text.textContent = message;
    const close = document.createElement("button"); close.className = "notice-close"; close.textContent = "×"; close.setAttribute("aria-label", "Dismiss notice");
    close.onclick = () => notice(""); $("notice").append(text, close);
  }
  if (temporary) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 5000);
}
async function openCompanion(signIn = false) {
  if (openingCompanion) return;
  companionSignIn = signIn;
  openingCompanion = true;
  try {
    await rpc(signIn ? "auth.signin" : "auth.open");
    $("companion-dialog").close();
    notice(signIn ? "Continue with ChatGPT in your browser, then return to this panel. Sign-in starts automatically; no separate setup window is needed." : "Safari Chat is opening. Continue in the companion app, then return here.", !signIn);
  } catch (error) {
    notice(error.message);
    $("companion-error").textContent = error.message;
    if (!$("companion-dialog").open) $("companion-dialog").showModal();
  } finally { openingCompanion = false; }
}
function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  $("web-search").setAttribute("aria-pressed", String(prefs.webSearch));
  $("search-chip").hidden = !prefs.webSearch;
}
async function savePreferences(patch) {
  const saved = await rpc("settings.save", { settings: patch });
  for (const key of Object.keys(patch)) prefs[key] = saved[key];
  preferenceRevision++;
  applyTheme();
}
function changeTheme(theme) {
  if (themeOverride === null && prefs.theme === theme) return themeSave;
  const revision = ++themeRevision;
  themeOverride = theme; prefs.theme = theme; preferenceRevision++;
  applyTheme();
  $("theme-status").textContent = "Saving appearance…";
  // Keep rapid changes in order; an older acknowledgement must not repaint
  // a newer choice. Only the changed field is written to shared settings.
  themeSave = themeSave.catch(() => {}).then(() => rpc("settings.save", { settings: { theme } })).then(saved => {
    if (revision !== themeRevision || removing) return;
    themeOverride = null; prefs.theme = saved.theme; preferenceRevision++;
    applyTheme(); $("theme-status").textContent = "Appearance saved.";
  }).catch(error => {
    if (revision === themeRevision && !removing) $("theme-status").textContent = `Appearance changed here but could not be saved: ${error.message} Choose it again or press Save settings to retry.`;
    throw error;
  });
  return themeSave;
}
globalThis.browser?.storage?.onChanged?.addListener((changes, area) => {
  if (removing || area !== "local" || !changes.settings?.newValue) return;
  const theme = changes.settings.newValue.theme;
  if (themeOverride !== null || !["system", "light", "dark"].includes(theme)) return;
  prefs.theme = theme; preferenceRevision++;
  $("theme-setting").value = theme; applyTheme();
});
function freshChat() {
  attachmentUI.reset();
  savedDraft = "";
  chat = { id: crypto.randomUUID(), account: auth.account ?? "local", title: "New chat", messages: [] };
  contexts = []; $("prompt").value = ""; resizePrompt(); renderAttachments(); renderMessages(); $("usage").textContent = "Local context";
  $("draft-status").textContent = "";
  $("activity").hidden = true; $("activity-label").textContent = ""; $("activity-detail").textContent = "";
}
function resizePrompt() {
  $("prompt").style.height = "auto";
  $("prompt").style.height = `${Math.min(160, $("prompt").scrollHeight)}px`;
  $("send-button").disabled = !ready || switching || removing || !$("prompt").value.trim();
}
function scheduleDraft() {
  if (!ready || removing || switching) return;
  clearTimeout(draftTimer); draftVersion++;
  $("draft-status").textContent = "Saving…";
  draftTimer = setTimeout(() => persistDraft().catch(() => {}), 300);
}
function persistDraft() {
  clearTimeout(draftTimer);
  if (!ready || removing) return draftTail;
  const version = ++draftVersion;
  const draft = { id: chat.id, account: chat.account, text: $("prompt").value, contexts: structuredClone(contexts) };
  const signature = JSON.stringify(draft);
  if (signature === savedDraft) { $("draft-status").textContent = draft.text || draft.contexts.length ? "Draft saved" : ""; return draftTail; }
  const result = draftTail.then(() => rpc("draft.save", { draft, tabId: sourceTab }));
  draftTail = result.catch(() => {});
  return result.then(saved => {
    if (version !== draftVersion || removing) return;
    savedDraft = signature;
    updateChatURL();
    $("draft-status").textContent = draft.text || draft.contexts.length ? "Draft saved" : "";
    if (saved.contexts.some((context, index) => context.text.length < draft.contexts[index].text.length)) {
      notice("Long attachments were shortened in the saved draft. Your current message still has the original excerpts.");
    }
  }, error => {
    if (version === draftVersion && !removing) { $("draft-status").textContent = "Draft not saved"; notice(`Could not save this draft: ${error.message}`); }
    throw error;
  });
}
async function loadChat(id) {
  const account = auth.account ?? "local";
  const [loaded, draft] = await Promise.all([rpc("chat.load", { id }), rpc("draft.load", { id })]);
  if (removing || account !== (auth.account ?? "local")) return;
  attachmentUI.reset();
  savedDraft = ""; notice("");
  $("activity").hidden = true;
  if (loaded) chat = loaded;
  else { freshChat(); if (draft) chat.id = id; }
  contexts = draft?.contexts ?? [];
  $("prompt").value = draft?.text ?? "";
  $("draft-status").textContent = draft ? "Draft restored" : "";
  resizePrompt(); renderAttachments(); renderMessages(); scrollDown(true);
}
async function navigateChat(id) {
  if (running || switching || removing || !ready) return;
  switching = true; setRunning(false);
  try {
    await persistDraft();
    if (id) await loadChat(id); else freshChat();
    await persistDraft();
    $("history-dialog").close(); notice("");
  } finally { switching = false; setRunning(false); $("prompt").focus(); }
}
function scrollDown(force = false) {
  const main = $("conversation");
  if (force || main.scrollHeight - main.scrollTop - main.clientHeight < 180) main.scrollTop = main.scrollHeight;
}
function renderMessages() {
  $("messages").replaceChildren(); $("welcome").hidden = chat.messages.length > 0;
  $("conversation-title").textContent = chat.messages.length ? chat.title : "New chat";
  updateChatURL();
  chat.messages.forEach((message, index) => appendMessage(message, index));
}
function updateChatURL() {
  if (window.top !== window || removing) return;
  const url = new URL(location.href);
  if (chat.messages.length || $("prompt").value || contexts.length) url.searchParams.set("chat", chat.id);
  else url.searchParams.delete("chat");
  history.replaceState(null, "", url);
}
function appendMessage(message, index) {
  const article = document.createElement("article"); article.className = `message ${message.role}`;
  const tools = document.createElement("div"); tools.className = "message-tools";
  const copy = document.createElement("button"); copy.textContent = "Copy";
  copy.onclick = guard(async () => { await navigator.clipboard.writeText(message.text); notice("Copied to clipboard.", true); });
  tools.append(copy);
  if (message.role === "user") {
    const body = document.createElement("div"); body.className = "user-content"; body.textContent = message.text;
    const edit = document.createElement("button"); edit.textContent = "Edit"; edit.disabled = running || switching || removing;
    edit.dataset.chatAction = "edit";
    edit.onclick = () => {
      editingIndex = index; $("edit-error").hidden = true; $("edit-prompt").value = message.text; $("edit-dialog").showModal(); $("edit-prompt").focus();
    };
    tools.append(edit); article.append(body);
    if (message.contexts?.length) {
      const sources = document.createElement("div"); sources.className = "message-sources";
      for (const context of message.contexts) { const source = document.createElement("span"); source.textContent = context.title || "Attached source"; source.title = context.url || context.kind; sources.append(source); }
      article.append(sources);
    }
  }
  else {
    const speaker = document.createElement("div"); speaker.className = "speaker"; speaker.innerHTML = '<span class="chatgpt-mark" aria-hidden="true"></span> Safari Chat';
    const body = document.createElement("div"); body.className = "message-content"; body.innerHTML = markdown(message.text);
    article.append(speaker, body);
    if (chat.messages[index - 1]?.role === "user" && !(running && index === chat.messages.length - 1)) {
      const retry = document.createElement("button"); retry.textContent = message.error ? "Retry" : "Try again";
      retry.title = "Try this message again in a new chat. The original stays in your history.";
      retry.disabled = running || switching || removing; retry.dataset.chatAction = "retry";
      retry.onclick = guard(() => startResponse(branchChat(chat, index - 1)));
      tools.append(retry);
    }
    if (message.error) { const hint = document.createElement("div"); hint.className = "message-error"; hint.textContent = "This response did not complete."; article.append(hint); }
    if (running && message === chat.messages.at(-1)) currentAssistant = body;
  }
  article.append(tools);
  $("messages").append(article);
  return article;
}
function renderAttachments() {
  $("attachments").replaceChildren();
  contexts.forEach((context, index) => {
    const pill = document.createElement("div"); pill.className = "attachment";
    const label = document.createElement("span"); label.textContent = `${context.kind === "selection" ? "❞ " : "▤ "}${context.title}`;
    const remove = document.createElement("button"); remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${context.title}`); remove.disabled = preparing || switching || removing;
    remove.onclick = () => { contexts.splice(index, 1); renderAttachments(); scheduleDraft(); };
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
  scheduleDraft();
  if (context.truncated) notice("This source was trimmed to your context limit.", true);
}
async function attachPage(tabId = sourceTab, selection = false) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Open the extension from the Safari tab you want to read.");
  const owner = chat;
  const context = await rpc("context.read", { tabId, selection });
  if (owner === chat && !removing) addContext(context);
}
function setRunning(value) {
  running = value; $("send-button").hidden = value; $("stop-button").hidden = !value;
  for (const id of ["new-button", "history-button", "model", "effort", "save-settings", "signout-button", "account-button", "popout-button", "open-tab-button", "web-search", "search-chip"]) $(id).disabled = value || switching || removing || !ready;
  for (const button of document.querySelectorAll("[data-chat-action]")) button.disabled = value || switching || removing;
  $("theme-setting").disabled = switching || removing || !ready;
  $("prompt").disabled = switching || removing || !ready;
  for (const id of ["attach-page", "attach-tabs", "attach-file", "file-input", "add-button", "menu-page", "menu-tabs"]) $(id).disabled = preparing || switching || removing || !ready;
  for (const button of document.querySelectorAll("#attachments button, [data-prompt]")) button.disabled = preparing || switching || removing || !ready;
  resizePrompt();
  if (!value) { $("approval").hidden = true; pendingApproval = null; }
}
async function save() { await rpc("chat.save", { chat }); }
function settle(error, cancelled = false) {
  if (!running) return;
  const last = chat.messages.at(-1);
  if (error) { last.error = true; if (!last.text) last.text = cancelled ? "Response stopped." : "No response received."; notice(error); }
  if (cancelled && !$("activity").hidden) { $("activity-label").textContent = "Page task stopped"; $("activity-detail").textContent = "Any completed changes remain on the page."; }
  setRunning(false); renderMessages(); scrollDown();
  save().catch(error => notice(`Could not save this chat: ${error.message}`));
}
function handleStream(event) {
  if (event.type === "data.erasing") { forgetLocalUI(); return; }
  if (removing || !running) return;
  if (event.type === "activity") {
    const names = { read: "Read page", click: "Click element", fill: "Fill field", select: "Choose option", set_checked: "Change checked state", scroll: "Scroll page", navigate: "Visit page", open_tab: "Open tab", close_tab: "Close tab", list_tabs: "List tabs", web_search: "Search the web" };
    $("activity").hidden = false;
    $("activity").dataset.state = event.state;
    $("activity-label").textContent = `${names[event.operation] || "Page action"} · ${event.state === "working" ? "In progress" : event.state === "error" ? "Could not complete" : "Done"}`;
    $("activity-detail").textContent = event.detail || "";
  } else if (event.type === "delta" || event.type === "replace") {
    chat.messages.at(-1).text = event.type === "replace" ? event.text : chat.messages.at(-1).text + event.text;
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
  event?.preventDefault(); if (running || switching || removing || !ready) return;
  const text = $("prompt").value.trim(); if (!text) return;
  await startResponse({ ...chat, messages: [...chat.messages, { role: "user", text, contexts: structuredClone(contexts) }], title: chat.messages.length ? chat.title : text.slice(0, 80) });
}
async function startResponse(candidate) {
  if (running || switching || removing || !ready) return;
  if (!auth.connected || !auth.canInfer) throw new Error("Connect your ChatGPT account or API key in the companion app first.");
  if (!$("model").value) throw new Error("Choose a model before sending a message.");
  notice("");
  $("activity").hidden = true;
  port?.disconnect(); port = null;
  preparing = true; cancelPreparation = false;
  setRunning(true); // Lock submission before asynchronous storage/native calls.
  $("prompt").readOnly = true;
  try {
    await persistDraft();
    if (candidate.id !== chat.id) await save(); // Keep the source recent when bounded history evicts older chats.
    if (!cancelPreparation) await rpc("chat.save", { chat: candidate });
  }
  catch (error) { setRunning(false); throw error; }
  finally { preparing = false; $("prompt").readOnly = false; setRunning(running); }
  if (removing) return;
  if (cancelPreparation) { setRunning(false); notice("Response stopped before sending.", true); return; }
  chat = candidate;
  contexts = []; renderAttachments(); $("prompt").value = ""; $("prompt").style.height = "auto";
  persistDraft().catch(() => {});
  $("edit-dialog").close();
  $("prompt").focus();
  chat.messages.push({ role: "assistant", text: "" }); renderMessages(); scrollDown(true);
  try { port = browser.runtime.connect({ name: "chat" }); } catch (error) { settle(error.message); return; }
  const currentPort = port;
  port.onMessage.addListener(event => { if (port === currentPort) handleStream(event); });
  port.onDisconnect.addListener(() => { if (running && port === currentPort) settle("The extension disconnected. Reopen the panel and try again."); });
  try { port.postMessage({ type: "run", chatId: chat.id, title: chat.title, account: chat.account, model: $("model").value, effort: $("effort").value || "auto", webSearch: prefs.webSearch, embedded: window.top !== window, messages: chat.messages.slice(0, -1).filter(m => !m.error) }); }
  catch (error) { settle(error.message); }
}
function renderEffort(preferred = prefs.reasoningEffort) {
  const efforts = modelChoices.find(model => model.id === $("model").value)?.reasoningEfforts ?? [];
  $("effort").replaceChildren();
  for (const value of ["auto", ...efforts]) {
    const option = document.createElement("option"); option.value = value;
    option.textContent = `Effort: ${EFFORT_LABELS[value]}`; $("effort").append(option);
  }
  $("effort").value = efforts.includes(preferred) ? preferred : "auto";
  $("effort-control").hidden = efforts.length === 0;
}
async function loadBootstrap() {
  if (removing || switching) return;
  const revision = preferenceRevision;
  const result = await rpc("bootstrap", { tabId: sourceTab });
  if (running || removing || switching) return;
  if (result.removalPrepared) { forgetLocalUI(); return; }
  const previous = auth.account ?? "local";
  const restore = !ready || previous !== (result.auth.account ?? "local");
  if (restore) { clearTimeout(draftTimer); draftVersion++; ready = false; setRunning(false); }
  if (revision === preferenceRevision) prefs = { ...result.prefs, ...(themeOverride === null ? {} : { theme: themeOverride }) };
  auth = result.auth; modelChoices = result.models;
  applyTheme(); $("connect-card").hidden = auth.connected && auth.canInfer;
  $("account-label").textContent = auth.connected ? auth.label || "Connected" : "Connect account";
  $("model").replaceChildren();
  for (const model of result.models) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.name; $("model").append(option); }
  if (!result.models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "Choose a model"; $("model").append(option); }
  if (result.models.some(m => m.id === prefs.model)) $("model").value = prefs.model;
  renderEffort();
  if (restore) {
    freshChat();
    $("edit-dialog").close();
    const id = requestedChat || result.activeChat; requestedChat = null;
    try { if (id) await loadChat(id); }
    catch (error) { notice(`Could not restore this chat: ${error.message}`); }
    if (removing) return;
    ready = true; setRunning(false);
    if (result.activeChat === chat.id) savedDraft = JSON.stringify({ id: chat.id, account: chat.account, text: $("prompt").value, contexts });
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
  attachmentUI.reset();
  themeRevision++; themeOverride = null; preferenceRevision++;
  ready = false; clearTimeout(draftTimer); draftVersion++;
  setRunning(false);
  port?.disconnect(); port = null;
  chat = { id: "", account: "local", title: "", messages: [] };
  contexts = []; chats = []; modelChoices = []; auth = { connected: false, account: "local" }; prefs = { ...DEFAULTS };
  requestedChat = null; currentAssistant = null;
  savedDraft = ""; editingIndex = null; $("edit-dialog").close(); $("edit-prompt").value = ""; $("draft-status").textContent = "";
  $("activity").hidden = true; $("activity-label").textContent = ""; $("activity-detail").textContent = "";
  $("prompt").value = ""; $("history-search").value = ""; $("history-list").replaceChildren(); $("tabs-list").replaceChildren();
  $("approval-detail").textContent = ""; $("approval-title").textContent = "";
  renderMessages(); renderAttachments(); applyTheme();
  $("connect-card").hidden = true; $("account-label").textContent = "Data cleanup";
  $("model").replaceChildren(); $("usage").textContent = ""; $("usage").removeAttribute("title");
  renderEffort();
  $("file-input").value = "";
  for (const element of document.querySelectorAll("button,input,textarea,select")) element.disabled = true;
  for (const id of ["close-button", "settings-button", "erase-data-button", "finish-removal-button", "retry-companion-button"]) $(id).disabled = false;
  document.querySelectorAll("[data-close]").forEach(button => { button.disabled = false; });
  $("finish-removal-button").hidden = false;
  notice("Local data cleanup has started. Use settings to check the result and finish removal.");
}

if (globalThis.browser?.runtime?.onMessage) browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === browser.runtime.id && message.type === "data.erasing") forgetLocalUI();
  if (sender.id === browser.runtime.id && message.type === "auth.changed" && !removing) {
    if (message.error) notice(message.error);
    else bootstrap().then(() => notice("Connected. You can continue here.", true)).catch(error => notice(error.message));
  }
});
function openSettings() {
  $("theme-setting").value = prefs.theme;
  $("desktop-setting").checked = prefs.desktopControl;
  $("page-setting").value = prefs.pageChars; $("budget-setting").value = prefs.inputChars; $("turns-setting").value = prefs.historyTurns;
  $("settings-dialog").showModal();
}
function renderHistory() {
  $("history-list").replaceChildren();
  const query = $("history-search").value.toLowerCase();
  for (const item of chats.filter(c => c.title.toLowerCase().includes(query))) {
    const row = document.createElement("div"); row.className = "list-row";
    const open = document.createElement("button"); open.textContent = item.title;
    const date = document.createElement("small"); date.textContent = `${item.draft ? "Draft · " : ""}${new Date(item.updated).toLocaleDateString()}`; open.append(date);
    open.onclick = guard(() => navigateChat(item.id));
    const remove = document.createElement("button"); remove.className = "icon-button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Delete ${item.title}`);
    remove.onclick = guard(async () => {
      if (!confirm(`Delete “${item.title}” and its draft from this Mac?`)) return;
      await persistDraft();
      await rpc("chat.delete", { id: item.id }); chats = chats.filter(c => c.id !== item.id);
      if (chat.id === item.id) { freshChat(); await persistDraft(); }
      renderHistory();
    });
    row.append(open, remove); $("history-list").append(row);
  }
  if (!$("history-list").children.length) $("history-list").textContent = query ? "No matching chats." : "No chats yet.";
}

$("composer").onsubmit = guard(send);
$("prompt").onkeydown = guard(event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) return send(event); });
$("prompt").oninput = () => { resizePrompt(); scheduleDraft(); };
$("stop-button").onclick = () => { if (preparing) cancelPreparation = true; port?.postMessage({ type: "cancel" }); $("approval").hidden = true; };
$("new-button").onclick = guard(() => navigateChat());
$("close-button").onclick = guard(async () => { await persistDraft(); port?.postMessage({ type: "cancel" }); await rpc("panel.close"); if (window.top === window) window.close(); });
$("edit-form").onsubmit = guard(async event => {
  event.preventDefault(); $("edit-error").hidden = true;
  try { await startResponse(branchChat(chat, editingIndex, $("edit-prompt").value)); }
  catch (error) { $("edit-error").textContent = error.message; $("edit-error").hidden = false; }
});
$("connect-button").onclick = guard(() => openCompanion(true));
$("api-key-button").onclick = guard(() => openCompanion());
$("account-button").onclick = guard(() => openCompanion(!auth.connected));
$("retry-companion-button").onclick = guard(() => openCompanion(companionSignIn));
$("attach-page").onclick = guard(() => attachPage());
const attachmentUI = setupAttachments({
  state: () => ({ owner: chat, contexts, pageChars: prefs.pageChars, blocked: preparing || switching || removing || !ready }),
  add: addContext, readPage: attachPage, listTabs: () => rpc("tabs.list"), report: message => notice(message),
});
document.querySelectorAll("[data-prompt]").forEach(button => { button.onclick = guard(async () => {
  if (button.dataset.prompt === "summarize") { await attachPage(); $("prompt").value = "Summarize this page. Highlight the key points and anything I should pay attention to."; }
  if (button.dataset.prompt === "explain") { await attachPage(sourceTab, true); $("prompt").value = "Explain this in clear, simple terms."; }
  if (button.dataset.prompt === "write") $("prompt").value = "Help me write ";
  resizePrompt(); scheduleDraft(); $("prompt").focus();
}); });
$("settings-button").onclick = openSettings;
$("theme-setting").onchange = guard(() => changeTheme($("theme-setting").value));
async function chooseSearch(enabled) {
  attachmentUI.closeMenu(); $("web-search").disabled = true; $("search-chip").disabled = true;
  try { await savePreferences({ webSearch: enabled }); }
  finally { $("web-search").disabled = running || removing || !ready; $("search-chip").disabled = running || removing || !ready; }
}
$("web-search").onclick = guard(() => chooseSearch(!prefs.webSearch));
$("search-chip").onclick = guard(() => chooseSearch(false));
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
$("finish-removal-button").onclick = guard(() => openCompanion());
async function popout() {
  if (running) return;
  if (chat.messages.length) await save();
  await persistDraft();
  await rpc("panel.popout", { tabId: sourceTab, chatId: chat.id });
  $("settings-dialog").close();
}
$("popout-button").onclick = guard(popout);
$("open-tab-button").onclick = guard(popout);
$("save-settings").onclick = guard(async () => {
  await changeTheme($("theme-setting").value);
  await savePreferences({ desktopControl: $("desktop-setting").checked, pageChars: Number($("page-setting").value), inputChars: Number($("budget-setting").value), historyTurns: Number($("turns-setting").value) });
  $("settings-dialog").close();
});
$("model").onchange = guard(async () => {
  renderEffort($("effort").value);
  await savePreferences({ model: $("model").value, reasoningEffort: $("effort").value });
});
$("effort").onchange = guard(async () => {
  await savePreferences({ model: $("model").value, reasoningEffort: $("effort").value });
});
$("history-button").onclick = guard(async () => { await persistDraft(); chats = await rpc("chats.list"); renderHistory(); $("history-dialog").showModal(); });
$("history-search").oninput = renderHistory;
$("signout-button").onclick = guard(async () => { await persistDraft(); await rpc("auth.signout"); $("settings-dialog").close(); await bootstrap(); });
$("export-button").onclick = () => {
  const text = chat.messages.map(m => `## ${m.role === "user" ? "You" : "Safari Chat"}\n\n${m.text}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a"); link.href = url; link.download = "safari-chat.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const [id, allow] of [["approve-button", true], ["decline-button", false]]) $(id).onclick = () => { port?.postMessage({ type: "approval", id: pendingApproval, allow }); pendingApproval = null; $("approval").hidden = true; };
document.querySelectorAll("[data-close]").forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistDraft().catch(() => {});
  else if (!running) bootstrap().catch(error => notice(error.message));
});
window.addEventListener("pagehide", () => { persistDraft().catch(() => {}); });
window.addEventListener("focus", () => { if (!running) bootstrap().catch(error => notice(error.message)); });
freshChat();
setRunning(false);
bootstrap().catch(error => { $("connect-card").hidden = false; notice(error.message); });
