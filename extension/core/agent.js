import { INSTRUCTIONS, normalizeSettings } from "./config.js";
import { readResponse } from "./sse.js";

export const BROWSER_TOOL = {
  type: "namespace", name: "safari", description: "User-approved Safari operations. Read a page before acting on element IDs.",
  tools: [{
    type: "function", name: "browser", description: "Read or act in an attached Safari tab. Every write and new page read needs approval. Use IDs from the latest read.", strict: true,
    parameters: { type: "object", additionalProperties: false, required: ["operation", "tabId", "elementId", "url", "text"], properties: {
      operation: { type: "string", enum: ["read", "click", "fill", "navigate", "open_tab", "close_tab", "list_tabs"] },
      tabId: { type: ["integer", "null"] }, elementId: { type: ["string", "null"] },
      url: { type: ["string", "null"] }, text: { type: ["string", "null"] },
    } },
  }],
};

export async function runAgent({ input, model, settings: rawSettings, signal }, dependencies) {
  const settings = normalizeSettings(rawSettings);
  const { credential, executeTool, emit, fetchImpl = fetch } = dependencies;
  if (!model || typeof model !== "string") throw new Error("Connect your account and choose an available model first.");
  const transcript = [...input];
  const usage = { input: 0, cached: 0, output: 0, requests: 0 };
  let resultText = "";
  for (let round = 0; round <= settings.maxToolRounds; round++) {
    signal.throwIfAborted();
    const tools = settings.browserTools && round < settings.maxToolRounds ? [BROWSER_TOOL] : [];
    const request = { model, instructions: INSTRUCTIONS, input: transcript, store: false, stream: true, include: ["reasoning.encrypted_content"], ...(tools.length ? { tools, parallel_tool_calls: false } : {}) };
    if (JSON.stringify(request).length > settings.inputChars + 4000) {
      throw new Error("The browser task reached its context budget. Start a new chat with the relevant page attached.");
    }
    emit({ type: "status", text: round ? "Continuing\u2026" : "Thinking\u2026" });
    const token = await credential();
    signal.throwIfAborted();
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST", signal, credentials: "omit", cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    const completed = await readResponse(response, { signal, onDelta: text => {
      if (resultText.length + text.length > 120000) throw new Error("The answer reached the output size limit. Ask for a shorter response.");
      resultText += text; emit({ type: "delta", text });
    } });
    usage.requests++;
    usage.input += completed.usage?.input_tokens ?? 0;
    usage.cached += completed.usage?.input_tokens_details?.cached_tokens ?? 0;
    usage.output += completed.usage?.output_tokens ?? 0;
    emit({ type: "usage", usage });
    const output = completed.output ?? [];
    const calls = output.filter(item => item.type === "function_call");
    if (!calls.length) return { text: resultText, usage };
    if (!tools.length || calls.length > 4) throw new Error("The response exceeded the browser action limit.");
    transcript.push(...output);
    for (const call of calls) {
      signal.throwIfAborted();
      if (call.name !== "browser" || (call.namespace && call.namespace !== "safari")) throw new Error("The model requested an unknown tool.");
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error("The model returned invalid action arguments."); }
      let result;
      try { result = await executeTool(args, signal); }
      catch (error) { signal.throwIfAborted(); result = { error: error.message }; }
      const serialized = JSON.stringify(result);
      transcript.push({ type: "function_call_output", call_id: call.call_id, output: serialized.length > settings.pageChars + 6000 ? JSON.stringify({ error: "Result exceeded the page context limit." }) : serialized });
    }
  }
  throw new Error("The browser task reached its action limit. Continue with a new message.");
}
