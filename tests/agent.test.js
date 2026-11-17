import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../extension/core/agent.js";

const stream = result => new Response(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] };
const base = { input: [{ role: "user", content: "Hello" }], model: "available-model", settings: {}, signal: new AbortController().signal };
test("Responses uses public endpoint, stateless streaming, and no unsupported billing fields", async () => {
  let request;
  await runAgent(base, { credential: async () => "fake-test-token", emit() {}, executeTool() { throw new Error("unexpected"); }, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); request = JSON.parse(options.body);
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    return stream({ output: [answer], usage: { input_tokens: 10, output_tokens: 4 } });
  } });
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.deepEqual(request.tools.map(tool => tool.type), ["namespace"], "every ordinary chat receives Safari tools");
  assert.match(request.instructions, /Safari browser tools are available/);
  assert.ok(!("reasoning" in request), "Auto leaves the model's default effort unchanged");
  for (const field of ["previous_response_id", "max_output_tokens", "temperature", "conversation"]) assert.ok(!(field in request));
});
test("tool outputs and encrypted reasoning are carried to the next bounded request", async () => {
  const requests = [];
  const statuses = [];
  const call = { type: "function_call", namespace: "safari", name: "browser", call_id: "call1", arguments: JSON.stringify({ operation: "read", tabId: 1 }) };
  const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
  let calls = 0;
  await runAgent({ ...base, effort: "high" }, { credential: async () => "test", emit(event) { if (event.type === "status") statuses.push(event.text); }, executeTool: async args => { calls++; assert.equal(args.operation, "read"); return { text: "Page text" }; }, fetchImpl: async (_, opts) => {
    requests.push(JSON.parse(opts.body)); return stream({ output: requests.length === 1 ? [reasoning, call] : [answer] });
  } });
  assert.equal(calls, 1); assert.equal(requests.length, 2); assert.equal(requests[0].tools[0].type, "namespace");
  assert.deepEqual(statuses, ["Thinking\u2026", "Continuing\u2026"]);
  assert.equal(requests[1].input[1].encrypted_content, "opaque");
  assert.equal(requests[1].input.at(-1).call_id, "call1");
  for (const request of requests) assert.deepEqual(request.reasoning, { effort: "high" });
});
test("unknown tools cannot execute", async () => {
  let executed = false;
  const call = { type: "function_call", name: "shell", call_id: "x", arguments: "{}" };
  const dependencies = { credential: async () => "test", emit() {}, executeTool: async () => { executed = true; }, fetchImpl: async () => stream({ output: [call] }) };
  await assert.rejects(runAgent(base, dependencies), /unknown tool/);
  assert.equal(executed, false);
});
test("repeated tool requests terminate at the configured round limit", async () => {
  let requests = 0;
  await assert.rejects(runAgent({ ...base, settings: { maxToolRounds: 1 } }, {
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
test("an empty final response reports failure without silently retrying browser actions", async () => {
  let calls = 0, requests = 0;
  await assert.rejects(runAgent(base, {
    credential: async () => "test", emit() {}, executeTool: async () => { calls++; return { ok: true }; },
    fetchImpl: async () => stream({ output: ++requests === 1 ? [{ type: "function_call", name: "browser", call_id: "x", arguments: "{}" }] : [] }),
  }), /ended without a reply.*Check the page/);
  assert.equal(requests, 2); assert.equal(calls, 1);
});
test("opted-in public web search reports activity and persists clickable citations", async () => {
  const events = []; let request;
  const output = [{ type: "web_search_call", id: "search-1", status: "completed" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fact. [1]", annotations: [{ type: "url_citation", start_index: 6, end_index: 9, title: "Reference", url: "https://example.com/source" }] }] }];
  const result = await runAgent({ ...base, settings: { webSearch: true } }, {
    credential: async () => "test", executeTool() { assert.fail("no browser action was requested"); }, emit: event => events.push(event),
    fetchImpl: async (_, options) => {
      request = JSON.parse(options.body);
      return new Response([
        { type: "response.web_search_call.in_progress", item_id: "search-1" },
        { type: "response.output_text.delta", delta: "Fact. [1]" },
        { type: "response.web_search_call.completed", item_id: "search-1" },
        { type: "response.completed", response: { output } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    },
  });
  assert.deepEqual(request.tools.map(tool => tool.type), ["namespace", "web_search"]);
  assert.deepEqual(request.tools[1], { type: "web_search", search_context_size: "medium" });
  assert.equal(result.text, "Fact. [Reference](https://example.com/source)");
  assert.deepEqual(events.filter(e => e.type === "activity").map(e => e.state), ["working", "done"]);
  assert.equal(events.find(e => e.type === "replace").text, result.text);
});
test("provider search rejection is not retried", async () => {
  let requests = 0;
  const dependencies = { credential: async () => "test", emit() {}, executeTool() { assert.fail("unapproved browser execution"); }, fetchImpl: async () => {
    requests++; return new Response(JSON.stringify({ error: { message: "Web search is not supported for this model" } }), { status: 400 });
  } };
  await assert.rejects(runAgent({ ...base, settings: { webSearch: true } }, dependencies), /not supported/);
  assert.equal(requests, 1);
});
