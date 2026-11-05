import test from "node:test";
import assert from "node:assert/strict";
import { readSSE, readResponse } from "../extension/core/sse.js";

export function response(events, chunkSize = 7) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } }), { status: 200 });
}
test("SSE preserves UTF-8 characters split across chunks and CRLF", async () => {
  let text = "";
  const result = await readResponse(response([{ type: "response.output_text.delta", delta: "Привет 🌿" }, { type: "response.completed", response: { id: "ok" } }], 1), { onDelta: delta => { text += delta; } });
  assert.equal(text, "Привет 🌿"); assert.equal(result.id, "ok");
});
test("SSE supports comments and multiline data", async () => {
  const body = new Response(": hello\ndata: first\ndata: second\n\n").body;
  const events = []; for await (const event of readSSE(body)) events.push(event);
  assert.deepEqual(events, ["first\nsecond"]);
});
test("partial answers never count as completed requests", async () => {
  await assert.rejects(readResponse(response([{ type: "response.output_text.delta", delta: "Partial" }])), /before the response completed/);
});
test("failed and incomplete responses remain failures after partial output", async () => {
  await assert.rejects(readResponse(response([{ type: "response.failed", response: { error: { message: "Usage limit reached" } } }])), /Usage limit/);
  await assert.rejects(readResponse(response([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])), /incomplete/);
});
test("nonstandard admission errors preserve HTTP detail and request ID", async () => {
  await assert.rejects(readResponse(new Response(JSON.stringify({ detail: "Plan permission missing" }), { status: 403, headers: { "x-request-id": "req_test" } })), /Plan permission missing.*req_test/);
});
test("cancellation and malformed stream data fail promptly", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readResponse(response([{ type: "response.completed", response: {} }]), { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(readResponse(new Response("data: not-json\n\n")), /invalid stream/);
});
test("refusal text is displayed rather than silently yielding an empty answer", async () => {
  let text = "";
  await readResponse(response([{ type: "response.refusal.delta", delta: "I cannot help with that request." }, { type: "response.completed", response: { output: [] } }]), { onDelta: delta => { text += delta; } });
  assert.equal(text, "I cannot help with that request.");
});
test("a terminal event completes without waiting for the connection to close", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"done"}}\n\n')); }, cancel() { cancelled = true; } });
  assert.equal((await readResponse(new Response(body))).id, "done");
  assert.equal(cancelled, true);
});
