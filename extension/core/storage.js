import { normalizeSettings } from "./config.js";
import { boundedContexts, textPrefix } from "./context.js";

const MAX_CHATS = 50;
const MAX_MESSAGES = 80;
const MAX_CHAT_BYTES = 400000;
const MAX_HISTORY_BYTES = 4000000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const chatKey = id => `chat:${id}`;

export async function settings(storage) {
  const data = await storage.get("settings");
  return normalizeSettings(data.settings);
}

export function prepareChat(all, chat, retainID) {
  const previous = all[chatKey(chat.id)];
  if ([previous, all[`composer:${chat.id}`]].some(item => item && item.account !== chat.account)) throw new Error("This chat belongs to a different account.");
  const revision = previous ? previous.revision ?? 1 : 0;
  if (!previous && chat.revision > 0) throw new Error("This chat was removed. Start a new chat to keep this work.");
  const messages = chat.messages.slice(-MAX_MESSAGES).map(m => ({
    role: m.role, text: m.text.length > 120000 ? m.text.slice(0, 119980) + "\n[Content trimmed]" : m.text,
    contexts: boundedContexts(m.contexts),
    ...(m.error ? { error: true } : {}),
    ...(m.role === "assistant" && Number.isFinite(m.workMs) ? { workMs: Math.max(0, Math.min(300000, m.workMs)) } : {}),
  }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  while (bytes(messages) > MAX_CHAT_BYTES) {
    const nextTurn = messages.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextTurn > 0) { messages.splice(0, nextTurn); continue; }
    const sources = messages.flatMap(message => message.contexts);
    const largest = sources.sort((a, b) => b.text.length - a.text.length)[0];
    if (largest?.text.length > 1000) { largest.text = textPrefix(largest.text, Math.floor(largest.text.length / 2)); largest.truncated = true; continue; }
    const longest = [...messages].sort((a, b) => b.text.length - a.text.length)[0];
    if (longest.text.length > 1000) longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2)) + "\n[Content trimmed for local storage]";
    else if (largest) {
      const sources = messages.find(message => message.contexts.includes(largest)).contexts;
      sources.splice(sources.indexOf(largest), 1);
    } else messages.splice(1, 1);
  }
  const title = chat.title.slice(0, 120);
  const contents = JSON.stringify(messages);
  if (previous && previous.title === title && JSON.stringify(previous.messages) === contents) return { value: { ...previous, revision }, unchanged: true, remove: [] };
  const conflict = previous && (chat.revision ?? 0) !== revision;
  const copyTitle = title.slice(0, 104) + " (separate copy)";
  if (conflict) {
    const copy = Object.entries(all).find(([key, item]) => key.startsWith("chat:") && item.account === chat.account && item.parentID === chat.id
      && item.baseRevision === (chat.revision ?? 0) && item.title === copyTitle && JSON.stringify(item.messages) === contents);
    if (copy) return { value: copy[1], unchanged: true, remove: [] };
  }
  const value = { id: conflict ? crypto.randomUUID() : chat.id, account: chat.account,
    title: conflict ? copyTitle : title, updated: Date.now(), revision: conflict ? 1 : revision + 1, messages,
    ...(conflict ? { parentID: chat.id, baseRevision: chat.revision ?? 0 } : {}) };
  const chats = Object.entries(all).filter(([key]) => key.startsWith("chat:") && key !== chatKey(value.id)).sort((a, b) => b[1].updated - a[1].updated);
  const keep = conflict ? chat.id : retainID;
  if (keep) chats.sort(([a], [b]) => Number(b === chatKey(keep)) - Number(a === chatKey(keep)));
  let used = bytes(value);
  const remove = [];
  chats.forEach(([key, item], index) => {
    used += bytes(item);
    if (index >= MAX_CHATS - 1 || used > MAX_HISTORY_BYTES) remove.push(key);
  });
  return { value, remove };
}

export async function saveChat(storage, chat) {
  const { value, remove, unchanged } = prepareChat(await storage.get(null), chat);
  if (unchanged) return value;
  if (remove.length) await storage.remove(remove);
  await storage.set({ [chatKey(value.id)]: value });
  return value;
}

export async function listChats(storage, account) {
  const all = await storage.get(null);
  const chats = new Map(Object.entries(all).filter(([key, value]) => key.startsWith("chat:") && value.account === account)
    .map(([, { id, title, updated }]) => [id, { id, title, updated }]));
  for (const [key, draft] of Object.entries(all)) {
    if (!key.startsWith("composer:") || draft.account !== account) continue;
    const item = chats.get(draft.id) ?? { id: draft.id, title: draft.text.trim().slice(0, 80) || "New chat", updated: 0 };
    chats.set(draft.id, { ...item, draft: true, updated: Math.max(item.updated, draft.updated) });
  }
  return [...chats.values()].sort((a, b) => b.updated - a.updated);
}
