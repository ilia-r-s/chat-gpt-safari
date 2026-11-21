import { DEFAULTS, MAX_TURN_MINUTES } from "../core/config.js";
import { CHATGPT_USAGE_LIMIT } from "../core/api-errors.js";
import { estimateTokens } from "../core/context.js";
import { markdown } from "./markdown.js";
import { branchChat, continuationMessage } from "./conversation.js";
import { setupModelPicker } from "./model-picker.js";
import { createVoice } from "./voice.js";
import { setupAttachments } from "./attachments.js";
import { setupWebsiteControls } from "./website-controls.js";
import { setupTabAccess } from "./tab-access.js";
import { accessKey } from "../core/website-access.js";
import { showActionPointer } from "../content/action-pointer.js";

const $ = id => document.getElementById(id);
const tabParameter = new URL(location.href).searchParams.get("tab");
const sourceTab = tabParameter !== null && /^\d+$/.test(tabParameter) ? Number(tabParameter) : null;
const embedded = window.top !== window;
let dockToken;
let temporaryId = null;
const editor = crypto.randomUUID();
let prefs = { ...DEFAULTS };
let modelChoices = [];
let runMode;
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
const settingFields = { "desktop-setting": "desktopControl", "page-setting": "pageChars", "budget-setting": "inputChars", "turns-setting": "historyTurns", "actions-setting": "maxBrowserActions", "time-setting": "turnMinutes" };
$("time-setting").max = String(MAX_TURN_MINUTES);
const savingFields = new Set();
const actionNames = { gesture: "Perform gesture", zoom: "Zoom tab", back: "Go back", forward: "Go forward", read: "Read page", find_text: "Find text on page", click: "Click element", fill: "Fill field", select: "Choose option", set_checked: "Change checked state", scroll: "Scroll page", scroll_until: "Find on page", double_click: "Double-click", type_text: "Type into field", press_key: "Press key", select_text: "Select text", copy: "Copy selection", paste: "Paste text", delete_selection: "Delete selection", replace_selection: "Replace selection", drag: "Drag pointer", move_pointer: "Move pointer", set_speed: "Change speed", wait_motion: "Wait for motion", stop_motion: "Stop motion", navigate: "Visit page", open_tab: "Open tab", switch_tab: "Switch tab", close_tab: "Close tab", list_tabs: "List tabs", web_search: "Search the web" };

