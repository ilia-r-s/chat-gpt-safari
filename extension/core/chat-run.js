import { safeWebURL } from "./context.js";

// The background owns a single execution. A replacement panel subscribes to
// its current output and approval; subscribing never issues a model/tool call.
export class ChatRun {
  constructor(message, source, panelTab) {
    this.id = crypto.randomUUID();
    this.source = source;
    this.panelTab = panelTab;
    this.account = message.account;
    this.generation = message.generation;
    // Current panels always send their selection. Older panels sent a raw Work model ID.
    this.mode = message.interactionMode === "chat" ? "chat" : "work";
    this.temporaryId = message.temporaryId ?? null;
    this.chat = { id: message.chatId, revision: message.revision, title: String(message.title || "New chat"), account: message.account, messages: message.messages };
    this.controller = new AbortController();
    this.ports = new Set();
    this.state = new Map();
    this.toolErrors = [];
    this.text = "";
  }
  matches(source, host, account, generation) {
    return this.source === source && (source !== null || this.panelTab === host) && this.account === account && this.generation === generation;
  }
  abort(reason) { this.controller.abort(reason); }
  release() {
    this.ports.clear();
    this.state.clear();
    this.toolErrors.length = 0;
    this.chat = null;
    this.text = "";
  }
  attach(port, resume = false) {
    this.ports.add(port);
    if (resume) port.postMessage({ type: "resumed", chat: this.chat, text: this.text, toolErrors: this.toolErrors,
      events: [...this.state.values(), ...(this.approval ? [this.approval.event] : [])] });
  }
  emit(event) {
    if (event.type === "activity" && event.state === "error" && event.detail) {
      this.toolErrors.push({ operation: String(event.operation || "").slice(0, 32), detail: String(event.detail).slice(0, 300) });
      if (this.toolErrors.length > 8) this.toolErrors.shift();
    }
    if (event.type === "delta") this.text += event.text;
    else if (event.type === "replace") this.text = event.text;
    else if (["status", "activity", "context", "usage", "browser.actions", "motion.state"].includes(event.type)) this.state.set(event.type, event);
    for (const port of this.ports) {
      try { port.postMessage(event); } catch { this.ports.delete(port); }
    }
  }
  prompt(details, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const event = { type: "approval", id: crypto.randomUUID(), ...details };
      const abort = () => { this.approval = null; reject(signal.reason); };
      this.approval = { event, finish: choice => {
        signal.removeEventListener("abort", abort);
        this.approval = null;
        this.emit({ type: "approval.answered", id: event.id });
        if (choice) resolve(choice);
        else if (event.siteOrigin) reject(new Error("Website access to " + new URL(event.siteOrigin).hostname + " was not granted. Leave the tab open and do not repeat the request."));
        else reject(new Error("The user declined this action. Do not retry it."));
      } };
      signal.addEventListener("abort", abort, { once: true });
      this.emit(event);
    });
  }
  answer(message) {
    if (!this.approval || this.approval.event.id !== message.id) return;
    if (Number.isInteger(this.approval.event.tabId)) {
      const address = safeWebURL(message.origin);
      this.approval.finish(message.allow === true && address ? new URL(address).origin : null);
      return;
    }
    const scope = message.scope ?? "once";
    this.approval.finish(message.allow === true && ["once", "site", "all"].includes(scope) && (!this.approval.event.siteOrigin || scope === "once") ? scope : null);
  }
}
