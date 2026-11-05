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

export async function readResponse(response, { signal, onDelta = () => {} } = {}) {
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
  for await (const data of readSSE(response.body, signal)) {
    if (data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error("The server returned an invalid stream event."); }
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") onDelta(event.delta ?? "");
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(event.response?.error?.message || event.message || "The response failed. Please try again.");
    }
    if (event.type === "response.incomplete") throw new Error(`The response was incomplete (${event.response?.incomplete_details?.reason ?? "unknown reason"}).`);
    if (event.type === "response.completed" && event.response) return event.response;
  }
  throw new Error("The connection ended before the response completed. Your partial answer is preserved.");
}
