import { publicURL } from "./context.js";

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const draftKey = id => `composer:${id}`;
export const sessionKey = (account, tabId) => `panel:${JSON.stringify([account, Number.isInteger(tabId) && tabId >= 0 ? tabId : null])}`;

export function boundedDraft(draft) {
  const contexts = (draft.contexts ?? []).slice(0, 6).map(context => ({
    kind: ["page", "selection", "file"].includes(context.kind) ? context.kind : "file",
    key: String(context.key ?? "").slice(0, 2000), title: String(context.title ?? "Source").slice(0, 300),
    text: String(context.text ?? "").slice(0, 24000), url: publicURL(context.url).slice(0, 2000),
    ...(Number.isInteger(context.tabId) ? { tabId: context.tabId } : {}),
    truncated: !!context.truncated || String(context.text ?? "").length > 24000,
  }));
  const value = { id: draft.id, account: draft.account, text: String(draft.text ?? "").slice(0, 12000), contexts, updated: Date.now() };
  // Leave room for the bounded chat history and extension settings within Safari's quota.
  while (bytes(value) > 200000) {
    const largest = [...contexts].sort((a, b) => b.text.length - a.text.length)[0];
    if (!largest?.text.length) throw new Error("This draft is too large to save.");
    largest.text = largest.text.slice(0, Math.floor(largest.text.length / 2));
    largest.truncated = true;
  }
  return value;
}

export async function saveDraft(storage, draft, tabId) {
  const value = boundedDraft(draft);
  const key = draftKey(value.id);
  const pointer = sessionKey(value.account, tabId);
  const all = await storage.get(null);
  for (const old of [all[key], all[`chat:${value.id}`]]) {
    if (old && old.account !== value.account) throw new Error("This chat belongs to a different account.");
  }
  const entries = Object.entries(all);
  const drafts = entries.filter(([name]) => name.startsWith("composer:") && name !== key).sort((a, b) => b[1].updated - a[1].updated);
  const sessions = entries.filter(([name]) => name.startsWith("panel:") && name !== pointer).sort((a, b) => b[1].updated - a[1].updated);
  const hasDraft = !!value.text || value.contexts.length > 0;
  let used = hasDraft ? bytes(value) : 0;
  const remove = hasDraft ? [] : [key];
  drafts.forEach(([name, item], index) => {
    used += bytes(item);
    if (index >= (hasDraft ? 19 : 20) || used > 600000) remove.push(name);
  });
  remove.push(...sessions.slice(49).map(([name]) => name));
  if (remove.length) await storage.remove(remove);
  await storage.set({
    ...(hasDraft ? { [key]: value } : {}),
    [pointer]: { id: value.id, account: value.account, updated: value.updated },
  });
  return value;
}
