// Safari serializes this function into the page. Only a matched passage leaves
// the isolated world. With no occurrence it installs a viewport probe for motion.
export function findPageText(url, query, occurrence) {
  const refs = globalThis.__safariChatRefs;
  if (!refs || refs.url !== url || location.href !== url) throw new Error("The page changed. Read it again.");
  const words = query.trim().split(/\s+/).map(word => word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
  const pattern = new RegExp(words.join("\\s+"), "giu");
  const excluded = "script,style,noscript,template,svg,input,textarea,select,[contenteditable],[hidden],[inert],[aria-hidden=true],#safari-chat-host";
  const blocks = "p,li,div,h1,h2,h3,h4,h5,h6,article,section,header,footer,td,th,dt,dd,summary,figcaption,pre,blockquote,button,a";
  function exposed(range, element) {
    const edge = globalThis.__safariChatPageRight ?? innerWidth;
    return Array.from(range.getClientRects()).some(rect => {
      const l = Math.max(0, rect.left), r = Math.min(edge, rect.right), t = Math.max(0, rect.top), b = Math.min(innerHeight, rect.bottom);
      return l < r && t < b && element.contains(document.elementFromPoint((l + r) / 2, (t + b) / 2));
    });
  }
  function search(scope, viewportOnly) {
    let block, parts = [], text = "", count = 0, visited = 0, chars = 0, truncated = false;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const visible = new WeakMap();
    function readable(node) {
      const el = node.parentElement;
      if (!visible.has(el)) visible.set(el, refs.rendered(el, viewportOnly));
      return visible.get(el);
    }
    function matchPassage() {
      pattern.lastIndex = 0;
      let match, firstIndex = 0;
      while ((match = pattern.exec(text))) {
        const a = match.index, z = a + match[0].length;
        while (firstIndex < parts.length && parts[firstIndex].end <= a) firstIndex++;
        let endIndex = firstIndex;
        while (endIndex < parts.length && parts[endIndex].start < z) endIndex++;
        if (endIndex === firstIndex || !parts.slice(firstIndex, endIndex).every(p => readable(p.node))) continue;
        const first = parts[firstIndex], last = parts[endIndex - 1];
        const range = document.createRange();
        range.setStart(first.node, a - first.start);
        range.setEnd(last.node, z - last.start);
        if (!range.getClientRects().length || (viewportOnly && !exposed(range, block))) continue;
        if (++count < (occurrence ?? 1)) continue;
        const from = Math.max(0, a - 70), to = Math.min(text.length, z + 100);
        const excerpt = parts.filter(p => p.end > from && p.start < to && readable(p.node))
          .map(p => text.slice(Math.max(from, p.start), Math.min(to, p.end))).join("").replace(/\s+/g, " ").trim();
        return { range, element: first.node.parentElement, block, excerpt };
      }
    }
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > 20000 || chars >= 400000) { truncated = true; break; }
      const el = node.parentElement;
      const next = el && !el.closest(excluded) && (!viewportOnly || readable(node)) ? el.closest(blocks) || scope : null;
      if (block !== next) {
        const found = matchPassage();
        if (found) return found;
        block = next; text = ""; parts = [];
      }
      if (!next || !node.length) continue;
      const value = node.data.slice(0, 400000 - chars);
      parts.push({ node, start: text.length, end: text.length + value.length });
      text += value; chars += value.length;
      if (value.length < node.length) { truncated = true; break; }
    }
    return matchPassage() || { truncated, count };
  }
  if (occurrence == null) {
    refs.probe = scope => search(scope, true).excerpt || null;
    return true;
  }
  const found = search(document.body, false);
  if (!found.range) return { ok: true, found: false, matchesSeen: found.count, truncated: found.truncated,
    message: found.truncated ? "Reached the loaded-text search limit. Use scroll_until to search further sections." : "No such occurrence in the rendered text currently loaded. For a feed that loads on scroll, use scroll_until with the same words." };
  if (!exposed(found.range, found.block)) {
    found.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (!exposed(found.range, found.block)) {
      const box = found.range.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= innerHeight) scrollBy({ top: box.top - innerHeight / 2, behavior: "instant" });
    }
  }
  return { ok: true, found: true, occurrence, excerpt: found.excerpt, inViewport: exposed(found.range, found.block),
    message: "Found the passage in the loaded page text. Read the viewport for current controls." };
}
