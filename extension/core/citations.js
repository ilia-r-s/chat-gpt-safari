import { safeWebURL } from "./context.js";

/** Turn provider URL annotations into persisted, clickable Markdown citations. */
export function citedOutput(output) {
  let hasCitations = false;
  const parts = [];
  let count = 0;
  for (const item of output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") { parts.push(part.refusal ?? ""); continue; }
      if (part.type !== "output_text" || typeof part.text !== "string") continue;
      let text = part.text;
      const annotations = (part.annotations ?? []).filter(a => a.type === "url_citation" && safeWebURL(a.url)
        && Number.isInteger(a.start_index) && Number.isInteger(a.end_index) && a.start_index >= 0 && a.end_index >= a.start_index && a.end_index <= text.length)
        .slice(0, 40).sort((a, b) => b.start_index - a.start_index);
      let boundary = text.length;
      for (const citation of annotations) {
        if (citation.end_index > boundary || count >= 40) continue;
        const url = safeWebURL(citation.url).replace(/[()]/g, char => char === "(" ? "%28" : "%29");
        const title = String(citation.title || new URL(url).hostname).replace(/[\[\]\\`*<>\r\n]/g, " ").trim().slice(0, 120) || "Source";
        const link = `[${title}](${url})`;
        const marked = text.slice(citation.start_index, citation.end_index);
        // Preserve prose if an annotation covers a claim rather than a marker.
        const marker = /^\s*(?:\[\d+(?:[,;\s]+\d+)*\]|\(\d+\)|\u3010[^\u3011]*\u3011|\uE200[^\uE201]*\uE201)\s*$/.test(marked);
        text = text.slice(0, marker ? citation.start_index : citation.end_index) + (marker ? "" : " ") + link + text.slice(citation.end_index);
        boundary = citation.start_index; hasCitations = true; count++;
      }
      parts.push(text);
    }
  }
  return hasCitations ? parts.join("\n\n") : null;
}
