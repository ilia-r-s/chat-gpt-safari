import { INSTRUCTIONS, normalizeSettings } from "./config.js";
import { readResponse } from "./sse.js";
import { citedOutput } from "./citations.js";

export const BROWSER_TOOL = {
  type: "namespace", name: "safari", description: "User-approved Safari operations. Read a page before acting on element IDs.",
  tools: [{
    type: "function", name: "browser", description: "Use tabId null for the page where this chat was opened, or an explicit tab ID from attached context or list_tabs. Read the visible page before acting; use current element IDs and their listed actions. Website access follows the user's approval settings. fill enters text without submitting. select chooses a native dropdown by exact value or unique label. set_checked changes a native checkbox/radio. scroll moves the page (elementId null), a listed scroll area, or a carousel using its navigation controls; use its listed directions. To move through other galleries, click a listed tab or next/previous control rather than an offer link. To open an offer the user chose, click its listed link or button. Read again after changes to verify outcomes. To inspect a site in a new tab, call open_tab once, then read its returned tabId. The read waits for loading and handles Safari website permission in the current chat. Use its result before reporting whether the site was accessible. Unused fields must be null.", strict: true,
    parameters: { type: "object", additionalProperties: false, required: ["operation", "tabId", "elementId", "url", "text", "direction", "checked"], properties: {
      operation: { type: "string", enum: ["read", "click", "fill", "select", "set_checked", "scroll", "navigate", "open_tab", "close_tab", "list_tabs"] },
      tabId: { type: ["integer", "null"] }, elementId: { type: ["string", "null"] },
      url: { type: ["string", "null"] }, text: { type: ["string", "null"] },
      direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", "top", "bottom", null] }, checked: { type: ["boolean", "null"] },
    } },
  }],
};

export async function runAgent({ input, model, effort, settings: rawSettings, signal }, dependencies) {
  const settings = normalizeSettings(rawSettings);
  const { credential, executeTool, emit, fetchImpl = fetch } = dependencies;
  if (!model || typeof model !== "string") throw new Error("Connect your account and choose an available model first.");
  const transcript = [...input];
  const usage = { input: 0, cached: 0, output: 0, requests: 0 };
  let resultText = "";
  for (let round = 0; round <= settings.maxToolRounds; round++) {
    signal.throwIfAborted();
    const canAct = round < settings.maxToolRounds;
    const tools = [...(canAct ? [BROWSER_TOOL] : []), ...(settings.webSearch && round < settings.maxToolRounds ? [{ type: "web_search", search_context_size: "medium" }] : [])];
    const capabilities = canAct
      ? "Safari browser tools are available in this chat. For requested page interactions, use safari.browser to read the page and perform the action through its approval flow. An attachment is not required to request a read of the originating tab. Earlier assistant replies may describe capabilities that have since changed; use the tools available now. If a tool fails, explain its specific error rather than claiming this chat cannot interact with the browser."
      : "The browser tool round limit has been reached for this response. Explain the verified result and any remaining work; do not claim unperformed actions succeeded.";
    const request = { model, instructions: `${INSTRUCTIONS}\n\n${capabilities}`, input: transcript, store: false, stream: true, include: ["reasoning.encrypted_content"], ...(tools.length ? { tools, parallel_tool_calls: false } : {}) };
    if (effort) request.reasoning = { effort };
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
    const previousText = resultText;
    const completed = await readResponse(response, { signal, onDelta: text => {
      if (resultText.length + text.length > 120000) throw new Error("The answer reached the output size limit. Ask for a shorter response.");
      resultText += text; emit({ type: "delta", text });
    }, onActivity: event => emit(event) });
    usage.requests++;
    usage.input += completed.usage?.input_tokens ?? 0;
    usage.cached += completed.usage?.input_tokens_details?.cached_tokens ?? 0;
    usage.output += completed.usage?.output_tokens ?? 0;
    emit({ type: "usage", usage });
    const output = completed.output ?? [];
    const cited = citedOutput(output);
    if (cited !== null) {
      if (previousText.length + cited.length > 120000) throw new Error("The answer reached the output size limit. Ask for a shorter response.");
      resultText = previousText + cited; emit({ type: "replace", text: resultText });
    }
    const calls = output.filter(item => item.type === "function_call");
    if (!calls.length) {
      if (!resultText.trim()) throw new Error("The model ended without a reply. Check the page before trying again or choosing another model.");
      return { text: resultText, usage };
    }
    if (!canAct || calls.length > 4) throw new Error("The response exceeded the browser action limit.");
    transcript.push(...output);
    for (const call of calls) {
      signal.throwIfAborted();
      if (call.name !== "browser" || (call.namespace && call.namespace !== "safari")) throw new Error("The model requested an unknown tool.");
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error("The model returned invalid action arguments."); }
      let result;
      emit({ type: "activity", operation: args.operation, state: "working" });
      try { result = await executeTool(args, signal); }
      catch (error) { signal.throwIfAborted(); result = { error: error.message }; }
      emit({ type: "activity", operation: args.operation, state: result?.error ? "error" : "done", detail: result?.error || result?.message || "" });
      const serialized = JSON.stringify(result);
      transcript.push({ type: "function_call_output", call_id: call.call_id, output: serialized.length > settings.pageChars + 6000 ? JSON.stringify({ error: "Result exceeded the page context limit." }) : serialized });
    }
  }
  throw new Error("The browser task reached its action limit. Continue with a new message.");
}
