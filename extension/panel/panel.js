import { DEFAULTS } from "../core/config.js";
import { estimateTokens } from "../core/context.js";
import { markdown } from "./markdown.js";
import { branchChat } from "./conversation.js";
import { EFFORT_LABELS } from "../core/models.js";
import { setupAttachments } from "./attachments.js";
import { setupWebsiteControls } from "./website-controls.js";
import { accessKey } from "../core/website-access.js";

const $ = id => document.getElementById(id);
const tabParameter = new URL(location.href).searchParams.get("tab");
const sourceTab = tabParameter !== null && /^\d+$/.test(tabParameter) ? Number(tabParameter) : null;
const embedded = window.top !== window;
let dockToken;
const editor = crypto.randomUUID();
let prefs = { ...DEFAULTS };
let modelChoices = [];
let loadingCatalog = null;
let accountKnown = false;
let auth = { connected: false, account: "local" };
let chat;
let contexts = [];
let port;
let running = false;
let currentAssistant;
let paintScheduled = false;
let noticeTimer;
let chats = [];
let bootstrapPending;
let requestedChat = new URL(location.href).searchParams.get("chat");
let removing = false;
let openingCompanion = false;
let companionRoute = "auth.open";
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
let modelIntent = null;
let modelSave = Promise.resolve();
const settingFields = { "desktop-setting": "desktopControl", "page-setting": "pageChars", "budget-setting": "inputChars", "turns-setting": "historyTurns" };
const savingFields = new Set();

