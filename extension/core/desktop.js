import { createBrowserTools } from "./browser-tools.js";

/** Only the native port calls this controller. Approvals return to its MCP client, never a panel. */
export class DesktopController {
  constructor({ api, preferences, verify, reply, isClosed }) {
    Object.assign(this, { api, preferences, verify, reply, isClosed });
    this.sessions = new Map(); this.active = new Map(); this.approvals = new Map();
  }

  async handle(message) {
    const { sessionId, requestId, kind } = message ?? {};
    if (typeof sessionId !== "string" || typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(sessionId) || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
    const key = `${sessionId}:${requestId}`;
    if (kind === "cancel") { this.active.get(key)?.controller.abort(); return; }
    if (kind === "approval") {
      const pending = this.approvals.get(key);
      if (!pending || pending.id !== message.approvalId) return;
      this.approvals.delete(key);
      message.allow === true ? pending.resolve() : pending.reject(new Error("The user declined this action. Do not retry it."));
      return;
    }
    if (kind !== "request") return;
    if (this.active.has(key)) return;
    const controller = new AbortController();
    const run = { controller, task: null };
    this.active.set(key, run);
    run.task = this.execute(message, controller).finally(() => { this.active.delete(key); this.approvals.delete(key); });
    await run.task;
  }

  async execute(message, controller) {
    const { sessionId, requestId } = message;
    const key = `${sessionId}:${requestId}`;
    const timer = setTimeout(() => controller.abort(new Error("This desktop browser action timed out.")), 300000);
    const send = payload => this.reply({ sessionId, requestId, ...payload });
    try {
      if (this.isClosed()) throw new Error("Local data is being erased.");
      const prefs = await this.preferences();
      if (!prefs.desktopControl) throw new Error("Enable ChatGPT desktop control in Safari Chat settings first.");
      const identity = await this.verify(sessionId);
      for (const [id, item] of this.sessions) if (item.expires < Date.now() && !item.busy) this.sessions.delete(id);
      let session = this.sessions.get(sessionId);
      if (session && (session.account !== identity.account || session.hostID !== identity.hostID)) {
        this.sessions.delete(sessionId); throw new Error("The Safari Chat account changed. Read the page again in a new desktop request.");
      }
      if (session?.busy) throw new Error("Another action is already running in this desktop session.");
      if (!session) {
        if (this.sessions.size >= 4) throw new Error("Too many desktop sessions are open. Close an older connection first.");
        session = { ...identity, busy: false, expires: Date.now() + 300000 };
        const approve = async (details, signal) => {
          const active = session.current;
          const approvalId = crypto.randomUUID();
          await new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const abort = () => { this.approvals.delete(active.key); reject(signal.reason); };
            const finish = fn => value => { signal.removeEventListener("abort", abort); fn(value); };
            this.approvals.set(active.key, { id: approvalId, resolve: finish(resolve), reject: finish(reject) });
            signal.addEventListener("abort", abort, { once: true });
            active.send({ type: "approval", approvalId, ...details }).catch(error => { this.approvals.get(active.key)?.reject(error); this.approvals.delete(active.key); });
          });
          signal.throwIfAborted();
          const now = await this.verify(sessionId);
          if (this.isClosed() || now.hostID !== session.hostID || now.account !== session.account || !(await this.preferences()).desktopControl) throw new Error("Desktop access or the account changed while awaiting approval.");
        };
        session.execute = createBrowserTools({ api: this.api, pageChars: prefs.pageChars, approve });
        this.sessions.set(sessionId, session);
      }
      session.busy = true; session.current = { key, send };
      try {
        controller.signal.throwIfAborted();
        const result = await session.execute(message.args, controller.signal);
        controller.signal.throwIfAborted();
        await send({ type: "result", result });
      } finally { session.busy = false; session.current = null; session.expires = Date.now() + 300000; }
    } catch (error) {
      await send({ type: "result", error: controller.signal.aborted ? "The desktop browser action was cancelled." : error.message }).catch(() => {});
    } finally { clearTimeout(timer); }
  }

  async cancelAll() {
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map(run => run.task));
    this.sessions.clear(); this.approvals.clear();
  }
}
