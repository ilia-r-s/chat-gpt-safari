import test from "node:test";
import assert from "node:assert/strict";
import { readTextFiles } from "../extension/panel/attachments.js";
import { buildInput } from "../extension/core/context.js";
import { boundedDraft } from "../extension/core/drafts.js";
import { citedOutput } from "../extension/core/citations.js";
import { markdown } from "../extension/panel/markdown.js";

const file = (name, text, type = "") => new File([text], name, { type });
test("same-name files retain distinct identities and exact UTF-8 source formatting through storage and inference", async () => {
  const texts = ["  def f():\r\n\treturn  '�'\r\n\r\n\r\n", "a\tb\t \n  last row   "];
  const sources = await readTextFiles(texts.map(text => file("source.txt", text)), 12000);
  assert.notEqual(sources[0].key, sources[1].key);
  const { contexts } = boundedDraft({ id: "draft", account: "test", contexts: sources });
  const question = { role: "user", text: "Compare the files", contexts };
  const built = buildInput([question], {});
  assert.deepEqual(built.input.slice(0, -1).map(item => JSON.parse(item.content.split("\n")[1]).text), texts);
  assert.equal(built.trimmed, false);
  await assert.rejects(readTextFiles([file("bad.txt", Uint8Array.of(0xc3, 0x28))], 12000), /UTF-8/);
  const [excerpt] = await readTextFiles([file("unicode.txt", "a🌿b")], 2);
  assert.equal(excerpt.text, "a"); assert.equal(excerpt.truncated, true);
  const noisy = '\t"\\'.repeat(4000);
  const trimmed = buildInput([{ ...question, contexts: [{ ...contexts[0], text: noisy }] }], { inputChars: 16000, pageChars: 12000 });
  const reference = JSON.parse(trimmed.input[0].content.split("\n")[1]);
  assert.equal(reference.truncated, true);
  const retained = reference.text;
  assert.ok(trimmed.trimmed && retained.length > 0 && retained.length < noisy.length && noisy.startsWith(retained));
  assert.ok(trimmed.chars <= 16000);
});
test("text attachments accept a bounded batch and disclose trimming", async () => {
  const result = await readTextFiles([file("note.md", "abcdef"), file("data.json", "{}")], 4);
  assert.deepEqual(result.map(({ title, text, truncated }) => ({ title, text, truncated })), [
    { title: "note.md", text: "abcd", truncated: true }, { title: "data.json", text: "{}", truncated: false },
  ]);
  for (const files of [[file("secret.pdf", "binary")], [file("bad.txt", "a\0b")], [file("large.txt", "x".repeat(200001))], Array(7).fill(file("a.txt", "a"))]) {
    await assert.rejects(readTextFiles(files, 100));
  }
});

const output = (text, annotations = []) => [{ type: "message", content: [{ type: "output_text", text, annotations }] }];
const cite = (start, end, extra = {}) => ({ type: "url_citation", start_index: start, end_index: end, title: "Source", url: "https://example.com/reference", ...extra });
test("URL citations become escaped clickable links without deleting cited prose", () => {
  const text = "Result [1]. (A claim)";
  const result = citedOutput(output(text, [cite(7, 10), cite(12, 21, { title: "A [bad] <title>", url: "https://example.com/a(b)?q=1&v=2" })]));
  assert.equal(result, "Result [Source](https://example.com/reference). (A claim) [A  bad   title](https://example.com/a%28b%29?q=1&v=2)");
  const html = markdown(result);
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.ok(html.includes('href="https://example.com/a%28b%29?q=1&amp;v=2"'));
  assert.ok(!html.includes("<title>"));
  const marker = "\uE200cite\uE202turn0search0\uE201";
  assert.equal(citedOutput(output(`Fact. ${marker}`, [cite(6, 6 + marker.length)])), "Fact. [Source](https://example.com/reference)");
});
test("invalid, unsafe and overlapping URL citations cannot corrupt an answer", () => {
  const text = "A fact and another.";
  assert.equal(citedOutput(output(text)), null);
  assert.equal(citedOutput(output(text, [cite(-1, 3), cite(0, 500), cite(0, 2, { url: "javascript:alert(1)" }), cite(0, 2, { url: "https://user:secret@example.com" })])), null);
  const result = citedOutput(output(text, [cite(2, 6), cite(2, 6), cite(0, 7)]));
  assert.equal(result, "A fact [Source](https://example.com/reference) and another.");
  const many = citedOutput(output("x".repeat(60), Array.from({ length: 60 }, (_, i) => cite(i, i + 1))));
  assert.equal((many.match(/\[Source\]/g) ?? []).length, 40);
});
