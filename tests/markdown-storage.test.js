import test from "node:test";
import assert from "node:assert/strict";
import { markdown } from "../extension/panel/markdown.js";
import { saveChat, listChats } from "../extension/core/storage.js";

test("assistant HTML and javascript URLs remain inert", () => {
  const result = markdown('<img src=x onerror=alert(1)>\n[Bad](javascript:alert(1))\n[Good](https://example.com)');
  assert.ok(!result.includes("<img")); assert.ok(!result.includes('href="javascript:'));
  assert.ok(result.includes('rel="noopener noreferrer"'));
});
test("Markdown code stays escaped and unfinished fences are closed", () => {
  const result = markdown("```html\n<script>danger</script>");
  assert.ok(result.includes("&lt;script&gt;")); assert.ok(result.endsWith("</code></pre>"));
});
test("history is account-scoped and old chats are evicted", async () => {
  const data = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`chat:${i}`, { id: `${i}`, account: "a", title: `Chat ${i}`, updated: i, messages: [] }]));
  const storage = { get: async () => data, set: async values => Object.assign(data, values), remove: async keys => { for (const key of keys) delete data[key]; } };
  await saveChat(storage, { id: "new", account: "b", title: "Other account", messages: [] });
  assert.equal(Object.keys(data).length, 50); assert.ok(!data["chat:0"]);
  assert.equal((await listChats(storage, "a")).length, 49); assert.equal((await listChats(storage, "b"))[0].id, "new");
});
test("history is bounded in bytes before a write, including multibyte attachments", async () => {
  const data = {}; const storage = { get: async () => data, set: async values => Object.assign(data, values), remove: async keys => { for (const key of keys) delete data[key]; } };
  const messages = Array.from({ length: 20 }, (_, i) => [{ role: "user", text: `Question ${i}`, contexts: [{ kind: "page", text: "🌿".repeat(12000) }] }, { role: "assistant", text: "Reply".repeat(1000) }]).flat();
  const chat = await saveChat(storage, { id: "large", account: "a", title: "Large", messages });
  assert.ok(new TextEncoder().encode(JSON.stringify(chat)).length < 401000);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages.at(-2).text, "Question 19");
});