const rpc = async (type, payload = {}) => {
  if (removing && !["data.erase", "auth.open", "panel.close"].includes(type)) throw new Error("Local data was erased. Close this panel before removing Safari Chat.");
  if (!globalThis.browser?.runtime) throw new Error("This preview is not connected to Safari. Build and enable the extension to use chat.");
  const result = await browser.runtime.sendMessage({ type, generation: auth.generation, dockToken, ...payload });
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
async function openCompanion(route = "auth.open") {
  if (openingCompanion) return;
  companionRoute = route;
  openingCompanion = true;
  try {
    await rpc(route);
    $("companion-dialog").close();
    notice(route === "auth.signin" ? "Finish signing in in your browser, then return here." : route === "auth.apikey" ? "Enter your API key in Safari Chat, then return here." : "Manage your account in Safari Chat, then return here.", route !== "auth.signin");
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
  $("retry-theme").hidden = true; $("theme-status").textContent = "Saving appearance…";
  // Keep rapid changes in order; an older acknowledgement must not repaint
  // a newer choice. Only the changed field is written to shared settings.
  themeSave = themeSave.catch(() => {}).then(() => rpc("settings.save", { settings: { theme } })).then(saved => {
    if (revision !== themeRevision || removing) return;
    themeOverride = null; prefs.theme = saved.theme; preferenceRevision++;
    applyTheme(); $("theme-status").textContent = "Appearance saved.";
  }).catch(error => {
    if (revision === themeRevision && !removing) {
      $("theme-status").textContent = `Appearance changed here but could not be saved: ${error.message}`;
      $("retry-theme").hidden = false;
    }
    throw error;
  });
  return themeSave;
}
globalThis.browser?.storage?.onChanged?.addListener((changes, area) => {
  if (removing || area !== "local") return;
  const rules = auth.connected && changes[accessKey(auth.account)];
  if (rules) websiteUI.update(rules.newValue);
  const updated = changes.settings?.newValue;
  if (!updated) return;
  for (const key of [...Object.values(settingFields), "webSearch"]) if (updated[key] !== undefined) prefs[key] = updated[key];
  syncFields(); applyTheme();
  if (!modelIntent && !running && modelChoices.some(model => model.id === updated.model)) {
    prefs.model = updated.model; prefs.reasoningEffort = updated.reasoningEffort;
    $("model").value = prefs.model; renderEffort();
  }
  const theme = updated.theme;
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
  $("send-button").disabled = !ready || !auth.canInfer || !$("model").value || switching || removing || !$("prompt").value.trim();
}
function scheduleDraft() {
  if (!ready || removing || switching) return;
  clearTimeout(draftTimer); draftVersion++;
  if (embedded) rpc("draft.stage", { editor, sequence: draftVersion, draft: { id: chat.id, account: chat.account, revision: chat.draftRevision ?? 0, chatRevision: chat.revision ?? 0, text: $("prompt").value, contexts } }).catch(() => {});
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
    const saved = await rpc("draft.save", { draft: { ...draft, id: target, revision: owner.draftRevision ?? 0, chatRevision: owner.revision ?? 0 }, generation, tabId: sourceTab, editor, sequence: version });
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
  $("conversation-title").textContent = chat.title;
  $("history-button").title = chat.messages.length ? `${chat.title} · Recent chats` : "Recent chats";
  $("prompt").placeholder = chat.messages.length ? "Ask for follow-up changes" : "Ask anything or @mention a tab";
  renderConnection();
  updateChatURL();
  chat.messages.forEach((message, index) => appendMessage(message, index));
}
function renderConnection() {
  const connected = auth.connected && auth.canInfer;
  const card = $("connect-card");
  const parent = chat?.messages.length ? $("composer").parentElement : $("welcome");
  if (card.parentElement !== parent) parent.append(card);
  card.hidden = !!connected || !accountKnown || removing;
  $("opening-chat").hidden = accountKnown || removing;
  document.querySelector(".starters").hidden = !connected || removing;
  card.querySelector("h1").textContent = auth.connected ? "Enable chat for this account" : "Connect to Safari Chat";
  card.querySelector("p").textContent = auth.connected ? "Enable ChatGPT plan usage in the companion app or connect an API key." : "Use your ChatGPT account or an API key to chat beside this page.";
  $("connect-button").textContent = auth.connected ? "Manage account" : "Continue with ChatGPT";
  $("run-options").hidden = !connected || removing;
  $("composer").hidden = !connected || removing;
  $("retry-models").hidden = !connected || !!loadingCatalog || modelChoices.length > 0;
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
    if (running && message === chat.messages.at(-1)) { currentAssistant = body; tools.hidden = true; }
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
  for (const id of ["new-button", "history-button", "model", "effort", "signout-button", "account-button", "web-search", "search-chip"]) $(id).disabled = value || switching || removing || !ready;
  $("source-button").disabled = removing || !ready;
  $("history-button").disabled ||= !auth.generation;
  $("signout-button").disabled ||= !auth.connected;
  $("model").disabled ||= !modelChoices.length;
  $("retry-models").disabled = value || switching || removing || !ready;
  websiteUI.refresh();
  for (const button of document.querySelectorAll("[data-chat-action]")) button.disabled = value || switching || removing;
  $("theme-setting").disabled = switching || removing || !ready;
  for (const id of Object.keys(settingFields)) $(id).disabled = switching || removing || !ready || savingFields.has(id);
  $("prompt").disabled = switching || removing || !ready;
  for (const id of ["attach-file", "file-input", "add-button", "menu-page", "menu-tabs"]) $(id).disabled = preparing || switching || removing || !ready;
  for (const button of document.querySelectorAll("#attachments button, [data-prompt]")) button.disabled = preparing || switching || removing || !ready;
  resizePrompt();
  if (!value) websiteUI.dismiss();
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
  if (!error) $("activity").hidden = true;
  setRunning(false); renderMessages(); scrollDown();
  if (pendingShare) takeSharedContext().catch(failure => notice(failure.message));
  // Once a run is delivered, the background owns its final write even when the panel closes.
  if (terminal?.saved) persistDraft().catch(() => {});
  else if (!terminal) {
    const owner = chat;
    rpc("chat.save", { chat: owner }).then(saved => { if (chat === owner) { acceptSave(owner, saved); renderMessages(); } }).catch(error => notice(`Could not save this chat: ${error.message}`));
  }
}
function handleStream(event, runID, draftChatId) {
  if (event.type === "data.erasing") { forgetLocalUI(); return; }
  if (removing || !running) return;
  if (event.type === "resumed") {
    if (!draftChatId || chat.id !== draftChatId) Object.assign(chat, event.chat);
    chat.messages = [...event.chat.messages, { role: "assistant", text: event.text }];
    renderMessages(); scrollDown(true);
    for (const update of event.events) handleStream(update, runID);
  } else if (event.type === "run.ended") {
    const version = accountChange;
    switching = true; setRunning(false);
    loadChat(draftChatId ?? event.saved?.id ?? runID).then(() => { if (event.message && version === accountChange) notice(event.message); })
      .catch(error => notice(error.message)).finally(() => { if (version === accountChange) { switching = false; setRunning(false); } });
  } else if (event.type === "approval.answered") websiteUI.dismiss();
  else if (event.type === "activity") {
    const names = { read: "Read page", click: "Click element", fill: "Fill field", select: "Choose option", set_checked: "Change checked state", scroll: "Scroll page", navigate: "Visit page", open_tab: "Open tab", close_tab: "Close tab", list_tabs: "List tabs", web_search: "Search the web" };
    $("activity").hidden = false;
    $("activity").dataset.state = event.state;
    if (currentAssistant && !chat.messages.at(-1).text) currentAssistant.textContent = "";
    $("activity-label").textContent = `${names[event.operation] || "Page action"} · ${event.state === "working" ? "In progress" : event.state === "error" ? "Could not complete" : "Done"}`;
    $("activity-detail").textContent = event.detail || "";
  } else if (event.type === "delta" || event.type === "replace") {
    chat.messages.at(-1).text = event.type === "replace" ? event.text : chat.messages.at(-1).text + event.text;
    if (!paintScheduled) {
      paintScheduled = true;
      // WebKit can suspend animation frames when the website loses focus.
      setTimeout(() => {
        paintScheduled = false;
        if (!currentAssistant || !running) return;
        currentAssistant.classList.remove("typing");
        currentAssistant.textContent = chat.messages.at(-1).text;
        scrollDown();
      }, 32);
    }
  } else if (event.type === "status" && currentAssistant && !chat.messages.at(-1).text) { currentAssistant.textContent = event.text; currentAssistant.classList.add("typing"); }
  else if (event.type === "context" && event.trimmed) notice("Using recent turns and a bounded selection of your attachments.", true);
  else if (event.type === "usage") { $("usage").textContent = `${(event.usage.input + event.usage.output).toLocaleString()} tokens`; $("usage").title = `${event.usage.input} input · ${event.usage.cached} cached · ${event.usage.output} output · ${event.usage.requests} requests`; }
  else if (event.type === "approval") websiteUI.show(event);
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
  const model = $("model").value, effort = $("effort").value || "auto";
  notice("");
  $("activity").hidden = true;
  port?.disconnect(); port = null;
  preparing = true; cancelPreparation = false;
  const owner = chat, continuing = candidate.id === owner.id, version = accountChange;
  setRunning(true); // Lock submission before asynchronous storage/native calls.
  $("prompt").readOnly = true;
  try {
    await websiteUI.saved;
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
  connectRun({ type: "run", chatId: chat.id, revision: chat.revision, title: chat.title, account: chat.account, generation: auth.generation, model, effort, webSearch: prefs.webSearch, messages: chat.messages.slice(0, -1) });
}
function connectRun(message) {
  try { port = browser.runtime.connect({ name: "chat" }); } catch (error) { settle(error.message, false, message.type === "resume" ? {} : undefined); return; }
  const currentPort = port;
  const runID = message.chatId;
  port.onMessage.addListener(event => { if (port === currentPort) handleStream(event, runID, message.draftChatId); });
  port.onDisconnect.addListener(() => { if (running && port === currentPort) settle("The extension disconnected. Reopen this chat to check its saved response.", false, {}); });
  try { port.postMessage({ ...message, dockToken }); } catch (error) { settle(error.message, false, message.type === "resume" ? {} : undefined); }
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
  $("model-name").textContent = $("model").selectedOptions[0]?.textContent ?? "Choose a model";
  $("model").title = $("model-name").textContent;
  $("effort-name").textContent = $("effort").selectedOptions[0]?.textContent ?? EFFORT_LABELS.auto;
}
function renderModelChoices(choices) {
  modelChoices = choices;
  $("model").replaceChildren();
  for (const model of choices) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.name; $("model").append(option); }
  const hasSavedModel = choices.some(model => model.id === prefs.model);
  const missing = prefs.model && !hasSavedModel;
  if (!choices.length || missing) {
    const option = document.createElement("option"); option.value = ""; option.disabled = true;
    option.textContent = choices.length ? "Choose a model" : loadingCatalog ? "Loading models…" : "No models available";
    $("model").prepend(option); $("model").value = "";
  }
  if (hasSavedModel) $("model").value = prefs.model;
  renderEffort();
  renderConnection(); setRunning(running);
}
async function loadModelChoices() {
  const { account, generation } = auth;
  if (loadingCatalog === generation || !generation || removing) return;
  loadingCatalog = generation; renderModelChoices(modelChoices);
  let choices = modelChoices;
  try { choices = await rpc("models.list", { account, generation }); }
  catch (error) { if (!removing && generation === auth.generation) notice(error.message); }
  finally {
    if (!removing && loadingCatalog === generation && auth.generation === generation) {
      loadingCatalog = null; renderModelChoices(choices);
    }
  }
}
async function loadBootstrap() {
  if (removing || switching) return;
  const revision = preferenceRevision;
  const accessRevision = websiteUI.revision;
  const version = accountChange;
  const result = await rpc("bootstrap", { tabId: sourceTab, chatId: requestedChat || (ready ? chat.id : undefined), openEditor: ready ? undefined : editor });
  if (version !== accountChange || running || removing || switching) return;
  if (result.removalPrepared) { forgetLocalUI(); return; }
  const previous = auth.account ?? "local";
  const changed = ready && (previous !== (result.auth.account ?? "local") || auth.generation !== result.auth.generation);
  const restore = !ready || changed;
  if (restore) { clearTimeout(draftTimer); draftVersion++; ready = false; setRunning(false); }
  if (revision === preferenceRevision) prefs = { ...DEFAULTS, ...result.prefs, ...modelIntent, ...(themeOverride === null ? {} : { theme: themeOverride }) };
  auth = result.auth; accountKnown = true;
  applyTheme(); renderConnection();
  $("account-label").textContent = auth.connected ? auth.label || "Connected" : "Connect account";
  document.querySelector(".account-avatar").textContent = ($("account-label").textContent[0] || "S").toUpperCase();
  if (restore) {
    if (changed) { clearAccountViews(); requestedChat = null; }
    freshChat();
    $("edit-dialog").close();
    const id = result.run?.draftChatId || result.run?.chatId || requestedChat || result.activeChat; requestedChat = null;
    try { if (id) await loadChat(id); }
    catch (error) { notice(`Could not restore this chat: ${error.message}`); }
    if (removing || version !== accountChange) return;
    ready = true; setRunning(false);
    if (result.activeChat === chat.id) savedDraft = JSON.stringify({ id: chat.id, account: chat.account, text: $("prompt").value, contexts });
    if (result.run) {
      setRunning(true);
      chat.messages.push({ role: "assistant", text: "" }); renderMessages();
      connectRun({ type: "resume", ...result.run, account: auth.account, generation: auth.generation });
    }
  }
  if (result.models) renderModelChoices(result.models);
  else loadModelChoices().catch(error => notice(error.message));
  if (changed || (!websiteUI.saved && accessRevision === websiteUI.revision)) websiteUI.update(result.access);
  setRunning(running);
  if (auth.error) notice(auth.error);
  if (result.hasContext || pendingShare) await takeSharedContext().catch(error => notice(error.message));
}
function bootstrap() {
  if (!bootstrapPending) bootstrapPending = loadBootstrap().finally(() => { bootstrapPending = null; });
  return bootstrapPending;
}
function forgetLocalUI() {
  removing = true;
  modelIntent = null; websiteUI.reset();
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
  $("settings-status").textContent = ""; $("theme-status").textContent = ""; $("retry-theme").hidden = true;
  $("finish-removal-button").hidden = false;
  $("data-section").open = true;
  notice("Local data cleanup has started. Use settings to check the result and finish removal.");
}

function clearAccountViews() {
  modelIntent = null; loadingCatalog = null; modelChoices = [];
  $("model").replaceChildren(); renderEffort(); websiteUI.reset();
  chats = []; editingIndex = null;
  $("history-list").replaceChildren(); $("history-search").value = ""; $("edit-prompt").value = "";
  $("approval-title").textContent = ""; $("approval-detail").textContent = ""; $("usage").removeAttribute("title");
  for (const id of ["history-dialog", "edit-dialog", "settings-dialog"]) $(id).close();
}
function accountChanged() {
  accountKnown = false; accountChange++; clearTimeout(draftTimer); draftVersion++; cancelPreparation = true;
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
function syncFields() {
  for (const [id, key] of Object.entries(settingFields)) {
    if (savingFields.has(id)) continue;
    if (key === "desktopControl") $(id).checked = prefs[key]; else $(id).value = prefs[key];
  }
}
function openSettings() {
  $("theme-setting").value = prefs.theme; syncFields();
  $("settings-dialog").showModal();
}
function renderHistory() {
  $("history-list").replaceChildren();
  const query = $("history-search").value.toLowerCase();
  for (const item of chats.filter(c => c.title.toLowerCase().includes(query))) {
    const row = document.createElement("div"); row.className = "list-row";
    const open = document.createElement("button"); open.textContent = item.title;
    if (item.id === chat.id) open.setAttribute("aria-current", "true");
    const date = document.createElement("small"); date.textContent = `${item.id === chat.id ? "Current chat · " : ""}${item.draft ? "Draft · " : ""}${new Date(item.updated).toLocaleDateString()}`; open.append(date);
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
$("stop-button").onclick = () => { if (preparing) cancelPreparation = true; port?.postMessage({ type: "cancel" }); websiteUI.dismiss(); };
$("new-button").onclick = guard(() => navigateChat());
$("close-button").onclick = guard(async () => { await persistDraft(); await rpc("panel.close"); if (window.top === window) window.close(); });
$("edit-form").onsubmit = guard(async event => {
  event.preventDefault(); $("edit-error").hidden = true;
  try { await startResponse(branchChat(chat, editingIndex, $("edit-prompt").value)); }
  catch (error) { $("edit-error").textContent = error.message; $("edit-error").hidden = false; }
});
$("connect-button").onclick = guard(() => openCompanion(auth.connected ? "auth.open" : "auth.signin"));
$("api-key-button").onclick = guard(() => openCompanion("auth.apikey"));
$("account-button").onclick = guard(() => openCompanion(auth.connected ? "auth.open" : "auth.signin"));
$("retry-companion-button").onclick = guard(() => openCompanion(companionRoute));
const attachmentUI = setupAttachments({
  state: () => ({ owner: chat, contexts, pageChars: prefs.pageChars, blocked: preparing || switching || removing || !ready }),
  add: addContext, readPage: attachPage, listTabs: () => rpc("tabs.list"), report: message => notice(message),
});
const websiteUI = setupWebsiteControls({
  state: () => ({ account: auth.account, generation: auth.generation, enabled: ready && auth.connected && !removing && !switching }),
  rpc, openSettings, answer: reply => port?.postMessage(reply), report: notice,
});
document.querySelectorAll("[data-prompt]").forEach(button => { button.onclick = guard(async () => {
  if (button.dataset.prompt === "summarize") { await attachPage(); $("prompt").value = "Summarize this page. Highlight the key points and anything I should pay attention to."; }
  if (button.dataset.prompt === "explain") { await attachPage(sourceTab, true); $("prompt").value = "Explain this in clear, simple terms."; }
  if (button.dataset.prompt === "write") $("prompt").value = "Help me write ";
  resizePrompt(); scheduleDraft(); $("prompt").focus();
}); });
$("settings-button").onclick = openSettings;
$("retry-models").onclick = guard(async () => { notice(""); await loadModelChoices(); });
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
$("source-button").hidden = embedded || sourceTab === null;
$("source-button").onclick = guard(async () => {
  await persistDraft();
  await rpc("panel.source");
});
$("retry-theme").onclick = guard(() => changeTheme(prefs.theme));
for (const [id, key] of Object.entries(settingFields)) $(id).onchange = async () => {
  const field = $(id);
  savingFields.add(id); field.disabled = true;
  try {
    await savePreferences({ [key]: key === "desktopControl" ? field.checked : Number(field.value) });
    $("settings-status").textContent = "Setting saved.";
  } catch (error) {
    if (!removing) $("settings-status").textContent = `Could not save this setting. ${error.message}`;
  } finally {
    savingFields.delete(id); syncFields();
    field.disabled = switching || removing || !ready;
  }
};
function saveModelSelection() {
  $("effort-name").textContent = EFFORT_LABELS[$("effort").value];
  const choice = { model: $("model").value, reasoningEffort: $("effort").value };
  modelIntent = choice; Object.assign(prefs, choice); preferenceRevision++;
  modelSave = modelSave.catch(() => {}).then(() => {
    if (modelIntent === choice && !removing) return rpc("settings.save", { settings: choice });
  }).finally(() => { if (modelIntent === choice) modelIntent = null; });
  return modelSave;
}
$("model").onchange = guard(() => { renderEffort($("effort").value); return saveModelSelection(); });
$("effort").onchange = guard(saveModelSelection);
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
document.querySelectorAll("[data-close]").forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
async function refreshOnFocus() {
  if (removing || (embedded && !dockToken)) return;
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
function openPanel() {
  bootstrap().catch(error => { accountKnown = true; renderConnection(); notice(error.message); });
}
if (embedded) {
  const mount = async event => {
    if (event.source !== window.parent || event.data?.type !== "safari-chat.mount" || typeof event.data.token !== "string") return;
    try { await rpc("panel.present", { dockToken: event.data.token }); } catch { return; }
    window.removeEventListener("message", mount);
    dockToken = event.data.token;
    openPanel();
  };
  window.addEventListener("message", mount);
} else openPanel();
