// Installs text operations on a previously validated binding in the isolated world.
// Selected form text and the clipboard payload never enter a model tool result.
export function installTextSelection(owner) {
  const b = globalThis.__safariChatInput;
  if (!b || b.owner !== owner || b.url !== location.href) throw new Error("Read the page and select the target again.");
  const el = b.element, field = el.matches("input,textarea");
  const editor = field || el.isContentEditable;
  const protectedNodes = "script,style,noscript,textarea,input,select,iframe,object,embed,[inert],[hidden],[aria-hidden=true],#safari-chat-host,#safari-chat-action-pointer";
  const fail = () => { throw new Error("The selection or target changed. Select the intended text again."); };
  const focused = () => document.activeElement === el && el.isConnected;
  const inViewport = r => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
  function restoreFieldFocus() {
    if (!editor || focused() || !document.activeElement?.closest("#safari-chat-host")) return;
    const start = field ? el.selectionStart : null, end = field ? el.selectionEnd : null;
    el.focus({ preventScroll: true });
    if (start != null) el.setSelectionRange(start, end);
  }
  function visible(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(protectedNodes) || (!el.isContentEditable && parent.isContentEditable)) return false;
    if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (getComputedStyle(parent).visibility !== "visible" || !parent.getClientRects().length) return false;
    const rect = document.createRange(); rect.selectNodeContents(node);
    return Array.from(rect.getClientRects()).some(inViewport);
  }
  function indices(value, quote, range, occurrence) {
    if (range) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > value.length) throw new Error("Choose valid start and end offsets inside the target.");
      return [range.start, range.end];
    }
    if (typeof quote !== "string" || !quote) throw new Error("Provide an exact text quote or a start and end offset.");
    let index = value.indexOf(quote);
    if (index >= 0 && occurrence == null && value.indexOf(quote, index + quote.length) >= 0) throw new Error("That text appears more than once. Specify a one-based occurrence.");
    for (let i = 1; i < (occurrence ?? 1) && index >= 0; i++) index = value.indexOf(quote, index + quote.length);
    if (index < 0) throw new Error("The requested text was not found in the target.");
    return [index, index + quote.length];
  }
  function select(quote, offsets, occurrence) {
    if (occurrence != null && (!Number.isInteger(occurrence) || occurrence < 1)) throw new Error("The occurrence must be a positive integer.");
    b.validate();
    if (editor) el.focus({ preventScroll: true });
    if (!quote && !offsets) return capture();
    if (field) {
      if (el.selectionStart == null) throw new Error("This input type does not expose a selectable text range.");
      const [start, end] = indices(el.value, quote, offsets, occurrence);
      if (end - start > 24000) throw new Error("Select at most 24,000 characters at a time.");
      el.setSelectionRange(start, end);
      b.selection = { start, end, value: el.value.slice(start, end) };
      return end - start;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
    let text = "", visited = 0, node;
    while ((node = walker.nextNode()) && ++visited <= 20000 && text.length < 120000) {
      if (!node.length || !visible(node)) continue;
      nodes.push({ node, offset: text.length });
      text += node.data.slice(0, 120000 - text.length);
    }
    const [start, end] = indices(text, quote, offsets, occurrence);
    if (end - start > 24000) throw new Error("Select at most 24,000 characters at a time.");
    const parts = [];
    for (const item of nodes) {
      const a = Math.max(0, start - item.offset), z = Math.min(item.node.length, end - item.offset);
      if (a < z || (start === end && !parts.length && a === z && start >= item.offset)) parts.push({ node: item.node, start: a, end: z, value: item.node.substringData(a, z-a) });
    }
    if (!parts.length) throw new Error("There is no visible text at that position.");
    const range = document.createRange(), first = parts[0], last = parts.at(-1);
    range.setStart(first.node, first.start); range.setEnd(last.node, last.end);
    if (!editor && !Array.from(range.getClientRects()).some(inViewport)) throw new Error("Scroll the intended passage into view first.");
    if (!range.collapsed && range.toString() !== parts.map(p => p.value).join("")) throw new Error("The selection crosses hidden or excluded content. Choose a narrower passage.");
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    b.selection = { parts };
    return end - start;
  }
  function selected() {
    b.validate();
    const sel = b.selection;
    if (!sel) throw new Error("Select the intended text first.");
    if (field) {
      restoreFieldFocus();
      if (!focused() || el.selectionStart !== sel.start || el.selectionEnd !== sel.end || el.value.slice(sel.start, sel.end) !== sel.value) fail();
      return sel.value;
    }
    const selection = getSelection(), parts = sel.parts;
    if (sel.caret) {
      if (!focused() || !selection.isCollapsed || selection.anchorNode !== sel.caret.node || selection.anchorOffset !== sel.caret.offset) fail();
      return "";
    }
    if (!selection.rangeCount || !parts?.length) fail();
    const r = selection.getRangeAt(0), first = parts[0], last = parts.at(-1);
    if (!editor && !Array.from(r.getClientRects()).some(inViewport)) fail();
    if (r.startContainer !== first.node || r.startOffset !== first.start || r.endContainer !== last.node || r.endOffset !== last.end) fail();
    for (const p of parts) if (!el.contains(p.node) || !visible(p.node) || p.node.substringData(p.start, p.end-p.start) !== p.value) fail();
    const value = parts.map(p => p.value).join("");
    if (r.toString() !== value) fail();
    return value;
  }
  function caret() {
    b.validate();
    restoreFieldFocus();
    if (!editor || !focused() || el.readOnly || el.disabled) throw new Error("Click a writable text field or editor first.");
    if (!field) {
      const sel = getSelection();
      if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) fail();
    }
  }
  function capture() {
    if (field) {
      b.validate(); restoreFieldFocus(); if (!focused()) fail();
      const start = el.selectionStart, end = el.selectionEnd;
      if (start == null || end-start > 24000) fail();
      b.selection = { start, end, value: el.value.slice(start,end) };
      return end-start;
    }
    const selection = getSelection();
    if (!selection.rangeCount) fail();
    const r = selection.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) fail();
    if (r.collapsed) {
      if (!editor) throw new Error("Select a nonempty passage on the page first.");
      b.selection = { caret: { node: r.startContainer, offset: r.startOffset } };
      return 0;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), parts = [];
    let node, n = 0, size = 0;
    while ((node = walker.nextNode()) && ++n <= 20000) {
      if (!r.intersectsNode(node) || !visible(node)) continue;
      const start = node === r.startContainer ? r.startOffset : 0, end = node === r.endContainer ? r.endOffset : node.length;
      size += end-start;
      if (size > 24000) throw new Error("Select at most 24,000 characters at a time.");
      parts.push({ node, start, end, value: node.substringData(start,end-start) });
    }
    if (!parts.length || r.toString() !== parts.map(p => p.value).join("")) fail();
    // Select-all in a rich editor can anchor on elements rather than text nodes.
    const first = parts[0], last = parts.at(-1);
    const canonical = document.createRange();
    canonical.setStart(first.node, first.start); canonical.setEnd(last.node,last.end);
    selection.removeAllRanges(); selection.addRange(canonical);
    b.selection = { parts };
    return selected().length;
  }
  function change(value, inputType, selectionRequired = false) {
    b.validate();
    const checkSelection = selectionRequired || !editor || (inputType === "insertFromPaste" && b.selection);
    if (checkSelection && !selected() && (selectionRequired || !editor)) throw new Error("Select a nonempty passage first.");
    if (editor) caret();
    if (field && el.tagName === "INPUT" && /[\r\n]/.test(value)) throw new Error("Use a single line here. Press Enter separately to submit.");
    const target = editor ? el : b.selection.parts[0].node.parentElement;
    if (!target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, data: value || null }))) return false;
    if (checkSelection) selected();
    if (editor) caret();
    if (field) {
      if (el.selectionStart == null) {
        if (!document.execCommand("insertText", false, value)) throw new Error("This input type does not support the requested caret edit.");
        b.selection = null; return true;
      }
      const start = el.selectionStart, end = el.selectionEnd;
      if (el.maxLength >= 0 && value.length > el.maxLength - (el.value.length - (end-start))) return false;
      el.setRangeText(value, start, end, "end");
    } else {
      const selection = getSelection(), range = selection.getRangeAt(0);
      if (!editor) {
        const parts = b.selection.parts;
        for (let i = parts.length-1; i >= 0; i--) {
          const p = parts[i]; p.node.replaceData(p.start, p.end-p.start, i ? "" : value);
        }
        range.setStart(parts[0].node, parts[0].start + value.length);
      } else {
        range.deleteContents();
        const fragment = document.createDocumentFragment();
        value.split("\n").forEach((line, i) => { if (i) fragment.append(document.createElement("br")); if (line) fragment.append(document.createTextNode(line)); });
        const last = fragment.lastChild;
        if (last) { range.insertNode(fragment); range.setStartAfter(last); }
      }
      range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    }
    b.selection = null;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: value || null }));
    return true;
  }
  b.text = { select, selected, caret, capture, change, field, editor };
  return true;
}
