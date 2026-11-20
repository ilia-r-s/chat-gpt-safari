import { FrameDrafts } from "./frame-drafts.js";

// The same bounded chat/draft writers can use this store. Each open temporary
// conversation owns its own records and edit receipts, all in background memory.
export class TemporaryChats {
  constructor() { this.tabs = new Map(); }
  start(tab, account, generation) {
    if (!Number.isInteger(tab)) throw new Error("Open temporary chat in a Safari tab.");
    if (this.tabs.has(tab)) throw new Error("This tab already has a temporary chat.");
    const records = new Map();
    const store = {
      get: async key => structuredClone(Object.fromEntries(key == null ? records : records.has(key) ? [[key, records.get(key)]] : [])),
      set: async values => { for (const [key, value] of Object.entries(structuredClone(values))) records.set(key, value); },
      remove: async keys => { for (const key of [].concat(keys)) records.delete(key); },
    };
    const session = { id: crypto.randomUUID(), account, generation, store, drafts: new FrameDrafts() };
    this.tabs.set(tab, session);
    return session.id;
  }
  get(tab, id, generation) {
    const current = this.tabs.get(tab);
    if (id !== (current?.id ?? null) || current && current.generation !== generation) throw new Error("This chat session ended. Reopen the pane to continue.");
    return current;
  }
  changeAccount(generation) {
    for (const [tab, session] of this.tabs) if (session.generation !== generation) this.tabs.delete(tab);
  }
}
