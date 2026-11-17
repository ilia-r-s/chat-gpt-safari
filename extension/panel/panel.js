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
let accountChange = 0;
let switching = false;
let draftTimer;
let draftTail = Promise.resolve();
let draftVersion = 0;
let editingIndex = null;
let savedDraft = "";
let preparing = false;
let cancelPreparation = false;
let pendingShare = false;
let preferenceRevision = 0;
let themeRevision = 0;
let themeOverride = null;
let themeSave = Promise.resolve();

const rpc = async (type, payload = {}) => {
  if (removing && !["data.erase", "auth.open", "panel.close"].includes(type)) throw new Error("Local data was erased. Close this panel before removing Safari Chat.");
  if (!globalThis.browser?.runtime) throw new Error("This preview is not connected to Safari. Build and enable the extension to use chat.");
  const result = await browser.runtime.sendMessage({ type, generation: auth.generation, ...payload });
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
  const owner = chat, generation = auth.generation;
  const draft = { id: owner.id, account: owner.account, text: $("prompt").value, contexts: structuredClone(contexts) };
  const signature = JSON.stringify(draft);
  if (signature === savedDraft) { $("draft-status").textContent = draft.text || draft.contexts.length ? "Draft saved" : ""; return draftTail; }
  const result = draftTail.then(async () => {
    if (generation !== auth.generation || removing) return;
    const target = owner.id;
    const saved = await rpc("draft.save", { draft: { ...draft, id: target, revision: owner.draftRevision ?? 0, chatRevision: owner.revision ?? 0 }, generation, tabId: sourceTab });
    if (generation !== auth.generation || owner.id !== target || removing) return;
    owner.draftRevision = saved.revision;
    if (owner.id !== saved.id) {
      owner.id = saved.id; owner.revision = saved.chatRevision ?? 0;
      if (saved.title) owner.title = saved.title;
      if (owner === chat) { renderMessages(); notice("Another panel edited this draft. Your changes are in a separate copy."); }
    }
    return saved;
  });
  draftTail = result.catch(() => {});
  return result.then(saved => {
    if (!saved || version !== draftVersion || owner !== chat || removing) return;
    savedDraft = JSON.stringify({ ...draft, id: owner.id });
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
  const generation = auth.generation;
  const [loaded, draft] = await Promise.all([rpc("chat.load", { id }), rpc("draft.load", { id })]);
  if (removing || generation !== auth.generation) return;
  attachmentUI.reset();
  savedDraft = ""; notice("");
  $("activity").hidden = true;
  if (loaded) chat = loaded;
  else { freshChat(); if (draft) chat.id = id; }
  chat.draftRevision = draft?.revision ?? 0;
  contexts = draft?.contexts ?? [];
  $("prompt").value = draft?.text ?? "";
  $("draft-status").textContent = draft ? "Draft restored" : "";
  resizePrompt(); renderAttachments(); renderMessages(); scrollDown(true);
}
async function navigateChat(id) {
  if (running || switching || removing || !ready) return;
  const version = accountChange;
  switching = true; setRunning(false);
  try {
    await persistDraft();
    if (version !== accountChange || removing) return;
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
  $("conversation-title").textContent = chat.messages.length ? chat.title : "";
  $("prompt").placeholder = chat.messages.length ? "Ask a follow-up or @mention a tab" : "Ask anything or @mention a tab";
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
function messageButton(label, path) {
  const button = document.createElement("button");
  button.title = label; button.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path);
  svg.append(shape); button.append(svg); return button;
}
function appendMessage(message, index) {
  const article = document.createElement("article"); article.className = `message ${message.role}`;
  const tools = document.createElement("div"); tools.className = "message-tools";
  const copy = messageButton("Copy", "M8 8h12v13H8zM16 8V3H3v13h5");
  copy.onclick = guard(async () => { await navigator.clipboard.writeText(message.text); notice("Copied to clipboard.", true); });
  tools.append(copy);
  if (message.role === "user") {
    const body = document.createElement("div"); body.className = "user-content"; body.textContent = message.text;
    const edit = messageButton("Edit", "m4 15-1 6 6-2L21 7l-5-5zM13 5l5 5"); edit.disabled = running || switching || removing;
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
    article.setAttribute("aria-label", "Safari Chat response");
    if (Number.isFinite(message.workMs)) {
      const duration = document.createElement("p"); duration.className = "work-time";
      duration.textContent = `Worked for ${Math.max(1, Math.round(message.workMs / 1000))}s`; article.append(duration);
    }
    const body = document.createElement("div"); body.className = "message-content"; body.innerHTML = markdown(message.text);
    article.append(body);
    if (chat.messages[index - 1]?.role === "user" && !(running && index === chat.messages.length - 1)) {
      const retry = messageButton(message.error ? "Retry" : "Try again", "M3 11a9 9 0 1 1 2 7M3 4v7h7");
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
async function takeSharedContext() {
  pendingShare = true;
  if (!ready || preparing || switching || removing || !Number.isInteger(sourceTab)) return;
  pendingShare = false;
  const owner = chat;
  const source = await rpc("context.take", { tabId: sourceTab, account: auth.account ?? "local" });
  if (!source || owner !== chat || removing) return;
  if (source.error) notice(source.error);
  else addContext(source);
}
function setRunning(value) {
  running = value; $("send-button").hidden = value; $("stop-button").hidden = !value;
  for (const id of ["new-button", "history-button", "model", "effort", "save-settings", "signout-button", "account-button", "popout-button", "open-tab-button", "web-search", "search-chip"]) $(id).disabled = value || switching || removing || !ready;
  for (const button of document.querySelectorAll("[data-chat-action]")) button.disabled = value || switching || removing;
  $("theme-setting").disabled = switching || removing || !ready;
  $("prompt").disabled = switching || removing || !ready;
  for (const id of ["attach-file", "file-input", "add-button", "menu-page", "menu-tabs"]) $(id).disabled = preparing || switching || removing || !ready;
  for (const button of document.querySelectorAll("#attachments button, [data-prompt]")) button.disabled = preparing || switching || removing || !ready;
  resizePrompt();
  if (!value) { $("approval").hidden = true; pendingApproval = null; }
}
function acceptSave(owner, saved) {
  const fork = saved.id !== owner.id;
  Object.assign(owner, { id: saved.id, revision: saved.revision, title: saved.title });
  if (fork) { owner.draftRevision = 0; notice("Another panel updated this chat. Your changes are in a separate copy."); }
}
function settle(error, cancelled = false, terminal, runID) {
  if (!running) return;
  if (terminal?.saved && runID && chat.id !== runID && chat.id !== terminal.saved.id) {
    // The follow-up editor forked while this response was streaming. Each has its own saved history.
    const owner = chat, version = accountChange;
    switching = true; setRunning(false);
    persistDraft().then(async () => {
      if (owner !== chat || removing) return;
      await loadChat(owner.id);
      if (chat.id === owner.id && !removing) notice(`Your follow-up is in this draft copy. The reply was saved in “${terminal.saved.title}” in Recent chats.`);
    }).catch(failure => notice(failure.message)).finally(() => {
      if (version === accountChange) { switching = false; setRunning(false); }
    });
    return;
  }
  const last = chat.messages.at(-1);
  if (Number.isFinite(terminal?.workMs)) last.workMs = terminal.workMs;
  if (error) { last.error = true; if (!last.text) last.text = cancelled ? "Response stopped." : "No response received."; notice(error); }
  if (cancelled && !$("activity").hidden) { $("activity-label").textContent = "Page task stopped"; $("activity-detail").textContent = "Any completed changes remain on the page."; }
  if (terminal?.saved) acceptSave(chat, terminal.saved);
  if (terminal?.saveError) notice(`Could not save this chat: ${terminal.saveError}`);
  setRunning(false); renderMessages(); scrollDown();
  if (pendingShare) takeSharedContext().catch(failure => notice(failure.message));
  // Once a run is delivered, the background owns its final write even when the panel closes.
  if (terminal?.saved) persistDraft().catch(() => {});
  else if (!terminal) {
    const owner = chat;
    rpc("chat.save", { chat: owner }).then(saved => { if (chat === owner) { acceptSave(owner, saved); renderMessages(); } }).catch(error => notice(`Could not save this chat: ${error.message}`));
  }
}
function handleStream(event, runID) {
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
  else if (event.type === "done") settle(null, false, event, runID);
  else if (event.type === "error" || event.type === "cancelled") settle(event.type === "cancelled" && (!event.message || event.message.includes("abort")) ? "Response stopped." : event.message, event.type === "cancelled", event, runID);
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
  const owner = chat, continuing = candidate.id === owner.id, version = accountChange;
  setRunning(true); // Lock submission before asynchronous storage/native calls.
  $("prompt").readOnly = true;
  try {
    await persistDraft();
    if (continuing) Object.assign(candidate, { id: owner.id, revision: owner.revision, draftRevision: owner.draftRevision });
    if (!cancelPreparation && version === accountChange) {
      const saved = await rpc("chat.save", { chat: candidate });
      if (version !== accountChange) return;
      acceptSave(candidate, saved);
    }
  }
  catch (error) { setRunning(false); throw error; }
  finally { preparing = false; $("prompt").readOnly = false; setRunning(running); }
  if (removing || version !== accountChange) return;
  if (cancelPreparation) { setRunning(false); notice("Response stopped before sending.", true); return; }
  chat = candidate;
  contexts = []; renderAttachments(); $("prompt").value = ""; $("prompt").style.height = "auto";
  persistDraft().catch(() => {});
  $("edit-dialog").close();
  $("prompt").focus();
  chat.messages.push({ role: "assistant", text: "" }); renderMessages(); scrollDown(true);
  try { port = browser.runtime.connect({ name: "chat" }); } catch (error) { settle(error.message); return; }
  const currentPort = port;
  const runID = chat.id;
  port.onMessage.addListener(event => { if (port === currentPort) handleStream(event, runID); });
  port.onDisconnect.addListener(() => { if (running && port === currentPort) settle("The extension disconnected. Reopen this chat to check its saved response.", false, {}); });
  try { port.postMessage({ type: "run", chatId: chat.id, revision: chat.revision, title: chat.title, account: chat.account, generation: auth.generation, model: $("model").value, effort: $("effort").value || "auto", webSearch: prefs.webSearch, embedded: window.top !== window, messages: chat.messages.slice(0, -1) }); }
  catch (error) { settle(error.message); }
}
function renderEffort(preferred = prefs.reasoningEffort) {
  const efforts = modelChoices.find(model => model.id === $("model").value)?.reasoningEfforts ?? [];
  $("effort").replaceChildren();
  for (const value of ["auto", ...efforts]) {
    const option = document.createElement("option"); option.value = value;
    option.textContent = EFFORT_LABELS[value]; $("effort").append(option);
  }
  $("effort").value = efforts.includes(preferred) ? preferred : "auto";
  $("effort-control").hidden = efforts.length === 0;
}
async function loadBootstrap() {
  if (removing || switching) return;
  const revision = preferenceRevision;
  const version = accountChange;
  const result = await rpc("bootstrap", { tabId: sourceTab });
  if (version !== accountChange || running || removing || switching) return;
  if (result.removalPrepared) { forgetLocalUI(); return; }
  const previous = auth.account ?? "local";
  const changed = ready && (previous !== (result.auth.account ?? "local") || auth.generation !== result.auth.generation);
  const restore = !ready || changed;
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
    if (changed) { clearAccountViews(); requestedChat = null; }
    freshChat();
    $("edit-dialog").close();
    const id = requestedChat || result.activeChat; requestedChat = null;
    try { if (id) await loadChat(id); }
    catch (error) { notice(`Could not restore this chat: ${error.message}`); }
    if (removing || version !== accountChange) return;
    ready = true; setRunning(false);
    if (result.activeChat === chat.id) savedDraft = JSON.stringify({ id: chat.id, account: chat.account, text: $("prompt").value, contexts });
  }
  if (result.hasContext || pendingShare) await takeSharedContext();
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

function clearAccountViews() {
  chats = []; editingIndex = null;
  $("history-list").replaceChildren(); $("history-search").value = ""; $("edit-prompt").value = "";
  $("approval-title").textContent = ""; $("approval-detail").textContent = ""; $("usage").removeAttribute("title");
  for (const id of ["history-dialog", "edit-dialog", "settings-dialog"]) $(id).close();
}
function accountChanged() {
  accountChange++; clearTimeout(draftTimer); draftVersion++; cancelPreparation = true;
  ready = false; switching = false; setRunning(false);
  const oldPort = port; port = null; oldPort?.disconnect();
  auth = { connected: false, account: "local" }; requestedChat = null; pendingShare = false;
  clearAccountViews(); freshChat(); $("account-label").textContent = "Updating account…";
  const pending = bootstrapPending ?? Promise.resolve();
  pending.catch(() => {}).then(bootstrap).catch(error => notice(error.message));
}
if (globalThis.browser?.runtime?.onMessage) browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === browser.runtime.id && message.type === "context.available" && message.tabId === sourceTab) takeSharedContext().catch(error => notice(error.message));
  if (sender.id === browser.runtime.id && message.type === "data.erasing") forgetLocalUI();
  if (sender.id === browser.runtime.id && message.type === "auth.changed" && !removing) {
    if (message.error) notice(message.error);
    else if (!message.generation || message.generation !== auth.generation) accountChanged();
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
$("actions-guidance").onclick = () => { openSettings(); $("browser-permissions").focus(); };
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
$("history-button").onclick = guard(async () => {
  const owner = chat;
  await persistDraft(); if (owner !== chat || removing) return;
  const items = await rpc("chats.list"); if (owner !== chat || removing) return;
  chats = items; renderHistory(); $("history-dialog").showModal();
});
$("history-search").oninput = renderHistory;
$("signout-button").onclick = guard(async () => { await persistDraft(); const result = await rpc("auth.signout"); $("settings-dialog").close(); await bootstrap(); notice(result.message); });
$("export-button").onclick = () => {
  const text = chat.messages.map(m => `## ${m.role === "user" ? "You" : "Safari Chat"}\n\n${m.text}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a"); link.href = url; link.download = "safari-chat.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const [id, allow] of [["approve-button", true], ["decline-button", false]]) $(id).onclick = () => { port?.postMessage({ type: "approval", id: pendingApproval, allow }); pendingApproval = null; $("approval").hidden = true; };
document.querySelectorAll("[data-close]").forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
async function refreshOnFocus() {
  if (removing) return;
  if (!running && !switching) return bootstrap();
  const generation = auth.generation;
  const state = await rpc("auth.check").catch(() => ({}));
  if (!removing && generation === auth.generation && state?.generation !== generation) accountChanged();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistDraft().catch(() => {});
  else refreshOnFocus().catch(error => notice(error.message));
});
window.addEventListener("pagehide", () => { persistDraft().catch(() => {}); });
window.addEventListener("focus", () => refreshOnFocus().catch(error => notice(error.message)));
freshChat();
setRunning(false);
bootstrap().catch(error => { $("connect-card").hidden = false; notice(error.message); });
