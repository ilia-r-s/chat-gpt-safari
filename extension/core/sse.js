/** Handles split UTF-8, CR/LF boundaries, comments, and multi-line SSE data. */
export async function* readSSE(body, signal) {
  if (!body) throw new Error("The server returned an empty stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  let eventSize = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("The server sent an oversized stream event.");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
          eventSize = 0;
        } else if (line.startsWith("data:")) {
          eventSize += line.length;
          if (eventSize > 2_000_000) throw new Error("The server sent an oversized stream event.");
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, "").replace(/\r$/, ""));
        if (data.length) yield data.join("\n");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readResponse(response, { signal, onDelta = () => {}, onActivity = () => {} } = {}) {
  if (!response.ok) {
    const body = await response.text();
    let message = `OpenAI returned HTTP ${response.status}.`;
    try {
      const json = JSON.parse(body);
      message = json.error?.message || json.detail || message;
    } catch { /* Do not expose raw HTML error pages. */ }
    const requestID = response.headers.get("x-request-id");
    throw new Error(`${String(message).slice(0, 700)}${requestID ? ` (Request ${requestID})` : ""}`);
  }
  let receivedText = false;
  const finishedItems = new Map();
  let itemChars = 0;
  for await (const data of readSSE(response.body, signal)) {
    if (data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error("The server returned an invalid stream event."); }
    if (event.type === "response.web_search_call.in_progress") onActivity({ type: "activity", operation: "web_search", state: "working" });
    if (event.type === "response.web_search_call.completed") onActivity({ type: "activity", operation: "web_search", state: "done" });
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (event.delta) receivedText = true;
      onDelta(event.delta ?? "");
    }
    if (event.type === "response.output_item.done" && event.item) {
      const index = event.output_index;
      if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error("The response exceeded the output item limit.");
      itemChars += JSON.stringify(event.item).length - (finishedItems.has(index) ? JSON.stringify(finishedItems.get(index)).length : 0);
      if (itemChars > 1_000_000) throw new Error("The response exceeded the output item size limit.");
      finishedItems.set(index, event.item);
    }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(event.response?.error?.message || event.message || "The response failed. Please try again.");
    }
    if (event.type === "response.incomplete") throw new Error(`The response was incomplete (${event.response?.incomplete_details?.reason ?? "unknown reason"}).`);
    if (event.type === "response.completed" && event.response) {
      // Retain completed streamed items when the terminal event contains only
      // metadata. Tools must still wait for this successful terminal event.
      const output = event.response.output?.length ? event.response.output : [...finishedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      // Some responses deliver text only in the completed message. Never show
      // internal reasoning, and never duplicate text already streamed.
      if (!receivedText) for (const item of output) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part.type === "output_text") onDelta(part.text ?? "");
          else if (part.type === "refusal") onDelta(part.refusal ?? "");
        }
      }
      return { ...event.response, output };
    }
  }
  throw new Error("The connection ended before the response completed. Your partial answer is preserved.");
}