const rpc = async (type, payload = {}) => {
  if (removing && !["data.erase", "auth.open", "panel.close"].includes(type)) throw new Error("Local data was erased. Close this panel before removing Safari Chat.");
  if (!globalThis.browser?.runtime) throw new Error("This preview is not connected to Safari. Build and enable the extension to use chat.");
  const result = await browser.runtime.sendMessage({ type, generation: auth.generation, dockToken, temporaryId, ...payload });
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
  if (!modelIntent) {
    for (const key of ["interactionMode", "chatModel", "chatEffort", "model", "reasoningEffort"]) if (updated[key] !== undefined) prefs[key] = updated[key];
    if (!running) renderModelChoices(modelChoices);
  }
  const theme = updated.theme;
  if (themeOverride !== null || !["system", "light", "dark"].includes(theme)) return;
  prefs.theme = theme; preferenceRevision++;
  $("theme-setting").value = theme; applyTheme();
});
function freshChat() {
  voice.stop();
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
  $("send-button").disabled = !ready || !auth.canInfer || !picker.model || switching || removing || !$("prompt").value.trim();
  const active = voice.mode === "voice";
  $("voice-button").hidden = !active && (running || !!$("prompt").value.trim());
  $("send-button").hidden = running || !$("prompt").value.trim();
  $("dictate-button").disabled = switching || removing || !ready || preparing || running;
  $("voice-button").disabled = !active && (!ready || !auth.canInfer || !picker.model || running || switching || removing);
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
  const owner = chat, generation = auth.generation, session = temporaryId;
  const draft = { id: owner.id, account: owner.account, text: $("prompt").value, contexts: structuredClone(contexts) };
  const signature = JSON.stringify(draft);
  if (signature === savedDraft) { $("draft-status").textContent = draft.text || draft.contexts.length ? "Draft saved" : ""; return draftTail; }
  const result = draftTail.then(async () => {
    if (generation !== auth.generation || removing) return;
    const target = owner.id;
    const saved = await rpc("draft.save", { draft: { ...draft, id: target, revision: owner.draftRevision ?? 0, chatRevision: owner.revision ?? 0 }, generation, temporaryId: session, tabId: sourceTab, editor, sequence: version });
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
  voice.stop();
  const version = accountChange;
  switching = true; setRunning(false);
  try {
    await persistDraft();
    if (version !== accountChange || removing) return;
    if (temporaryId) { await rpc("temporary.end", { account: auth.account }); temporaryId = null; }
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
  $("temporary-button").setAttribute("aria-pressed", String(!!temporaryId));
  $("temporary-button").title = temporaryId ? "End temporary chat" : "Start temporary chat";
  $("temporary-button").setAttribute("aria-label", $("temporary-button").title);
  $("welcome-heading").hidden = !temporaryId;
  $("temporary-info").hidden = !temporaryId;
  document.body.toggleAttribute("data-temporary", !!temporaryId);
  $("messages").replaceChildren(); $("welcome").hidden = chat.messages.length > 0;
  $("conversation-title").textContent = chat.title;
  renderPlaceholder();
  renderConnection();
  renderActionBudget();
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
  $("mode-switch").hidden = !connected || removing;
  $("work-sources").hidden = !connected || removing;
  $("composer").hidden = !connected || removing;
  $("retry-models").hidden = !connected || !!loadingCatalog;
}
function renderActionBudget() {
  const last = chat?.messages.at(-1);
  const previous = last?.role === "assistant" ? last.browserActions : undefined;
  const actions = running && !preparing ? previous : undefined;
  const limit = actions?.limit ?? prefs.maxBrowserActions;
  const used = actions?.used ?? 0;
  const exhausted = !running && !!previous && previous.used === previous.limit;
  $("action-budget").hidden = !ready || !auth.canInfer || removing;
  $("actions-left").textContent = `${limit - used}/${limit} browser actions left${used && used < limit ? ` · ${used} used` : ""}`;
  $("actions-left").title = actions ? `${used} of ${limit} attempts used for this message. A new message allows ${prefs.maxBrowserActions}.` : `Your next message allows ${limit} browser actions.`;
  const note = exhausted ? `This reply used all ${previous.limit} browser actions.` : "";
  if ($("action-limit-note").textContent !== note) $("action-limit-note").textContent = note;
  $("exhausted-turn").hidden = !exhausted || !ready || !auth.canInfer || removing;
  $("continue-actions").disabled = switching || !ready || removing || !picker.model;
}
function updateChatURL() {
  if (window.top !== window || removing) return;
  const url = new URL(location.href);
  if (!temporaryId && (chat.messages.length || $("prompt").value || contexts.length)) url.searchParams.set("chat", chat.id);
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
  copy.onclick = guard(async () => {
    await navigator.clipboard.writeText(message.text);
    showActionPointer(location.href, copy, "copy");
    notice("Copied to clipboard.", true);
  });
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
    if (Number.isFinite(message.workMs) || message.toolErrors?.length) {
      const failed = message.toolErrors || [];
      const work = document.createElement(failed.length ? "details" : "p"); work.className = "work-time";
      const duration = Number.isFinite(message.workMs) ? `Worked for ${Math.max(1, Math.round(message.workMs / 1000))}s` : "Browser actions";
      if (failed.length) {
        const summary = document.createElement("summary"); summary.textContent = duration + " · Action details"; work.append(summary);
        const list = document.createElement("ul");
        for (const item of failed) {
          const li = document.createElement("li"); li.textContent = (actionNames[item.operation] || "Page action") + " — " + item.detail; list.append(li);
        }
        work.append(list);
      } else work.textContent = duration;
      article.append(work);
    }
    const body = document.createElement("div"); body.className = "message-content";
    const errorOnly = message.error && message.errorMessage === message.text;
    if (errorOnly) { body.textContent = message.text; body.classList.add("message-error"); }
    else body.innerHTML = markdown(message.text);
    article.append(body);
    if (chat.messages[index - 1]?.role === "user" && !(running && index === chat.messages.length - 1)) {
      const retry = messageButton(message.error ? "Retry" : "Try again", "M3 11a9 9 0 1 1 2 7M3 4v7h7");
      retry.title = "Try this message again in a new chat. The original stays in your history.";
      retry.disabled = running || switching || removing; retry.dataset.chatAction = "retry";
      retry.onclick = guard(() => startResponse(branchChat(chat, index - 1)));
      tools.append(retry);
    }
    if (message.error && !errorOnly) {
      const hint = document.createElement("div"); hint.className = "message-error";
      hint.textContent = message.errorMessage || "This response did not complete."; article.append(hint);
    }
    if (message.error && message.errorCode === CHATGPT_USAGE_LIMIT) {
      const link = document.createElement("a");
      link.className = "manage-usage"; link.href = "https://chatgpt.com/settings/usage";
      link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open ChatGPT usage settings";
      article.append(link);
    }
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
async function attachPage(tabId = sourceTab, selection = false, tab) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Open the extension from the Safari tab you want to read.");
  const owner = chat;
  const expectedOrigin = tab?.needsWebsiteAccess ? await tabAccess.identify(tabId, tab.title) : undefined;
  if (owner !== chat || removing) return;
  const context = await rpc("context.read", { tabId, selection, expectedOrigin });
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
  if (!value && runMode) {
    runMode = null;
    paintModelPicker();
  }
  running = value; $("send-button").hidden = value; $("stop-button").hidden = !value;
  for (const id of ["new-button", "chat-mode", "work-mode", "model-trigger", "effort", "signout-button", "account-button", "web-search", "search-chip"]) $(id).disabled = value || switching || removing || !ready;
  $("source-button").disabled = removing || !ready;
  $("history-button").disabled = switching;
  $("temporary-button").disabled = value || switching || removing || !ready || !auth.connected;
  $("signout-button").disabled ||= !auth.connected;
  if (value) picker.close();
  $("retry-models").disabled = value || switching || removing || !ready;
  websiteUI.refresh();
  for (const button of document.querySelectorAll("[data-chat-action]")) button.disabled = value || switching || removing;
  $("theme-setting").disabled = switching || removing || !ready;
  for (const id of Object.keys(settingFields)) $(id).disabled = switching || removing || !ready || savingFields.has(id);
  $("prompt").disabled = switching || removing || !ready;
  for (const id of ["attach-file", "file-input", "add-button", "menu-page", "menu-tabs", "work-files", "work-tabs"]) $(id).disabled = preparing || switching || removing || !ready;
  for (const button of document.querySelectorAll("#attachments button, [data-prompt]")) button.disabled = preparing || switching || removing || !ready;
  resizePrompt();
  renderActionBudget();
  if (!value) { websiteUI.dismiss(); $("motion-controls").hidden = true; }
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
  if (error) {
    last.error = true; last.errorMessage = error;
    if (terminal?.errorCode) last.errorCode = terminal.errorCode;
    if (!last.text) last.text = error;
  }
  if (terminal?.saved) acceptSave(chat, terminal.saved);
  if (terminal?.saveError) notice(`Could not save this chat: ${terminal.saveError}`);
  $("activity").hidden = true;
  setRunning(false); renderMessages(); scrollDown();
  voice.reply(last?.text, error || cancelled);
  if (pendingShare) takeSharedContext().catch(failure => notice(failure.message));
  // Once a run is delivered, the background owns its final write even when the panel closes.
  if (terminal?.saved) persistDraft().catch(() => {});
  else if (!terminal) {
    const owner = chat;
    rpc("chat.save", { chat: owner }).then(saved => { if (chat === owner) { acceptSave(owner, saved); renderMessages(); } }).catch(error => notice(`Could not save this chat: ${error.message}`));
  }
}
function handleStream(event, runID, draftChatId, replay = false) {
  if (event.type === "data.erasing") { forgetLocalUI(); return; }
  if (removing || !running) return;
  if (event.type === "resumed") {
    if (!draftChatId || chat.id !== draftChatId) Object.assign(chat, event.chat);
    chat.messages = [...event.chat.messages, { role: "assistant", text: event.text, toolErrors: event.toolErrors ?? [] }];
    renderMessages(); scrollDown(true);
    for (const update of event.events) handleStream(update, runID, undefined, true);
  } else if (event.type === "run.ended") {
    const version = accountChange;
    switching = true; setRunning(false);
    loadChat(draftChatId ?? event.saved?.id ?? runID).then(() => { if (event.message && version === accountChange) notice(event.message); })
      .catch(error => notice(error.message)).finally(() => { if (version === accountChange) { switching = false; setRunning(false); } });
  } else if (event.type === "approval.answered") websiteUI.dismiss();
  else if (event.type === "browser.actions") {
    chat.messages.at(-1).browserActions = event.actions;
    renderActionBudget();
  }
  else if (event.type === "motion.error") notice(event.message);
  else if (event.type === "motion.state") {
    const state = event.state, controls = $("motion-controls"), speed = $("motion-speed");
    controls.hidden = !state.active;
    if (state.active) {
      const gesture = state.kind === "gesture";
      const name = gesture ? "Playing " + state.device + " gesture" : state.kind === "scroll" ? "Scrolling " + state.direction : state.kind === "drag" ? "Dragging" : "Moving pointer";
      $("motion-unit").textContent = gesture ? "×" : "px/s";
      speed.setAttribute("aria-label", gesture ? "Gesture playback speed multiplier" : "Motion speed in pixels per second");
      speed.title = gesture ? "Playback rate. Set to zero to pause." : "Pixels per second. Set to zero to pause.";
      $("motion-status").textContent = state.speed === 0 ? name + " · Paused" : name;
      if (controls.dataset.motionId !== state.id || document.activeElement !== speed) speed.value = state.speed;
      controls.dataset.motionId = state.id;
      $("stop-motion").textContent = gesture ? "Stop gesture" : state.kind === "scroll" ? "Stop scrolling" : state.kind === "drag" ? "Stop dragging" : "Stop pointer";
    }
  } else if (event.type === "activity") {
    const last = chat.messages.at(-1);
    if (!replay && event.state === "error" && event.detail) last.toolErrors = [...(last.toolErrors || []), { operation: event.operation, detail: event.detail.slice(0, 300) }].slice(-8);
    $("activity").hidden = false;
    $("activity").dataset.state = event.state;
    if (currentAssistant && !chat.messages.at(-1).text) currentAssistant.textContent = "";
    $("activity-label").textContent = `${actionNames[event.operation] || "Page action"} · ${event.state === "working" ? "In progress" : event.state === "error" ? "Could not complete" : event.state === "unmatched" ? "No match" : "Done"}`;
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
  else if (event.type === "error" || event.type === "cancelled") settle(event.message || (event.type === "cancelled" ? "Response stopped." : "The request could not finish."), event.type === "cancelled", event, runID);
}
async function send(event) {
  event?.preventDefault(); if (running || switching || removing || !ready) return;
  const text = $("prompt").value.trim(); if (!text) return;
  voice.stop();
  await startResponse({ ...chat, messages: [...chat.messages, { role: "user", text, contexts: structuredClone(contexts) }], title: chat.messages.length ? chat.title : text.slice(0, 80) });
}
async function startResponse(candidate, { keepDraft = false } = {}) {
  if (running || switching || removing || !ready) return;
  if (!auth.connected || !auth.canInfer) throw new Error("Connect your ChatGPT account or API key in the companion app first.");
  if (!picker.model) throw new Error("Choose a model before sending a message.");
  const { model, effort } = picker;
  const interactionMode = runMode = prefs.interactionMode;
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
  if (!keepDraft) {
    contexts = []; renderAttachments(); $("prompt").value = ""; $("prompt").style.height = "auto";
  }
  persistDraft().catch(() => {});
  $("edit-dialog").close();
  $("prompt").focus();
  chat.messages.push({ role: "assistant", text: "" }); renderMessages(); scrollDown(true);
  connectRun({ type: "run", chatId: chat.id, revision: chat.revision, title: chat.title, account: chat.account, generation: auth.generation, model, effort, interactionMode, webSearch: prefs.webSearch, messages: chat.messages.slice(0, -1) });
}
function connectRun(message) {
  try { port = browser.runtime.connect({ name: "chat" }); } catch (error) { settle(error.message, false, message.type === "resume" ? {} : undefined); return; }
  const currentPort = port;
  const runID = message.chatId;
  port.onMessage.addListener(event => { if (port === currentPort) handleStream(event, runID, message.draftChatId); });
  port.onDisconnect.addListener(() => { if (running && port === currentPort) settle("The extension disconnected. Reopen this chat to check its saved response.", false, {}); });
  try { port.postMessage({ ...message, dockToken, temporaryId }); } catch (error) { settle(error.message, false, message.type === "resume" ? {} : undefined); }
}
function currentMode() { return runMode ?? prefs.interactionMode; }
function renderPlaceholder() {
  $("prompt").placeholder = chat?.messages.length ? "Ask a follow-up" : currentMode() === "chat" ? "Ask ChatGPT" : "Work with Safari Chat";
}
function paintModelPicker() {
  const chatMode = currentMode() === "chat";
  $("chat-mode").setAttribute("aria-pressed", String(chatMode));
  $("work-mode").setAttribute("aria-pressed", String(!chatMode));
  document.body.dataset.mode = chatMode ? "chat" : "work";
  picker.render(modelChoices, currentMode(), chatMode ? prefs.chatModel : prefs.model, chatMode ? prefs.chatEffort : prefs.reasoningEffort);
  renderPlaceholder();
}
function renderModelChoices(choices) {
  modelChoices = choices;
  paintModelPicker();
  renderConnection(); setRunning(running);
}
async function loadModelChoices(refresh = false) {
  const { account, generation } = auth;
  if (loadingCatalog === generation || !generation || removing) return;
  loadingCatalog = generation; renderConnection();
  let choices = modelChoices;
  try {
    const catalog = await rpc("models.list", { account, generation, refresh });
    if (!Array.isArray(catalog)) throw new Error("Safari Chat could not read the account’s model list. Reload models to try again.");
    choices = catalog;
  }
  catch (error) { if (!removing && generation === auth.generation) notice(error.message); }
  finally {
    if (!removing && loadingCatalog === generation && auth.generation === generation) {
      loadingCatalog = null;
      if (JSON.stringify(choices) !== JSON.stringify(modelChoices)) renderModelChoices(choices);
      else renderConnection();
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
  const sessionChanged = temporaryId !== (result.temporaryId ?? null);
  const restore = !ready || changed || sessionChanged;
  if (restore) { clearTimeout(draftTimer); draftVersion++; ready = false; setRunning(false); }
  if (revision === preferenceRevision) prefs = { ...DEFAULTS, ...result.prefs, ...modelIntent, ...(themeOverride === null ? {} : { theme: themeOverride }) };
  auth = result.auth; accountKnown = true;
  applyTheme(); renderConnection();
  $("account-label").textContent = auth.connected ? auth.label || "Connected" : "Connect account";
  document.querySelector(".account-avatar").textContent = ($("account-label").textContent[0] || "S").toUpperCase();
  if (restore) {
    if (changed) { clearAccountViews(); requestedChat = null; }
    temporaryId = result.temporaryId ?? null;
    if (sessionChanged) requestedChat = null;
    freshChat();
    $("edit-dialog").close();
    const id = result.run?.draftChatId || result.run?.chatId || requestedChat || result.activeChat; requestedChat = null;
    try { if (id) await loadChat(id); }
    catch (error) { notice(`Could not restore this chat: ${error.message}`); }
    if (removing || version !== accountChange) return;
    ready = true; setRunning(false);
    if (result.activeChat === chat.id) savedDraft = JSON.stringify({ id: chat.id, account: chat.account, text: $("prompt").value, contexts });
    if (result.run) {
      runMode = result.run.interactionMode ?? "work"; // Pre-mode backgrounds only ran Work models.
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
  voice.stop();
  temporaryId = null;
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
  paintModelPicker(); $("usage").textContent = ""; $("usage").removeAttribute("title");
  $("file-input").value = "";
  for (const element of document.querySelectorAll("button,input,textarea,select")) element.disabled = true;
  for (const id of ["close-button", "history-button", "settings-button", "erase-data-button", "finish-removal-button", "retry-companion-button"]) $(id).disabled = false;
  document.querySelectorAll("[data-close]").forEach(button => { button.disabled = false; });
  $("settings-status").textContent = ""; $("theme-status").textContent = ""; $("retry-theme").hidden = true;
  $("finish-removal-button").hidden = false;
  $("data-section").open = true;
  notice("Local data cleanup has started. Use settings to check the result and finish removal.");
}

function clearAccountViews() {
  modelIntent = null; loadingCatalog = null; modelChoices = [];
  picker.close(); paintModelPicker(); websiteUI.reset();
  chats = []; editingIndex = null;
  $("history-list").replaceChildren(); $("history-search").value = ""; $("edit-prompt").value = "";
  $("approval-title").textContent = ""; $("approval-detail").textContent = ""; $("usage").removeAttribute("title");
  for (const id of ["history-dialog", "edit-dialog", "settings-dialog"]) $(id).close();
}
function accountChanged() {
  voice.stop();
  temporaryId = null;
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
  renderActionBudget();
}
function openSettings() {
  $("theme-setting").value = prefs.theme; syncFields();
  $("history-dialog").close();
  if (!$("settings-dialog").open) $("settings-dialog").showModal();
}
function renderHistory() {
  $("history-list").replaceChildren();
  const query = $("history-search").value.toLowerCase();
  for (const item of chats.filter(c => c.title.toLowerCase().includes(query))) {
    const row = document.createElement("div"); row.className = "list-row";
    const open = document.createElement("button"); open.textContent = item.title;
    if (item.id === chat.id) open.setAttribute("aria-current", "true");
    open.title = item.title + "\n" + new Date(item.updated).toLocaleDateString();
    if (item.draft) { const draft = document.createElement("small"); draft.textContent = "Draft"; open.append(draft); }
    open.onclick = guard(() => navigateChat(item.id));
    const remove = document.createElement("button"); remove.className = "icon-button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Delete ${item.title}`);
    remove.onclick = guard(async () => {
      if (!confirm(`Delete “${item.title}” and its draft from this Mac?`)) return;
      await persistDraft();
      await rpc("chat.delete", { id: item.id }); chats = chats.filter(c => c.id !== item.id);
      if (chat.id === item.id) { freshChat(); await persistDraft(); }
      renderHistory();
    });
    open.disabled = remove.disabled = running || switching || removing;
    row.append(open, remove); $("history-list").append(row);
  }
  if (!$("history-list").children.length) $("history-list").textContent = query ? "No matching chats." : "No chats yet.";
}

$("composer").onsubmit = guard(send);
$("prompt").onkeydown = guard(event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) return send(event); });
$("prompt").oninput = () => { resizePrompt(); scheduleDraft(); };
$("stop-button").onclick = () => { voice.stop(); if (preparing) cancelPreparation = true; port?.postMessage({ type: "cancel" }); websiteUI.dismiss(); };
$("stop-motion").onclick = () => port?.postMessage({ type: "motion.stop", id: $("motion-controls").dataset.motionId });
$("motion-speed").onchange = () => {
  const field = $("motion-speed");
  if (field.reportValidity()) port?.postMessage({ type: "motion.speed", id: $("motion-controls").dataset.motionId, speed: field.valueAsNumber });
};
$("motion-speed").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } };
$("new-button").onclick = guard(() => navigateChat());
$("temporary-button").onclick = guard(async () => {
  if (running || switching || !ready) return;
  voice.stop();
  const version = accountChange;
  switching = true; setRunning(false);
  try {
    await persistDraft();
    if (version !== accountChange || removing) return;
    const wasTemporary = !!temporaryId;
    const result = await rpc(wasTemporary ? "temporary.end" : "temporary.start", { account: auth.account });
    if (version !== accountChange || removing) return;
    temporaryId = wasTemporary ? null : result;
    ready = false; requestedChat = null;
    freshChat();
  } finally { switching = false; setRunning(false); }
  await bootstrap(); $("prompt").focus();
});
$("close-button").onclick = guard(async () => { voice.stop(); await persistDraft(); await rpc("panel.close"); if (window.top === window) window.close(); });
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
$("work-files").onclick = () => $("file-input").click();
$("work-tabs").onclick = () => $("menu-tabs").click();
const tabAccess = setupTabAccess(() => websiteUI.access, rpc);
const websiteUI = setupWebsiteControls({ tabAccess,
  state: () => ({ account: auth.account, generation: auth.generation, enabled: ready && auth.connected && !removing && !switching }),
  rpc, openSettings, answer: reply => port?.postMessage(reply), report: notice,
});
document.querySelectorAll("[data-prompt]").forEach(button => { button.onclick = guard(async () => {
  attachmentUI.closeMenu();
  if (button.dataset.prompt === "summarize") { await attachPage(); $("prompt").value = "Summarize this page. Highlight the key points and anything I should pay attention to."; }
  if (button.dataset.prompt === "explain") { await attachPage(sourceTab, true); $("prompt").value = "Explain this in clear, simple terms."; }
  if (button.dataset.prompt === "write") $("prompt").value = "Help me write ";
  resizePrompt(); scheduleDraft(); $("prompt").focus();
}); });
$("settings-button").onclick = openSettings;
$("retry-models").onclick = guard(async () => { notice(""); await loadModelChoices(true); });
$("model-popover").addEventListener("beforetoggle", event => {
  if (event.newState === "open" && ready && auth.canInfer && !running) loadModelChoices().catch(error => notice(error.message));
});
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
$("continue-actions").onclick = guard(async () => {
  const count = chat.messages.at(-1)?.browserActions;
  if (!count || count.used !== count.limit) return;
  await startResponse({ ...chat, messages: [...chat.messages, continuationMessage(chat.messages, prefs.historyTurns)] }, { keepDraft: true });
});
for (const [id, key] of Object.entries(settingFields)) $(id).onchange = async () => {
  const field = $(id);
  if (!field.validity.valid) {
    $("settings-status").textContent = `Enter a whole number from ${field.min} to ${field.max}.`;
    field.reportValidity(); return;
  }
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
function saveResponseSettings(patch) {
  const choice = modelIntent = { ...modelIntent, ...patch };
  const generation = auth.generation;
  Object.assign(prefs, patch); preferenceRevision++;
  renderModelChoices(modelChoices);
  modelSave = modelSave.catch(() => {}).then(async () => {
    if (choice !== modelIntent || removing || generation !== auth.generation) return;
    try { await rpc("settings.save", { settings: choice }); }
    finally { if (modelIntent === choice) modelIntent = null; }
  });
  return modelSave;
}
const voice = createVoice({
  report: text => notice(text),
  insert(text) {
    const input = $("prompt"), start = input.selectionStart, end = input.selectionEnd;
    const prefix = start && !/\s$/.test(input.value.slice(0, start)) ? " " : "";
    const suffix = end < input.value.length && !/^\s/.test(input.value.slice(end)) ? " " : "";
    const insertion = prefix + text + suffix;
    if (input.value.length - (end - start) + insertion.length > input.maxLength) {
      voice.stop(); notice("Dictation reached the message length limit."); return;
    }
    input.setRangeText(insertion, start, end, "end");
    resizePrompt(); scheduleDraft();
  },
  async submit(text) {
    if (running || switching || removing || !ready) { voice.stop(); return; }
    const keepDraft = !!$("prompt").value;
    const sources = keepDraft ? [] : structuredClone(contexts);
    await startResponse({ ...chat, messages: [...chat.messages, { role: "user", text, contexts: sources }], title: chat.messages.length ? chat.title : text.slice(0, 80) }, { keepDraft });
  },
  update(mode, phase, text) {
    for (const [id, selected, label, key] of [
      ["dictate-button", mode === "dictate", mode === "dictate" ? "Finish dictation" : "Dictate", "D"],
      ["voice-button", mode === "voice", mode === "voice" ? "End Voice" : "Start Voice", "V"],
    ]) {
      const button = $(id);
      button.setAttribute("aria-pressed", String(selected)); button.setAttribute("aria-label", label);
      button.title = label + " (⌃⇧" + key + ")";
    }
    const status = $("voice-status");
    status.hidden = !mode;
    status.textContent = text || ({ starting: "Starting microphone…", listening: "Listening…", waiting: "Waiting for reply…", speaking: "Speaking…" })[phase] || "";
    resizePrompt();
  },
});
$("dictate-button").onclick = () => voice.toggle("dictate");
$("voice-button").onclick = () => voice.toggle("voice");
const picker = setupModelPicker((model, effort) => {
  const change = currentMode() === "chat" ? { chatModel: model, chatEffort: effort } : { model, reasoningEffort: effort };
  saveResponseSettings(change).catch(error => notice(error.message));
});
for (const mode of ["chat", "work"]) $(mode + "-mode").onclick = guard(() => saveResponseSettings({ interactionMode: mode }));
function toggleSearch(open) {
  const input = $("history-search");
  input.hidden = !open;
  $("search-history").setAttribute("aria-expanded", String(open));
  if (open) input.focus();
  else { input.value = ""; renderHistory(); }
}
$("search-history").onclick = () => toggleSearch($("history-search").hidden);
$("recents-button").onclick = () => { toggleSearch(false); $("history-heading").scrollIntoView({block:"nearest"}); };
$("history-button").onclick = guard(async () => {
  const owner = chat, drawer = $("history-dialog");
  if (drawer.open) { drawer.close(); return; }
  chats = []; toggleSearch(false);
  drawer.showModal(); $("history-button").setAttribute("aria-expanded", "true");
  if (!auth.generation || removing) return;
  if (!running) await persistDraft();
  const items = await rpc("chats.list");
  if (owner === chat && drawer.open) { chats = items; renderHistory(); }
});
$("history-dialog").addEventListener("close", () => $("history-button").setAttribute("aria-expanded", "false"));
$("history-dialog").addEventListener("click", event => {
  if (event.target === $("history-dialog") && event.clientX >= $("history-dialog").getBoundingClientRect().right) $("history-dialog").close();
});
document.addEventListener("keydown", event => {
  if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && !event.repeat && ["d", "v"].includes(event.key.toLowerCase())) {
    const button = $(event.key.toLowerCase() === "d" ? "dictate-button" : "voice-button");
    if (!button.disabled && !$("composer").hidden && !document.querySelector("dialog[open]")) { event.preventDefault(); button.click(); }
  }
  if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "s" && !event.altKey && !event.ctrlKey) {
    event.preventDefault(); $("history-button").click();
  }
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
  if (document.visibilityState === "hidden") { voice.stop(); persistDraft().catch(() => {}); }
  else refreshOnFocus().catch(error => notice(error.message));
});
window.addEventListener("pagehide", () => { voice.stop(); persistDraft().catch(() => {}); });
window.addEventListener("focus", () => refreshOnFocus().catch(error => notice(error.message)));
freshChat();
setRunning(false);
async function openPanel() {
  try { await bootstrap(); }
  catch (error) { accountKnown = true; renderConnection(); notice(error.message); }
  if (embedded && dockToken) await rpc("panel.visible").catch(() => {});
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
