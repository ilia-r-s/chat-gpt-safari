// The background owns a single execution. A replacement panel subscribes to
// its current output and approval; subscribing never issues a model/tool call.
export class ChatRun {
  constructor(message, source, panelTab) {
    this.id = crypto.randomUUID();
    this.source = source;
    this.panelTab = panelTab;
    this.account = message.account;
    this.generation = message.generation;
    this.chat = { id: message.chatId, revision: message.revision, title: String(message.title || "New chat"), account: message.account, messages: message.messages };
    this.controller = new AbortController();
    this.ports = new Set();
    this.state = new Map();
    this.text = "";
  }
  matches(source, host, account, generation) {
    return this.source === source && (source !== null || this.panelTab === host) && this.account === account && this.generation === generation;
  }
  abort(reason) { this.controller.abort(reason); }
  release() {
    this.ports.clear();
    this.state.clear();
    this.chat = null;
    this.text = "";
  }
  attach(port, resume = false) {
    this.ports.add(port);
    if (resume) port.postMessage({ type: "resumed", chat: this.chat, text: this.text,
      events: [...this.state.values(), ...(this.approval ? [this.approval.event] : [])] });
  }
  emit(event) {
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
    const scope = message.scope ?? "once";
    this.approval.finish(message.allow === true && ["once", "site", "all"].includes(scope) && (!this.approval.event.siteOrigin || scope === "once") ? scope : null);
  }
}
