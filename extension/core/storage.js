import { normalizeSettings } from "./config.js";

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

export async function saveChat(storage, chat) {
  const messages = chat.messages.slice(-MAX_MESSAGES).map(m => ({
    role: m.role, text: m.text.length > 120000 ? m.text.slice(0, 119980) + "\n[Content trimmed]" : m.text,
    contexts: (m.contexts ?? []).slice(0, 6).map(c => ({ ...c, text: c.text.slice(0, 24000) })),
    ...(m.error ? { error: true } : {}),
  }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  while (bytes(messages) > MAX_CHAT_BYTES) {
    const nextTurn = messages.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextTurn > 0) { messages.splice(0, nextTurn); continue; }
    const sources = messages.flatMap(message => message.contexts);
    const largest = sources.sort((a, b) => b.text.length - a.text.length)[0];
    if (largest?.text.length > 1000) { largest.text = largest.text.slice(0, Math.floor(largest.text.length / 2)) + "\n[Content trimmed for local storage]"; continue; }
    const longest = [...messages].sort((a, b) => b.text.length - a.text.length)[0];
    longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2)) + "\n[Content trimmed for local storage]";
  }
  const value = { id: chat.id, account: chat.account, title: chat.title.slice(0, 120), updated: Date.now(), messages };
  const all = await storage.get(null);
  const chats = Object.entries(all).filter(([key]) => key.startsWith("chat:") && key !== chatKey(chat.id)).sort((a, b) => b[1].updated - a[1].updated);
  let used = bytes(value);
  const remove = [];
  chats.forEach(([key, item], index) => {
    used += bytes(item);
    if (index >= MAX_CHATS - 1 || used > MAX_HISTORY_BYTES) remove.push(key);
  });
  // Prune before writing so a full extension quota cannot prevent a new message being saved.
  if (remove.length) await storage.remove(remove);
  await storage.set({ [chatKey(chat.id)]: value });
  return value;
}

export async function listChats(storage, account) {
  const all = await storage.get(null);
  return Object.entries(all).filter(([key, value]) => key.startsWith("chat:") && value.account === account)
    .map(([, { id, title, updated }]) => ({ id, title, updated })).sort((a, b) => b.updated - a.updated);
}
