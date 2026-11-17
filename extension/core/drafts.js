import { boundedContexts, textPrefix } from "./context.js";
import { chatKey, prepareChat } from "./storage.js";

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const draftKey = id => `composer:${id}`;
export const sessionKey = (account, tabId) => `panel:${JSON.stringify([account, Number.isInteger(tabId) && tabId >= 0 ? tabId : null])}`;

export function boundedDraft(draft) {
  const contexts = boundedContexts(draft.contexts);
  const value = { id: draft.id, account: draft.account, text: String(draft.text ?? "").slice(0, 12000), contexts, updated: Date.now() };
  // Leave room for the bounded chat history and extension settings within Safari's quota.
  while (bytes(value) > 200000) {
    const largest = [...contexts].sort((a, b) => b.text.length - a.text.length)[0];
    if (!largest?.text.length) throw new Error("This draft is too large to save.");
    largest.text = textPrefix(largest.text, Math.floor(largest.text.length / 2));
    largest.truncated = true;
  }
  return value;
}

export async function saveDraft(storage, draft, tabId) {
  const value = boundedDraft(draft);
  let key = draftKey(value.id);
  const pointer = sessionKey(value.account, tabId);
  const all = await storage.get(null);
  const prior = all[key];
  const chat = all[chatKey(value.id)];
  for (const old of [prior, chat]) {
    if (old && old.account !== value.account) throw new Error("This chat belongs to a different account.");
  }
  if (!chat && (draft.chatRevision > 0 || (!prior && draft.revision))) throw new Error("This chat was removed. Start a new chat to keep this draft.");
  const hasDraft = !!value.text || value.contexts.length > 0;
  const revision = prior ? prior.revision ?? 1 : 0;
  let copy;
  if (draft.revision !== undefined && draft.revision !== revision) {
    if (!hasDraft) return { ...value, revision: 0 }; // Another editor owns the stored text.
    if (prior?.text === value.text && JSON.stringify(prior.contexts) === JSON.stringify(value.contexts)) return { ...prior, revision };
    value.id = crypto.randomUUID(); key = draftKey(value.id);
    if (chat) copy = prepareChat(all, { ...chat, id: value.id, revision: 0, title: chat.title.slice(0, 106) + " (draft copy)" }, chat.id);
  }
  value.revision = hasDraft ? crypto.randomUUID() : 0;
  const entries = Object.entries(all);
  const drafts = entries.filter(([name]) => name.startsWith("composer:") && name !== key).sort((a, b) => b[1].updated - a[1].updated);
  if (value.id !== draft.id) drafts.sort(([a], [b]) => Number(b === draftKey(draft.id)) - Number(a === draftKey(draft.id)));
  const sessions = entries.filter(([name]) => name.startsWith("panel:") && name !== pointer).sort((a, b) => b[1].updated - a[1].updated);
  let used = hasDraft ? bytes(value) : 0;
  const remove = hasDraft ? [] : [key];
  drafts.forEach(([name, item], index) => {
    used += bytes(item);
    if (index >= (hasDraft ? 19 : 20) || used > 600000) remove.push(name);
  });
  remove.push(...sessions.slice(49).map(([name]) => name));
  if (copy) remove.push(...copy.remove);
  if (remove.length) await storage.remove(remove);
  await storage.set({
    ...(copy ? { [chatKey(value.id)]: copy.value } : {}),
    ...(hasDraft ? { [key]: value } : {}),
    [pointer]: { id: value.id, account: value.account, updated: value.updated },
  });
  return copy ? { ...value, chatRevision: copy.value.revision, title: copy.value.title } : value;
}
