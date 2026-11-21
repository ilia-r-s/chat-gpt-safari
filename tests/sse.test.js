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
test("streamed failures retain the provider's message, code, parameter and request reference", async () => {
  const event = { type: "response.failed", response: { error: { message: "This app reached its limit.", code: "subscription_sharing_usage_limit_exceeded", param: "model" } } };
  const streamed = response([event]);
  streamed.headers.set("x-request-id", "req_test");
  await assert.rejects(readResponse(streamed), error => {
    assert.equal(error.providerCode, event.response.error.code);
    assert.match(error.message, /^This app reached its limit\..*credit-use settings.*subscription_sharing_usage_limit_exceeded.*parameter model.*req_test/);
    return true;
  });
  for (const frame of [
    { type: "error", code: 0 }, { type: "error", error: { code: 0 } },
    { type: "response.failed", response: { id: "resp_a", error: { code: 0 } } },
  ]) {
    await assert.rejects(readResponse(response([frame])), { providerCode: "0", message: frame.response ? "OpenAI error 0. (Response resp_a)" : "OpenAI error 0." });
  }
  await assert.rejects(readResponse(new Response('event: error\ndata: {"message":"Service is offline","code":8102}\n\n')), { message: "Service is offline (8102)" });
  await assert.rejects(readResponse(response([{ type: "error", status: 503 }])), { message: "Status 503" });
  await assert.rejects(readResponse(response([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }])), /could not check your ChatGPT usage.*subscription_sharing_usage_unavailable/);
});
test("admission errors show safe plain text, numeric codes and an HTTP-only fallback", async () => {
  await assert.rejects(readResponse(new Response(JSON.stringify({ error: { code: 42 } }), { status: 429 })), { message: "OpenAI error 42. (HTTP 429)" });
  await assert.rejects(readResponse(new Response("Rejected test-credential", { status: 401 }), { credential: "test-credential" }), { message: "Rejected [redacted] (HTTP 401)" });
  await assert.rejects(readResponse(new Response("<html>upstream site</html>", { status: 502 })), { message: "HTTP 502" });
  await assert.rejects(readResponse(Response.json({ error: { code: "model_unavailable" } })), { message: "OpenAI error model_unavailable." });
  await assert.rejects(readResponse(Response.json({ error: { code: 4101, type: "workspace_restricted" } }, { status: 403 })), { message: "OpenAI error workspace_restricted. (4101, HTTP 403)" });
  await assert.rejects(readResponse(Response.json({ detail: "Account approval is pending." })), { message: "Account approval is pending." });
  await assert.rejects(readResponse(Response.json({ detail: [{ msg: "A model is required.", input: "private input" }] }, { status: 422 })), { message: "A model is required. (HTTP 422)" });
  await assert.rejects(readResponse(new Response(null, { status: 503, statusText: "Service Unavailable" })), { message: "HTTP 503 Service Unavailable" });
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
test("completion-only text and refusals are recovered without leaking reasoning or duplicating deltas", async () => {
  const completed = { type: "response.completed", response: { output: [
    { type: "reasoning", summary: [{ type: "output_text", text: "INTERNAL" }] },
    { type: "message", content: [{ type: "output_text", text: "Answer." }, { type: "refusal", refusal: " Refusal." }] },
  ] } };
  let text = "";
  await readResponse(response([completed]), { onDelta: delta => { text += delta; } });
  assert.equal(text, "Answer. Refusal.");
  text = "";
  await readResponse(response([{ type: "response.output_text.delta", delta: "Already streamed." }, completed]), { onDelta: delta => { text += delta; } });
  assert.equal(text, "Already streamed.");
});
test("finished streamed output items survive metadata-only completion in output order", async () => {
  const reasoning = { type: "reasoning", encrypted_content: "opaque" };
  const call = { type: "function_call", namespace: "safari", name: "browser", call_id: "scroll", arguments: '{"operation":"scroll"}' };
  const events = [{ type: "response.output_item.done", output_index: 1, item: call }, { type: "response.output_item.done", output_index: 0, item: reasoning }];
  await assert.rejects(readResponse(response(events)), /before the response completed/);
  await assert.rejects(readResponse(response([...events, { type: "response.failed", response: { error: { message: "Failed after tool output" } } }])), /Failed after/);
  assert.deepEqual((await readResponse(response([...events, { type: "response.completed", response: { output: [] } }]))).output, [reasoning, call]);
  const result = await readResponse(response([...events, { type: "response.completed", response: { output: [reasoning, call] } }]));
  assert.equal(result.output.length, 2, "terminal output must not duplicate streamed tool calls");
  await assert.rejects(readResponse(response([{ type: "response.output_item.done", output_index: 64, item: call }])), /output item limit/);
});
test("a terminal event completes without waiting for the connection to close", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"done"}}\n\n')); }, cancel() { cancelled = true; } });
  assert.equal((await readResponse(new Response(body))).id, "done");
  assert.equal(cancelled, true);
});
