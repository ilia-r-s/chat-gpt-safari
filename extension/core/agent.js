import { INSTRUCTIONS, normalizeSettings } from "./config.js";
import { readResponse } from "./sse.js";
import { citedOutput } from "./citations.js";
import { actionReceipt, BrowserTranscript } from "./browser-transcript.js";

export const BROWSER_TOOL = {
  type: "namespace", name: "safari", description: "User-approved Safari operations. Read a page before acting on element IDs.",
  tools: [{
    type: "function", name: "browser", strict: true,
    description: [
      "Use tabId null for the originating page or a known tab ID. Read before acting, use fresh element IDs, then read to verify. fill does not submit; select uses exact value/label.",
      "scroll moves the page (elementId null), a listed area or a carousel one step with speed null. Use gallery navigation controls to advance items.",
      "Start continuous scrolling with up/down/left/right and a speed in CSS pixels/second. Optional speedChanges set speeds at cumulative travel distances in CSS pixels. Use wait true to scroll until the user stops it. Otherwise read while moving, slow or reverse with scroll, and stop_motion on reaching the goal.",
      "drag holds the primary button on a listed drag target through a path and releases. move_pointer follows a path with the button up; elementId null allows any visible starting point. Read bounds are [left,top,right,bottom] in visible viewport CSS pixels. When an element is selected start inside it. Supply 2-128 waypoints {x,y,speed}. Each speed applies from that point until changed; null inherits. Initial pointer speed defaults to 600 px/s.",
      "A pointer path waits by default. Set wait false to return immediately for live control. set_speed changes the current scroll or pointer speed mid-segment; zero pauses. wait_motion waits without model polling. stop_motion releases an active drag at its current point. Respect manual takeover. Events are scripted; verify the website accepted them.",
      "double_click sends two clicks and dblclick to the same target. click and double_click can use a listed target or a visible viewport point. Click an editable field to focus it. type_text types at its current caret. press_key takes a printable or editing key in text, e.g. Backspace, Shift+ArrowLeft, Meta+A or Enter (can submit).",
      "select_text takes an exact quote in text (occurrence is one-based when ambiguous), range {start,end} in UTF-16 offsets in a listed element, or neither to use its current selection. Null elementId with a quote searches visible page text. For fields use the field ID. Equal offsets place the caret. copy sends the verified selection to the system clipboard. delete_selection and replace_selection edit it. paste inserts plain clipboard text over the selection or at the caret. Ordinary page edits change the local display. After selection or a field click, follow-up editing operations can reuse that target with elementId null. Never enter sensitive fields.",
      "open_tab once, then read the returned tabId to wait for loading and handle Safari permission. Unused fields must be null.",
    ].join(" "),
    parameters: { type: "object", additionalProperties: false, required: ["operation", "tabId", "elementId", "url", "text", "direction", "speed", "path", "wait", "speedChanges", "point", "range", "occurrence", "checked"], properties: {
      operation: { type: "string", enum: ["read", "click", "fill", "select", "set_checked", "scroll", "drag", "move_pointer", "set_speed", "stop_motion", "wait_motion", "double_click", "type_text", "press_key", "select_text", "copy", "paste", "delete_selection", "replace_selection", "navigate", "open_tab", "close_tab", "list_tabs"] },
      tabId: { type: ["integer", "null"] }, elementId: { type: ["string", "null"] },
      url: { type: ["string", "null"] }, text: { type: ["string", "null"] },
      direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", "top", "bottom", null] },
      speed: { type: ["number", "null"] }, wait: { type: ["boolean", "null"] },
      point: { type: ["object", "null"], additionalProperties: false, required: ["x","y"], properties: { x: { type: "number" }, y: { type: "number" } } },
      range: { type: ["object", "null"], additionalProperties: false, required: ["start","end"], properties: { start: { type: "integer" }, end: { type: "integer" } } },
      occurrence: { type: ["integer","null"] },
      speedChanges: { type: ["array", "null"], items: { type: "object", additionalProperties: false, required: ["after", "speed"], properties: {
        after: { type: "number" }, speed: { type: "number" },
      } } },
      path: { type: ["array", "null"], items: { type: "object", additionalProperties: false, required: ["x", "y", "speed"], properties: {
        x: { type: "number" }, y: { type: "number" }, speed: { type: ["number", "null"] },
      } } }, checked: { type: ["boolean", "null"] },
    } },
  }],
};

export async function runAgent({ input, model, effort, settings: rawSettings, signal }, dependencies) {
  const settings = normalizeSettings(rawSettings);
  const { credential, executeTool, stopMotion, emit, fetchImpl = fetch } = dependencies;
  if (!model || typeof model !== "string") throw new Error("Connect your account and choose an available model first.");
  const transcript = new BrowserTranscript(input);
  const usage = { input: 0, cached: 0, output: 0, requests: 0 };
  let resultText = "";
  const limit = settings.maxBrowserActions;
  let used = 0;
  const reportActions = () => emit({ type: "browser.actions", actions: { used, limit } });
  reportActions();
  for (;;) {
    signal.throwIfAborted();
    const canAct = used < limit;
    if (!canAct) await stopMotion?.("action limit");
    const tools = canAct ? [BROWSER_TOOL, ...(settings.webSearch ? [{ type: "web_search", search_context_size: "medium" }] : [])] : [];
    const capabilities = canAct
      ? "Safari browser tools are available in this chat. For requested page interactions, use safari.browser to read the page and perform the action through its approval flow. Continue through the requested steps while permitted actions can make progress. Stop when the task is complete, needs user input, or is blocked. An attachment is not required to request a read of the originating tab. Earlier assistant replies may describe capabilities that have since changed; use the tools available now. If a tool fails, explain its specific error rather than claiming this chat cannot interact with the browser."
      : "The browser action limit for this message has been reached. Summarize the verified outcome and any unfinished steps.";
    const request = { model, instructions: `${INSTRUCTIONS}\n\n${capabilities}`, store: false, stream: true, include: ["reasoning.encrypted_content"], ...(tools.length ? { tools, parallel_tool_calls: false } : {}) };
    if (effort) request.reasoning = { effort };
    const body = transcript.requestBody(request, settings.inputChars + 4000);
    emit({ type: "status", text: used ? "Continuing\u2026" : "Thinking\u2026" });
    const token = await credential();
    signal.throwIfAborted();
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST", signal, credentials: "omit", cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
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
    const items = [...output], receipts = [];
    for (const call of calls) {
      signal.throwIfAborted();
      if (call.name !== "browser" || (call.namespace && call.namespace !== "safari")) throw new Error("The model requested an unknown tool.");
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error("The model returned invalid action arguments."); }
      let result;
      if (used < limit) {
        used++;
        reportActions();
        emit({ type: "activity", operation: args?.operation, state: "working" });
        try { result = await executeTool(args, signal); }
        catch (error) { signal.throwIfAborted(); result = { error: error.message }; }
        emit({ type: "activity", operation: args?.operation, state: result?.error ? "error" : "done", detail: result?.error || result?.message || "" });
        receipts.push(actionReceipt(args ?? {}, result));
      } else {
        result = { error: "Skipped because this message used its browser action allowance. This call was not attempted." };
      }
      const serialized = JSON.stringify(result);
      items.push({ type: "function_call_output", call_id: call.call_id, output: serialized.length > settings.pageChars + 6000 ? JSON.stringify({ error: "Result exceeded the page context limit." }) : serialized });
    }
    transcript.add(items, receipts);
  }
}
