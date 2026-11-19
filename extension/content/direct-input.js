// One injection per click, key command, or small batch of typed characters.
export function performPageInput(owner, step, args = {}) {
  const b = globalThis.__safariChatInput;
  if (!b || b.owner !== owner || b.url !== location.href) throw new Error("The document or input target changed. Read it again.");
  if (step === "end_typing") { b.typing?.abort(); return { ok: true }; }
  b.validate();
  const el = b.element, tools = b.text;
  function verifyDestination(address) {
    if (!address) return;
    const url = new URL(address, location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !args.hosts?.includes(url.hostname)) throw new Error("The destination is unavailable or changed since approval. Read the page again.");
  }
  if (step === "select_text") {
    const count = tools.select(args.text, args.range, args.occurrence);
    return { ok: true, characters: count, message: count ? "Selected the requested text." : "Placed the caret." };
  }
  if (step === "copy") {
    const text = tools.selected();
    if (!text) throw new Error("Select a nonempty passage to copy.");
    const box = tools.field ? el.getBoundingClientRect() : getSelection().getRangeAt(0).getClientRects()[0];
    return { text, ...(box && { rect: { top: box.top, left: box.left, right: box.right, bottom: box.bottom } }) };
  }
  if (step === "paste_check") {
    if (b.selection) tools.selected();
    else {
      tools.caret();
      if (!tools.field || el.selectionStart != null) tools.capture();
    }
    return { ok: true };
  }
  if (step === "paste" || step === "replace_selection" || step === "delete_selection") {
    const value = step === "delete_selection" ? "" : args.text;
    if (step === "paste") {
      if (b.selection) tools.selected(); else tools.caret();
      const transfer = new DataTransfer(); transfer.setData("text/plain", value);
      const target = !tools.editor && b.selection ? b.selection.parts[0].node.parentElement : el;
      if (!target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: transfer }))) return { ok: true, message: "The website handled the paste event. Verify the result." };
    }
    const changed = tools.change(value, step === "paste" ? "insertFromPaste" : step === "delete_selection" ? "deleteContentBackward" : "insertReplacementText", step !== "paste");
    return { ok: changed, message: changed ? (tools.editor ? "Edited the field." : "Changed the text displayed in this document.") : "The website declined the edit." };
  }
  function hit(point) {
    const node = document.elementFromPoint(point.x, point.y);
    if (!node || !el.contains(node) || node.closest("#safari-chat-host,iframe,object,embed,[inert],[hidden],:disabled,[aria-disabled=true],input[type=password],input[type=file]")) return null;
    const field = node.closest("input,textarea,select,[contenteditable]");
    if (field && /password|passcode|credit.?card|debit.?card|card.?number|\bcc[-_]|\bcvc\b|\bcvv\b|security.?code|verification.?code|one.?time|\botp\b|secret|token/i.test([field.name,field.id,field.autocomplete,field.getAttribute("aria-label"),field.getAttribute("placeholder"),field.labels?.[0]?.innerText].join(" "))) return null;
    return node;
  }
  if (step === "aim_click") {
    const rect = el.getBoundingClientRect();
    const right = Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    const point = args.point ?? { x: (Math.max(0, rect.left) + right)/2, y: (Math.max(0, rect.top) + bottom)/2 };
    const target = hit(point);
    if (!target) throw new Error("The double-click point is covered or outside the target. Read it again.");
    b.double = { point, target, count: 0, pointerId: crypto.getRandomValues(new Uint32Array(1))[0] % 1073741824 + 32 };
    return { point };
  }
  if (step === "click") {
    const d = b.double;
    if (!d || args.count !== d.count+1 || hit(d.point) !== d.target) throw new Error("The double-click target changed.");
    verifyDestination(d.target.closest("a[href]")?.href);
    const control = d.target.closest("button,input,textarea,select,[contenteditable],[tabindex]");
    if (control?.form && ["submit","image"].includes(control.type)) verifyDestination(control.hasAttribute("formaction") ? control.formAction : control.form.action);
    const send = (name, held) => {
      const init = { view: window, bubbles: true, cancelable: true, composed: true, button: 0, buttons: held ? 1 : 0, detail: args.count, clientX: d.point.x, clientY: d.point.y };
      return d.target.dispatchEvent(name.startsWith("pointer") ? new PointerEvent(name, { ...init, pointerId: d.pointerId, pointerType: "mouse", isPrimary: true, pressure: held ? 0.5 : 0 }) : new MouseEvent(name, init));
    };
    const mouse = send("pointerdown", true);
    if (mouse && send("mousedown", true) && control) {
      control.focus({ preventScroll: true });
      if (control.isContentEditable) {
        const pos = document.caretPositionFromPoint?.(d.point.x, d.point.y);
        const range = pos ? document.createRange() : document.caretRangeFromPoint?.(d.point.x, d.point.y);
        if (pos) { range.setStart(pos.offsetNode,pos.offset); range.collapse(true); }
        if (range && control.contains(range.startContainer)) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      }
    }
    send("pointerup", false); if (mouse) send("mouseup", false);
    if (hit(d.point) !== d.target) throw new Error("The target changed before the click.");
    d.count++; send("click", false);
    const doubled = d.count === 2 && hit(d.point) === d.target && b.url === location.href;
    if (doubled) send("dblclick", false);
    return { ok: true, clicks: d.count, doubleClicked: doubled };
  }
  tools.caret();
  if (step === "begin_typing") {
    if (el.tagName === "INPUT" && /[\r\n]/.test(args.text)) throw new Error("Type one line in a single-line field. Press Enter separately to submit.");
    b.typing?.abort();
    b.typing = new AbortController(); b.takenOver = false;
    for (const type of ["pointerdown","keydown","beforeinput"]) document.addEventListener(type, e => { if (e.isTrusted) b.takenOver = true; }, { capture: true, signal: b.typing.signal });
    return { ok: true };
  }
  function keyStroke(key, shift, selectAll = false) {
    if (b.takenOver && step === "type_text") throw new Error("Typing stopped after manual input.");
    tools.caret();
    const printable = Array.from(key).length === 1 && !selectAll;
    const code = /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : /^\d$/.test(key) ? "Digit" + key : printable ? "" : key;
    const ctrlKey = selectAll && /^Control\+/i.test(args.text);
    const mods = { key, code, shiftKey: shift, metaKey: selectAll && !ctrlKey, ctrlKey, bubbles: true, composed: true, cancelable: true };
    const send = name => el.dispatchEvent(new KeyboardEvent(name, mods));
    let submitted = false;
    const onSubmit = () => { submitted = true; };
    const submitControl = () => {
      const form = el.form;
      const submit = [...form.elements].find(n => ["submit","image"].includes(n.type) && !n.disabled);
      verifyDestination(submit?.hasAttribute("formaction") ? submit.formAction : form.action);
      return submit;
    };
    if (key === "Enter" && el.tagName === "INPUT" && el.form) submitControl();
    if (key === "Enter") document.addEventListener("submit", onSubmit, true);
    try {
      if (!send("keydown") || (printable || key === "Enter") && !send("keypress")) return false;
      if (submitted || !el.isConnected || b.url !== location.href) return true;
      tools.caret();
      if (printable) return tools.change(key, "insertText");
      if (selectAll) {
        if (tools.field) el.select(); else getSelection().selectAllChildren(el);
      } else if (key === "Enter") {
        if (el.tagName === "INPUT") {
          const form = el.form;
          if (form) {
            const submitter = submitControl();
            if (submitter) submitter.click();
            else if ([...form.elements].filter(node => node.matches("input:not([type]),input:is([type=text],[type=email],[type=url],[type=search],[type=tel],[type=password],[type=number])")).length === 1) form.requestSubmit();
          }
        } else return tools.change("\n", "insertLineBreak");
      } else if (key === "Tab") {
        const items = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable=true],[contenteditable=plaintext-only]")].filter(n => n.tabIndex >= 0 && !n.disabled && !n.closest("[inert],[hidden],#safari-chat-host") && n.getClientRects().length);
        items.sort((a,c) => (a.tabIndex || Infinity) - (c.tabIndex || Infinity));
        const next = items[items.indexOf(el) + (shift ? -1 : 1)];
        if (next) next.focus();
      } else if (key !== "Escape") {
        const deleting = key === "Backspace" || key === "Delete", backward = ["Backspace","ArrowLeft","Home","ArrowUp"].includes(key);
        if (tools.field) {
          let a = el.selectionStart, z = el.selectionEnd;
          if (a == null) throw new Error("This input type does not expose caret positions.");
          if (!deleting || a === z) {
            const anchor = el.selectionDirection === "backward" ? z : a;
            const pos = shift && !deleting ? (anchor === a ? z : a) : backward ? a : z;
            let next = pos;
            const value = el.value, lineStart = pos ? value.lastIndexOf("\n", pos-1)+1 : 0;
            const newline = value.indexOf("\n",pos), lineEnd = newline < 0 ? value.length : newline;
            if (key === "Home") next = lineStart;
            else if (key === "End") next = lineEnd;
            else if (key === "ArrowUp") {
              const previous = lineStart > 1 ? value.lastIndexOf("\n",lineStart-2)+1 : 0;
              next = lineStart ? Math.min(lineStart-1, previous+pos-lineStart) : 0;
            } else if (key === "ArrowDown") {
              const following = value.indexOf("\n",lineEnd+1);
              next = Math.min(following < 0 ? value.length : following, lineEnd+1+pos-lineStart);
            }
            else if (a === z || shift || deleting) next += backward ? -(Array.from(el.value.slice(0,pos)).at(-1)?.length ?? 0) : (Array.from(el.value.slice(pos))[0]?.length ?? 0);
            if (shift || deleting) { a = Math.min(deleting ? pos : anchor, next); z = Math.max(deleting ? pos : anchor, next); }
            else a = z = next;
            el.setSelectionRange(a,z, backward ? "backward" : "forward");
          }
        } else {
          const sel = getSelection(), unit = ["Home","End"].includes(key) ? "lineboundary" : ["ArrowUp","ArrowDown"].includes(key) ? "line" : "character";
          if (!deleting || sel.isCollapsed) sel.modify(deleting || shift ? "extend" : "move", backward ? "backward" : "forward", unit);
          if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) throw new Error("The key would move outside this editor.");
        }
        if (deleting) return tools.change("", backward ? "deleteContentBackward" : "deleteContentForward");
      }
      b.selection = null;
      return true;
    } finally {
      if (key === "Enter") document.removeEventListener("submit", onSubmit, true);
      if (el.isConnected) send("keyup");
    }
  }
  if (step === "type_text") {
    let typed = 0;
    for (const key of args.text) {
      try {
        if (!keyStroke(key === "\n" ? "Enter" : key, false)) return { ok: false, typed, message: "The website declined this key. Check the field before continuing." };
      } catch (error) { return { ok: false, typed, error: error.message }; }
      typed++;
    }
    return { ok: true, typed };
  }
  const selectAll = /^(Meta|Control|Cmd)\+A$/i.test(args.text);
  const shift = args.text.startsWith("Shift+");
  const key = selectAll ? "a" : shift ? args.text.slice(6) : args.text;
  if (!selectAll && !["Enter","Tab","Backspace","Delete","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","Escape"].includes(key) && Array.from(key).length !== 1) throw new Error("Choose a printable key, editing key or supported shortcut.");
  const ok = keyStroke(key, shift, selectAll);
  const selected = ok && (selectAll || shift && key.startsWith("Arrow")) ? tools.capture() : 0;
  return { ok, selected, message: "Key dispatched. Read the page to verify the result." };
}
