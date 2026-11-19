import { boundedDraft, saveDraft } from "./drafts.js";

// An iframe can disappear before its 300 ms disk-save timer fires. Take the
// last edit in the background immediately, then use the ordinary revisioned
// writer when the editor saves or its replacement opens.
export class FrameDrafts {
  constructor() { this.pending = new Map(); this.recovered = new Map(); }
  clear() { this.pending.clear(); this.recovered.clear(); }
  changeSession(generation) {
    for (const map of [this.pending, this.recovered]) {
      for (const [key, item] of map) if (item.generation !== generation) map.delete(key);
    }
  }
  receipt(source, msg) {
    const record = this.recovered.get(msg.editor);
    if (record && record.source === source && record.account === msg.draft.account && record.generation === msg.generation) return record.saved;
  }
  stage(source, msg) {
    if (!Number.isInteger(source) || !/^[a-f0-9-]{36}$/i.test(msg.editor) || !msg.generation || !Number.isSafeInteger(msg.sequence) || this.receipt(source, msg)) return;
    const old = this.pending.get(source);
    if (old?.editor === msg.editor && old.sequence >= msg.sequence) return;
    const value = boundedDraft(msg.draft);
    const draft = { ...value, revision: msg.draft.revision, chatRevision: msg.draft.chatRevision };
    this.pending.delete(source);
    this.pending.set(source, { editor: msg.editor, sequence: msg.sequence, generation: msg.generation, draft, bytes: new TextEncoder().encode(JSON.stringify(draft)).length });
    let size = 0, count = 0;
    for (const [id, entry] of [...this.pending].reverse()) {
      size += entry.bytes;
      if (++count > 20 || size > 600000) this.pending.delete(id);
    }
  }
  saved(source, msg, saved) {
    const pending = this.pending.get(source);
    if (!pending || pending.editor !== msg.editor || pending.generation !== msg.generation || pending.draft.id !== msg.draft.id) return;
    if (pending.sequence <= msg.sequence) this.pending.delete(source);
    else Object.assign(pending.draft, { id: saved.id, revision: saved.revision, chatRevision: saved.chatRevision ?? pending.draft.chatRevision });
  }
  async recover(storage, source, editor, auth, verify) {
    for (let entry; (entry = this.pending.get(source));) {
      if (entry.editor === editor || this.recovered.has(editor)) return;
      if (entry.generation === auth.generation && entry.draft.account === auth.account) {
        await verify();
        if (entry !== this.pending.get(source)) continue;
        const saved = await saveDraft(storage, entry.draft, source);
        this.saved(source, entry, saved);
        this.recovered.set(entry.editor, { source, generation: auth.generation, account: auth.account,
          saved: { id: saved.id, revision: saved.revision, chatRevision: saved.chatRevision, contexts: [] } });
        if (this.recovered.size > 32) this.recovered.delete(this.recovered.keys().next().value);
      }
      if (this.pending.get(source) === entry) this.pending.delete(source);
    }
  }
}
