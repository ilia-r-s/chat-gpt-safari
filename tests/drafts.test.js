import test from "node:test";
import assert from "node:assert/strict";
import { boundedDraft, draftKey, sessionKey, saveDraft } from "../extension/core/drafts.js";
import { listChats } from "../extension/core/storage.js";

function fixture() {
  const data = {};
  const storage = {
    get: async () => structuredClone(data), set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of keys) delete data[key]; },
  };
  return { data, storage };
}
const source = { kind: "page", key: "page:example", title: "Example", text: "Reference", url: "https://example.com/?secret=value#private", tabId: 7 };

test("drafts preserve text and explicit attachments, with independent account/tab pointers", async () => {
  const { data, storage } = fixture();
  await saveDraft(storage, { id: "a", account: "one", text: "Unsent", contexts: [source] }, 7);
  await saveDraft(storage, { id: "b", account: "two", text: "Other account", contexts: [] }, 7);
  assert.equal(data[draftKey("a")].contexts[0].text, "Reference");
  assert.equal(data[draftKey("a")].contexts[0].url, "https://example.com/");
  assert.equal(data[sessionKey("one", 7)].id, "a");
  assert.equal(data[sessionKey("two", 7)].id, "b");
  assert.equal(data[sessionKey("one", 8)], undefined);
  await assert.rejects(saveDraft(storage, { id: "a", account: "two", text: "Overwrite" }, 7), /different account/);
  assert.equal(data[draftKey("a")].text, "Unsent");
});
test("emptying a composer clears its draft but retains the active chat", async () => {
  const { data, storage } = fixture();
  await saveDraft(storage, { id: "a", account: "one", text: "Unsent", contexts: [source] }, null);
  await saveDraft(storage, { id: "a", account: "one", text: "", contexts: [] }, null);
  assert.equal(data[draftKey("a")], undefined);
  assert.equal(data[sessionKey("one", null)].id, "a");
});
test("draft bounds include UTF-8 bytes, attachment metadata, total storage and pointer counts", async () => {
  const large = { account: "a", text: "x".repeat(13000), contexts: Array.from({ length: 7 }, () => ({ ...source, title: "t".repeat(900), text: "🌿".repeat(20000) })) };
  const normalized = boundedDraft({ ...large, id: "large" });
  assert.equal(normalized.text.length, 12000); assert.equal(normalized.contexts.length, 6);
  assert.ok(normalized.contexts.every(item => item.truncated && item.title.length === 300));
  assert.ok(new TextEncoder().encode(JSON.stringify(normalized)).length <= 200000);
  const { data, storage } = fixture();
  for (let i = 0; i < 55; i++) await saveDraft(storage, { ...large, id: String(i) }, i);
  const drafts = Object.entries(data).filter(([key]) => key.startsWith("composer:"));
  assert.ok(drafts.length <= 20);
  assert.ok(drafts.reduce((sum, [, value]) => sum + new TextEncoder().encode(JSON.stringify(value)).length, 0) <= 600000);
  assert.ok(data[draftKey("54")]);
  assert.equal(Object.keys(data).filter(key => key.startsWith("panel:")).length, 50);
});
test("recent chats includes unsent drafts once and only for their account", async () => {
  const { data, storage } = fixture();
  data["chat:sent"] = { id: "sent", account: "one", title: "Conversation", updated: 1, messages: [] };
  await saveDraft(storage, { id: "sent", account: "one", text: "Follow-up" }, 1);
  await saveDraft(storage, { id: "new", account: "one", text: "New idea" }, 2);
  await saveDraft(storage, { id: "private", account: "two", text: "Private" }, 3);
  const chats = await listChats(storage, "one");
  assert.equal(chats.length, 2);
  assert.ok(chats.every(chat => chat.draft));
  assert.equal(chats.find(chat => chat.id === "sent").title, "Conversation");
  assert.equal(chats.find(chat => chat.id === "new").title, "New idea");
});
