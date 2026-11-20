import { controlPageMotion } from "../content/page-motion.js";

export function motionResult(state) {
  if (state.reason === "gesture finished") return { ok: true, motion: state, message: "Delivered " + state.events + " scripted events. " +
    (state.currentItem && state.fromItem !== state.currentItem ? "Gallery selection changed from " + state.fromItem + " to " + state.currentItem + ". " : "") +
    (state.rotationUnavailable ? "This browser has no trackpad rotation event. " : "") + "Read the page to verify the requested effect." };
  if (state.reason === "target visible") return { ok: true, found: true, motion: state, message: "Stopped at " + state.match + ". Read this viewport for fresh controls and continue the requested actions." };
  if (state.reason === "search limit") return { ok: true, found: false, motion: state, message: "Paused after searching this section. Read the viewport and refine or continue the search." };
  const expected = state.active || ["path finished", "scroll boundary", "stopped by model", "stopped by user"].includes(state.reason);
  return expected ? { ok: true, motion: state } : { ok: false, motion: state, error: "Motion interrupted: " + state.reason + ". Read the page before continuing." };
}

// One motion belongs to one chat run and one document. A short lease lets the
// page stop independently if the background disappears while a model is thinking.
export class MotionSession {
  constructor(api, changed) {
    this.api = api;
    this.changed = changed;
    this.current = null;
    this.last = null;
  }

  async command(motion, command, options = {}) {
    const [injection] = await this.api.scripting.executeScript({ target: { tabId: motion.tabId }, func: controlPageMotion, args: [command, motion.id, options] });
    if (!injection?.result || injection.error) throw new Error("Safari could not reach the page.");
    return injection.result;
  }

  finish(motion, state) {
    if (this.current !== motion) return;
    clearTimeout(motion.timer);
    motion.signal.removeEventListener("abort", motion.abort);
    this.current = null;
    this.last = { kind: motion.kind, ...state, active: false, tabId: motion.tabId };
    this.changed({ ...this.last, id: motion.id });
    motion.resolve(this.last);
  }

  async monitor(motion) {
    try {
      await motion.verify();
      if (this.current !== motion || motion.stopping) return;
      const state = await this.command(motion, "renew");
      if (this.current !== motion || motion.stopping) return;
      if (!state.active) { this.finish(motion, state); return; }
      if (state.speed !== this.last?.speed) { this.last = { ...state, tabId: motion.tabId }; this.changed({ ...this.last, id: motion.id }); }
      motion.timer = setTimeout(() => this.monitor(motion), motion.interval);
    } catch {
      if (this.current === motion) await this.stop("access or connection changed");
    }
  }

  async start(tabId, kind, directions, verify, signal, dispatch, wait) {
    if (this.current) throw new Error("Stop the current motion first.");
    const motion = { tabId, kind, id: crypto.randomUUID(), directions, signal, verify, interval: kind === "scroll" ? 1000 : 250 };
    motion.finished = new Promise(resolve => { motion.resolve = resolve; });
    motion.abort = () => { this.stop("task stopped"); };
    await this.command(motion, "install");
    await verify();
    signal.throwIfAborted();
    this.current = motion;
    signal.addEventListener("abort", motion.abort, { once: true });
    try {
      const result = await dispatch(motion.id);
      if (this.current !== motion || motion.stopping || signal.aborted) {
        // Stop may have reached the page before its start injection completed.
        await this.command(motion, "stop", { reason: "task stopped" }).catch(() => {});
        signal.throwIfAborted();
        throw new Error("Motion was stopped before it could start.");
      }
      if (!result.motion) throw new Error("The page did not confirm the motion.");
      if (!result.motion.active) { this.finish(motion, result.motion); return { ...result, ...motionResult(result.motion) }; }
      this.last = { ...result.motion, tabId };
      this.changed({ ...this.last, id: motion.id });
      motion.timer = setTimeout(() => this.monitor(motion), motion.interval);
      if (wait) { result.motion = await motion.finished; signal.throwIfAborted(); }
      return { ...result, ...motionResult(result.motion) };
    } catch (error) { await this.stop("start interrupted"); throw error; }
  }

  async adjust(motion, speed, direction) {
    if (!motion || !Number.isFinite(speed) || speed < 0) throw new Error("Choose a finite speed of zero or more pixels per second for the active motion.");
    try { await motion.verify(); }
    catch (error) { if (this.current === motion) await this.stop("access or connection changed"); throw error; }
    if (this.current !== motion || motion.stopping) throw new Error("Motion has stopped.");
    const state = await this.command(motion, "adjust", { direction, speed });
    if (this.current !== motion || motion.stopping) return motion.finished;
    if (!state.active) this.finish(motion, state);
    else { this.last = { ...state, tabId: motion.tabId }; this.changed({ ...this.last, id: motion.id }); }
    return this.last;
  }

  stop(reason) {
    const motion = this.current;
    if (!motion) return Promise.resolve(this.last);
    if (!motion.stopping) {
      clearTimeout(motion.timer);
      // A discarded WebExtension context can lose its injection acknowledgement.
      // The page's last lease expires independently within this interval.
      motion.timer = setTimeout(() => this.finish(motion, { reason }), 4000);
      motion.stopping = this.command(motion, "stop", { reason })
        .then(state => this.finish(motion, state), () => this.finish(motion, { reason }));
    }
    return motion.finished;
  }
}
