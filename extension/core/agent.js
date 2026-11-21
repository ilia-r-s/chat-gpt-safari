import { INSTRUCTIONS, normalizeSettings } from "./config.js";
import { readResponse } from "./sse.js";
import { citedOutput } from "./citations.js";
import { actionReceipt, BrowserTranscript } from "./browser-transcript.js";
import { GESTURE_TOOL } from "./gestures.js";
import { BROWSER_ACTIONS, availableBrowserActions } from "./browser-actions.js";

export const BROWSER_TOOL = {
  type: "namespace", name: "safari", description: "User-approved Safari operations. Read a page before acting on element IDs.",
  tools: [{
    type: "function", name: "browser", strict: true,
    description: [
      "Null tabId targets the source. For tab questions list_tabs in the source window; redacted entries are real tabs. Read their IDs to request access. After open_tab read the returned ID; after click/Enter check openedTabId or list tabs before repeating.",
      "Read and act on other tabs by ID. Motion brings its target into view automatically. Use switch_tab when asked to show a tab; keep passing its ID for later actions. If its layout changed, read it again and use fresh bounds.",
      "Read before acting. Use fresh element IDs and viewport CSS bounds [left,top,right,bottom]. Read again to verify. fill does not submit; select uses the listed value or label. click/double_click may use a viewport point.",
      "For words on this page, find_text searches loaded rendered text and reveals a match (optional one-based occurrence). For virtual feeds or to find a carousel use scroll_until with up/down and text (carousel or a phrase). It stops at the target, boundary or search checkpoint. A viewport read alone cannot prove absence. Continue with fresh controls.",
      "scroll moves one page/area step, or one carousel item using its navigation. For actual swipes, pinch, rotation, pressure, taps and timed input over the pictures use safari.gesture. Never substitute a control click for a requested gesture.",
      "For continuous scroll give direction and speed (CSS px/s); speedChanges are cumulative distances. Read while moving; wait=true only for requested manual stop. drag holds the primary button on a listed target; move_pointer allows a free start. Use 2-128 visible waypoints, each speed applies until changed; null inherits (default 600 px/s). Paths wait unless wait=false. set_speed changes active motion, zero pauses; wait_motion waits and stop_motion releases. Respect manual takeover.",
      "Click a writable field before type_text or press_key (e.g. Enter, Shift+ArrowLeft, Meta+A). select_text uses a quote plus optional occurrence, a UTF-16 range, or the current selection. Null elementId and quote select visible page text. copy/delete_selection/replace_selection use the selection; paste inserts plain clipboard text. Reuse bound fields with null elementId. Ordinary page edits are local. Never enter sensitive fields. Other unused fields are null.",
    ].join(" "),
    parameters: { type: "object", additionalProperties: false, required: ["operation", "tabId", "elementId", "url", "text", "direction", "speed", "path", "wait", "speedChanges", "point", "range", "occurrence", "checked"], properties: {
      operation: { type: "string", enum: BROWSER_ACTIONS },
      tabId: { type: ["integer", "null"] }, elementId: { type: ["string", "null"] },
      url: { type: ["string", "null"] }, text: { type: ["string", "null"] },
      direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", "top", "bottom", null] },
      speed: { type: ["number", "null"], description: "Motion px/s, gesture playback multiplier, or tab zoom factor for zoom (1 = 100%)." }, wait: { type: ["boolean", "null"] },
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
  }, GESTURE_TOOL],
};

export async function runAgent({ input, model, effort, reasoningMode, settings: rawSettings, signal }, dependencies) {
  const settings = normalizeSettings(rawSettings);
  const { credential, executeTool, stopMotion, emit, fetchImpl = fetch } = dependencies;
  const tool = structuredClone(BROWSER_TOOL);
  if (dependencies.browserAPI) {
    const actions = availableBrowserActions(dependencies.browserAPI);
    tool.tools[0].parameters.properties.operation.enum = actions;
    if (!actions.includes("read")) tool.tools = actions.length ? [tool.tools[0]] : [];
  }
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
    const tools = canAct && tool.tools.length ? [tool] : [];
    if (settings.webSearch && canAct) tools.push({ type: "web_search", search_context_size: "medium" });
    const capabilities = canAct
      ? "Safari browser tools are available in this chat. For requested page interactions, use safari.browser to read the page and perform the action through its approval flow. Continue through the requested steps while permitted actions can make progress. Stop when the task is complete, needs user input, or is blocked. An attachment is not required to request a read of the originating tab. Earlier assistant replies may describe capabilities that have since changed; use the tools available now. If a tool fails, explain its specific error rather than claiming this chat cannot interact with the browser."
      : "The browser action limit for this message has been reached. Summarize the verified outcome and any unfinished steps.";
    const request = { model, instructions: `${INSTRUCTIONS}\n\n${capabilities}`, store: false, stream: true, include: ["reasoning.encrypted_content"], ...(tools.length ? { tools, parallel_tool_calls: false } : {}) };
    if (effort || reasoningMode) request.reasoning = { ...(effort && { effort }), ...(reasoningMode && { mode: reasoningMode }) };
    const body = transcript.requestBody(request, settings.inputChars + 4000);
    emit({ type: "status", text: used ? "Continuing\u2026" : "Thinking\u2026" });
    const token = await credential();
    signal.throwIfAborted();
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST", signal, credentials: "omit", cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
    const previousText = resultText;
    const completed = await readResponse(response, { signal, credential: token, onDelta: text => {
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
      if (!["browser", "gesture"].includes(call.name) || (call.namespace && call.namespace !== "safari")) throw new Error("The model requested an unknown tool.");
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error("The model returned invalid action arguments."); }
      if (call.name === "gesture") args = { ...args, operation: "gesture" };
      let result;
      if (used < limit) {
        used++;
        reportActions();
        emit({ type: "activity", operation: args?.operation, state: "working" });
        try { result = await executeTool(args, signal); }
        catch (error) { signal.throwIfAborted(); result = { error: error.message }; }
        emit({ type: "activity", operation: args?.operation, state: result?.error || result?.ok === false ? "error" : result?.found === false ? "unmatched" : "done", detail: result?.error || result?.message || "" });
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
