import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../extension/core/agent.js";

const stream = result => new Response(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
const base = { input: [{ role: "user", content: "Hello" }], model: "available-model", settings: {}, signal: new AbortController().signal };
test("Responses uses public endpoint, stateless streaming, and no unsupported billing fields", async () => {
  let request;
  await runAgent(base, { credential: async () => "fake-test-token", emit() {}, executeTool() { throw new Error("unexpected"); }, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); request = JSON.parse(options.body);
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    return stream({ output: [], usage: { input_tokens: 10, output_tokens: 4 } });
  } });
  assert.equal(request.store, false); assert.equal(request.stream, true); assert.ok(!("tools" in request));
  for (const field of ["previous_response_id", "max_output_tokens", "temperature", "conversation"]) assert.ok(!(field in request));
});
test("tool outputs and encrypted reasoning are carried to the next bounded request", async () => {
  const requests = [];
  const statuses = [];
  const call = { type: "function_call", namespace: "safari", name: "browser", call_id: "call1", arguments: JSON.stringify({ operation: "read", tabId: 1 }) };
  const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
  let calls = 0;
  await runAgent({ ...base, settings: { browserTools: true } }, { credential: async () => "test", emit(event) { if (event.type === "status") statuses.push(event.text); }, executeTool: async args => { calls++; assert.equal(args.operation, "read"); return { text: "Page text" }; }, fetchImpl: async (_, opts) => {
    requests.push(JSON.parse(opts.body)); return stream({ output: requests.length === 1 ? [reasoning, call] : [] });
  } });
  assert.equal(calls, 1); assert.equal(requests.length, 2); assert.equal(requests[0].tools[0].type, "namespace");
  assert.deepEqual(statuses, ["Thinking\u2026", "Continuing\u2026"]);
  assert.equal(requests[1].input[1].encrypted_content, "opaque");
  assert.equal(requests[1].input.at(-1).call_id, "call1");
});
test("disabled tools and unknown tools cannot execute", async () => {
  let executed = false;
  const call = { type: "function_call", name: "shell", call_id: "x", arguments: "{}" };
  const dependencies = { credential: async () => "test", emit() {}, executeTool: async () => { executed = true; }, fetchImpl: async () => stream({ output: [call] }) };
  await assert.rejects(runAgent(base, dependencies), /action limit/);
  await assert.rejects(runAgent({ ...base, settings: { browserTools: true } }, dependencies), /unknown tool/);
  assert.equal(executed, false);
});
test("repeated tool requests terminate at the configured round limit", async () => {
  let requests = 0;
  await assert.rejects(runAgent({ ...base, settings: { browserTools: true, maxToolRounds: 1 } }, {
    credential: async () => "test", emit() {}, executeTool: async () => ({ ok: true }),
    fetchImpl: async () => { requests++; return stream({ output: [{ type: "function_call", name: "browser", call_id: "x", arguments: "{}" }] }); },
  }), /action limit/);
  assert.equal(requests, 2);
});
test("cancelled runs do not request credentials or make API calls", async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(runAgent({ ...base, signal: controller.signal }, { credential: async () => { called = true; }, emit() {}, fetchImpl() {} }), { name: "AbortError" });
  assert.equal(called, false);
});
