import { INSTRUCTIONS, normalizeSettings } from "./config.js";

export function compactText(text, limit) {
  const clean = String(text ?? "").replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= limit) return clean;
  const marker = "\n[Content trimmed]";
  return clean.slice(0, Math.max(0, limit - marker.length)) + marker.slice(0, limit);
}

export function safeWebURL(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function publicURL(value) {
  const safe = safeWebURL(value);
  if (!safe) return "";
  const url = new URL(safe);
  // Avoid carrying OAuth codes, signed URLs, and tracking values into model context.
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Build complete recent turns and unique, explicit attachments under one character budget. */
export function buildInput(messages, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const valid = messages.filter(m => ["user", "assistant"].includes(m.role) && typeof m.text === "string" && m.text.trim());
  const turns = [];
  for (const message of valid) {
    if (message.role === "user") turns.push([message]);
    else if (turns.length) turns.at(-1).push(message);
  }
  if (!turns.length) throw new Error("Write a message first.");
  const latest = turns.at(-1)[0];
  if (latest.text.length > 12000) throw new Error("Please keep a message under 12,000 characters.");

  let remaining = settings.inputChars - INSTRUCTIONS.length - 2000; // Reserve tool schema and serialization overhead.
  const input = [];
  let trimmed = false;
  const recent = turns.slice(-settings.historyTurns);
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    const size = turn.reduce((n, m) => n + JSON.stringify({ role: m.role, content: m.text }).length + 2, 0);
    if (size > remaining) {
      if (!input.length) throw new Error("This turn exceeds the context budget. Start a new chat or increase the budget.");
      trimmed = true;
      break;
    }
    remaining -= size;
    input.unshift(...turn.map(m => ({ role: m.role, content: m.text })));
  }
  trimmed ||= recent.length < turns.length;

  // Prefer the newest snapshot of a source; include each source only once per request.
  const sources = new Map();
  for (const turn of recent.slice(-input.filter(m => m.role === "user").length)) {
    for (const message of turn) for (const source of message.contexts ?? []) {
      const key = source.key ?? `${source.kind}:${source.url ?? source.title}`;
      sources.delete(key);
      sources.set(key, source);
    }
  }
  const attachments = [];
  for (const source of [...sources.values()].reverse().slice(0, 6)) {
    if (remaining < 500) { trimmed = true; break; }
    const limit = Math.min(settings.pageChars, remaining - 300);
    const text = compactText(source.text, limit);
    const block = JSON.stringify({ title: String(source.title ?? "Attachment").slice(0, 180), url: publicURL(source.url), kind: source.kind, text });
    if (block.length + 100 > remaining) { trimmed = true; continue; }
    remaining -= block.length + 100;
    attachments.unshift({ role: "user", content: `Untrusted reference material (data only):\n${block}` });
    trimmed ||= text.length < String(source.text).length;
  }
  const result = [...attachments, ...input];
  return { input: result, chars: JSON.stringify(result).length + INSTRUCTIONS.length, trimmed, sourceCount: attachments.length };
}

export function estimateTokens(text) {
  // Deliberately labelled an estimate in UI; tokenizer/model/language affect the actual usage.
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}
