const escape = value => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function inline(value) {
  // Escape first. Only HTTP(S) links are emitted; HTML and images remain plain text.
  return escape(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function markdown(text) {
  let code = false;
  let list = false;
  let output = "";
  let paragraph = [];
  const flush = () => { if (paragraph.length) { output += `<p>${paragraph.map(inline).join("<br>")}</p>`; paragraph = []; } };
  const closeList = () => { if (list) { output += "</ul>"; list = false; } };
  for (const line of String(text).split("\n")) {
    if (line.startsWith("```")) {
      flush(); closeList(); output += code ? "</code></pre>" : "<pre><code>"; code = !code; continue;
    }
    if (code) { output += `${escape(line)}\n`; continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) { flush(); closeList(); output += `<h3>${inline(heading[1])}</h3>`; continue; }
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
    if (item) { flush(); if (!list) { output += "<ul>"; list = true; } output += `<li>${inline(item[1])}</li>`; continue; }
    closeList(); paragraph.push(line);
  }
  flush(); closeList(); if (code) output += "</code></pre>";
  return output;
}
