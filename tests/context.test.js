import test from "node:test";
import assert from "node:assert/strict";
import { buildInput, compactText, safeWebURL, publicURL, estimateTokens } from "../extension/core/context.js";
import { normalizeSettings } from "../extension/core/config.js";

test("context includes only explicit sources and keeps the newest snapshot once", () => {
  const source = { key: "page:one", kind: "page", title: "Source", url: "https://example.com/?code=secret", text: "OLD" };
  const result = buildInput([{ role: "user", text: "First", contexts: [source] }, { role: "assistant", text: "Reply" }, { role: "user", text: "Second", contexts: [{ ...source, text: "NEW" }] }], {});
  assert.equal(result.sourceCount, 1);
  assert.ok(JSON.stringify(result.input).includes("NEW"));
  assert.ok(!JSON.stringify(result.input).includes("OLD"));
  assert.ok(!JSON.stringify(result.input).includes("secret"));
  assert.equal(result.input.at(-1).content, "Second");
});
test("history trims whole turns without orphaning assistant replies", () => {
  const messages = Array.from({ length: 15 }, (_, i) => [{ role: "user", text: `Question ${i}` }, { role: "assistant", text: `Reply ${i}` }]).flat();
  messages.push({ role: "user", text: "Latest" });
  const result = buildInput(messages, { historyTurns: 2 });
  assert.deepEqual(result.input.map(m => m.content), ["Question 14", "Reply 14", "Latest"]);
  assert.equal(result.trimmed, true);
});
test("total input stays bounded under adversarial long source text", () => {
  const result = buildInput([{ role: "user", text: "Summarize", contexts: Array.from({ length: 6 }, (_, i) => ({ key: `p${i}`, kind: "page", title: "x".repeat(1000), text: "a".repeat(100000) })) }], { inputChars: 12000, pageChars: 24000 });
  assert.ok(result.chars <= 12000);
  assert.equal(result.trimmed, true);
});
test("empty requests and oversized user messages fail before API requests", () => {
  assert.throws(() => buildInput([], {}), /Write a message/);
  assert.throws(() => buildInput([{ role: "user", text: "a".repeat(12001) }], {}), /12,000/);
});
test("restricted schemes, embedded credentials and malformed URLs are rejected", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,a", "https://user:pass@site.test", "not a url"]) assert.equal(safeWebURL(url), null);
  assert.equal(safeWebURL("https://example.com/a"), "https://example.com/a");
  assert.equal(publicURL("https://example.com/a?token=secret#code=secret"), "https://example.com/a");
});
test("settings clamp resource limits and reject non-boolean tools", () => {
  assert.equal(normalizeSettings({ inputChars: Infinity }).inputChars, 48000);
  assert.equal(normalizeSettings({ pageChars: -1 }).pageChars, 2000);
  assert.equal(normalizeSettings({ maxToolRounds: 1000 }).maxToolRounds, 10);
  assert.equal(normalizeSettings({ browserTools: "true" }).browserTools, false);
});
test("text compaction and token estimate handle Unicode and whitespace", () => {
  assert.equal(compactText("  a   b\n\n\n c ", 100), "a b\n\n c");
  assert.equal(compactText("x".repeat(100), 30).length, 30);
  assert.ok(estimateTokens("日本語") > estimateTokens("abc"));
});
