/** Self-contained functions: Safari serializes these into its isolated content-script world. */
export function snapshotPage(limit = 12000) {
  const visible = element => {
    if (!element || element.closest("[hidden],[aria-hidden='true'],[inert],#safari-chat-host")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const root = document.querySelector("main,article,[role='main']") ?? document.body;
  if (!root) throw new Error("This page has no readable content.");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let length = 0;
  let visited = 0;
  let node;
  // Stop traversal as soon as the budget is met; never serialize the whole DOM.
  while ((node = walker.nextNode()) && length < limit && ++visited <= 20000) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,nav,footer,textarea,input,select,[contenteditable],svg") || !visible(parent)) continue;
    const text = node.textContent.slice(0, limit - length + 1).replace(/\s+/g, " ").trim();
    if (text) { chunks.push(text.slice(0, limit - length)); length += text.length + 1; }
  }
  // getRandomValues also works on ordinary HTTP pages; randomUUID requires a secure context.
  const prefix = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const refs = new Map();
  const elements = [];
  for (const element of document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[contenteditable='true']")) {
    if (elements.length >= 60) break;
    if (!visible(element) || element.disabled || element.matches("input[type='hidden'],input[type='password'],input[type='file']")) continue;
    const sensitive = /password|credit.?card|card.?number|\bcvc\b|\bcvv\b|one.?time|\botp\b|secret|token/i;
    if (sensitive.test([element.name, element.id, element.autocomplete, element.getAttribute("aria-label")].join(" "))) continue;
    const label = (element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.labels?.[0]?.innerText || element.name || element.tagName).trim().slice(0, 120);
    const id = `${prefix}-${elements.length + 1}`;
    refs.set(id, { element, label });
    elements.push({ id, tag: element.tagName.toLowerCase(), label });
  }
  globalThis.__safariChatRefs = { url: location.href, refs };
  let selection = getSelection()?.toString() ?? "";
  const anchor = getSelection()?.anchorNode?.parentElement;
  if (anchor?.closest("input,textarea,[contenteditable]")) selection = "";
  return { title: document.title.slice(0, 180), url: location.href, text: chunks.join("\n"), selection: selection.slice(0, limit), truncated: length >= limit || visited > 20000, elements };
}

export function actOnPage(operation, elementId, text, expectedURL) {
  const state = globalThis.__safariChatRefs;
  if (!state || state.url !== location.href || location.href !== expectedURL) throw new Error("The page changed. Read it again before acting.");
  const reference = state.refs.get(elementId);
  const element = reference?.element;
  if (!element?.isConnected || element.disabled || !element.getClientRects().length || element.closest("[hidden],[inert],[aria-hidden='true']")) throw new Error("This element changed or is no longer available. Read the page again.");
  const label = (element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.labels?.[0]?.innerText || element.name || element.tagName).trim().slice(0, 120);
  if (label !== reference.label) throw new Error("The element changed since approval. Read the page again.");
  if (element.matches("input[type='password'],input[type='file'],input[type='hidden']") || /password|credit.?card|card.?number|\bcvc\b|\bcvv\b|one.?time|\botp\b|secret|token/i.test([element.name, element.id, element.autocomplete, element.getAttribute("aria-label")].join(" "))) throw new Error("Enter sensitive information directly in the website.");
  if (operation === "click") {
    const link = element.closest("a[href]");
    if (link && !/^https?:$/.test(new URL(link.href).protocol)) throw new Error("Only ordinary web links can be opened.");
    element.click();
  } else if (operation === "fill") {
    if (typeof text !== "string" || text.length > 12000) throw new Error("Invalid field text.");
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(element, text);
    } else if (element.isContentEditable) element.textContent = text;
    else throw new Error("This element is not an editable field.");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else throw new Error("Unsupported page operation.");
  // Invalidate references after every write, including SPA changes.
  globalThis.__safariChatRefs = null;
  return { ok: true, operation, label };
}
