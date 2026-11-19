import test from "node:test";
import assert from "node:assert/strict";
import { branchChat, continuationMessage } from "../extension/panel/conversation.js";

const original = {
  id: "original", account: "account-a", title: "First question",
  messages: [
    { role: "user", text: "First question", contexts: [{ kind: "page", title: "Page", text: "Source" }] },
    { role: "assistant", text: "First answer" },
    { role: "user", text: "Follow-up", contexts: [{ kind: "file", text: "File source" }] },
    { role: "assistant", text: "Partial answer", error: true },
  ],
};
test("Continue retains the user's goal when earlier turns fall outside the history setting", () => {
  const short = continuationMessage(original.messages, 8);
  assert.deepEqual(short, { role: "user", text: "Please continue.", contexts: [] });
  const single = continuationMessage(original.messages, 1);
  assert.match(single.text, /Follow-up$/); assert.doesNotMatch(single.text, /Partial answer/);
  assert.deepEqual(continuationMessage([...original.messages, short, short, short], 4), single);
});
test("editing an earlier message branches without later turns or mutations to the original", () => {
  const before = structuredClone(original);
  const branch = branchChat(original, 0, " Revised question ");
  assert.notEqual(branch.id, original.id); assert.equal(branch.account, original.account);
  assert.equal(branch.messages.length, 1); assert.equal(branch.messages[0].text, "Revised question");
  assert.match(branch.title, /Revised question/);
  branch.messages[0].contexts[0].text = "Changed";
  assert.deepEqual(original, before);
});
test("retry preserves prior turns and the failed request's attachments, excluding its partial answer", () => {
  const branch = branchChat(original, 2);
  assert.deepEqual(branch.messages, original.messages.slice(0, 3));
  assert.equal(branch.messages.at(-1).contexts[0].text, "File source");
  assert.throws(() => branchChat(original, 3), /user message/);
  assert.throws(() => branchChat(original, 0, " "), /12,000/);
  assert.throws(() => branchChat(original, 0, "x".repeat(12001)), /12,000/);
});
