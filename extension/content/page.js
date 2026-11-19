/** Self-contained functions: Safari serializes these into its isolated content-script world. */
export function snapshotPage(limit = 12000, viewportOnly = false, selectionOnly = false, expectedURL = null, indicateCopy = false, pointerPaths = false) {
  if (expectedURL && location.href !== expectedURL) throw new Error("The tab navigated before it could be read. Choose the page again.");
  const selection = getSelection();
  const editable = node => node?.parentElement?.closest("input,textarea,[contenteditable]");
  const selected = !editable(selection?.anchorNode) && !editable(selection?.focusNode) ? selection?.toString() ?? "" : "";
  const metadata = { title: document.title.slice(0, 180), url: location.href, selection: selected.slice(0, limit) };
  const viewportWidth = Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
  // Return only the visible fragment of text included in this capture.
  let pointerRect;
  function markCopiedText(range) {
    const container = range.commonAncestorContainer;
    const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const rects = range.getClientRects();
    for (let i = 0; i < Math.min(rects.length, 256); i++) {
      const rect = rects[i], left = Math.max(0, rect.left), right = Math.min(viewportWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (left >= right || top >= bottom) continue;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (hit && parent?.contains(hit) && range.intersectsNode(hit)) { pointerRect = { left, right, top, bottom }; return; }
    }
  }
  if (selectionOnly) {
    if (indicateCopy && !document.hidden && selected && selection.rangeCount) markCopiedText(selection.getRangeAt(0));
    return { ...metadata, truncated: selected.length > limit, ...(pointerRect && { pointerRect }) };
  }
  const labelFor = element => {
    const labelled = (element.getAttribute("aria-labelledby") || "").split(/\s+/).slice(0, 8).map(id => document.getElementById(id)?.textContent?.slice(0, 120) || "").join(" ").trim();
    const field = element.matches("input,textarea,select") || element.isContentEditable;
    return (element.getAttribute("aria-label") || labelled || element.labels?.[0]?.innerText || element.getAttribute("placeholder") || (!field && element.innerText) || element.name || element.tagName).trim().slice(0, 120);
  };
  const sensitive = /password|passcode|credit.?card|debit.?card|card.?number|\bcc[-_](number|csc|exp|name)|\bcvc\b|\bcvv\b|security.?code|verification.?code|one.?time|\botp\b|secret|token/i;
  const signature = (element, ignoreSelection = false) => JSON.stringify([element.tagName, element.type, element.name, element.getAttribute("role"), element.getAttribute("href"), element.closest("a[href]")?.href, element.getAttribute("target"), element.getAttribute("download"), element.form?.action, element.form?.method, element.getAttribute("formaction"), element.formAction, element.getAttribute("aria-controls"), ignoreSelection ? null : element.getAttribute("aria-selected"), element.getAttribute("aria-orientation")]);
  const scrollDirections = element => {
    const style = getComputedStyle(element);
    return [
      ...(/^(auto|scroll|hidden)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1 ? ["left", "right"] : []),
      ...(/^(auto|scroll|hidden)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1 ? ["up", "down", "top", "bottom"] : []),
    ];
  };
  const scrollAreas = new Set();
  const checkedAreas = new Set();
  const trackScrollAreas = element => {
    for (let parent = element, depth = 0; parent && depth < 8 && checkedAreas.size < 500; parent = parent.parentElement, depth++) {
      if (checkedAreas.has(parent)) break;
      checkedAreas.add(parent);
      if (parent === document.scrollingElement || (parent === document.body && !Number.isFinite(globalThis.__safariChatPageRight))) continue;
      if (scrollDirections(parent).length) {
        if (scrollAreas.size < 10) scrollAreas.add(parent);
      }
    }
  };
  const visible = element => {
    if (!element || element.closest("[hidden],[aria-hidden='true'],[inert],#safari-chat-host")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0" || !element.getClientRects().length) return false;
    const rect = element.getBoundingClientRect();
    if (viewportOnly && (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= viewportWidth)) return false;
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (++depth > 64) return false;
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.opacity === "0") return false;
      if (!viewportOnly || parent === document.body || parent === document.documentElement) continue;
      const clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY) && (rect.bottom <= clip.top || rect.top >= clip.bottom)) return false;
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX) && (rect.right <= clip.left || rect.left >= clip.right)) return false;
    }
    return true;
  };
  // Action reads include navigation and dialogs; attachments prefer the article's text.
  const root = viewportOnly ? document.body : document.querySelector("main,article,[role='main']") ?? document.body;
  if (!root) throw new Error("This page has no readable content.");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let length = 0;
  let captionsTrimmed = false;
  // Include one already-displayed caption track when explicitly sharing a video page.
  if (!viewportOnly) {
    const video = Array.prototype.slice.call(root.getElementsByTagName("video"), 0, 8).find(visible);
    const track = video && Array.prototype.slice.call(video.textTracks, 0, 20).find(t => t.mode === "showing" && ["captions", "subtitles"].includes(t.kind) && t.cues?.length);
    if (track) {
      const budget = Math.floor(limit / 2), cues = track.cues;
      chunks.push("Video captions"); length = chunks[0].length + 1;
      for (let i = 0; i < cues.length; i++) {
        if (i >= 500 || length >= budget) { captionsTrimmed = true; break; }
        const cue = cues[i];
        if (typeof cue.text !== "string" || !Number.isFinite(cue.startTime)) continue;
        const seconds = Math.max(0, Math.floor(cue.startTime));
        const line = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " " + cue.text.slice(0, budget).replace(/\s+/g, " ").trim();
        const part = line.slice(0, budget - length);
        captionsTrimmed ||= part !== line || cue.text.length > budget;
        chunks.push(part); length += part.length + 1;
      }
    }
  }
  let visited = 0;
  let pointerCandidates = indicateCopy && !document.hidden ? 32 : 0;
  let node;
  while ((node = walker.nextNode()) && length < limit && ++visited <= 20000) {
    const parent = node.parentElement;
    const excluded = viewportOnly ? "script,style,noscript,textarea,input,select,[contenteditable],svg" : "script,style,noscript,nav,footer,textarea,input,select,[contenteditable],svg";
    if (!parent || parent.closest(excluded) || !visible(parent)) continue;
    if (viewportOnly) trackScrollAreas(parent);
    const source = node.data.slice(0, limit - length + 1);
    const text = source.replace(/\s+/g, " ").trim();
    if (text) {
      if (pointerCandidates && !pointerRect) {
        const box = parent.getBoundingClientRect();
        if (box.right > 0 && box.left < viewportWidth && box.bottom > 0 && box.top < innerHeight) {
          pointerCandidates--;
          const range = document.createRange(), start = source.search(/\S/);
          range.setStart(node, start);
          range.setEnd(node, start + Math.min(text.length, limit - length, 80));
          markCopiedText(range);
        }
      }
      chunks.push(text.slice(0, limit - length)); length += text.length + 1;
    }
  }
  const excerpt = { ...metadata, text: chunks.join("\n"), truncated: captionsTrimmed || length >= limit || visited > 20000, ...(pointerRect && { pointerRect }) };
  if (!viewportOnly) return excerpt;
  // getRandomValues also works on ordinary HTTP pages; randomUUID requires a secure context.
  const prefix = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const refs = new Map();
  const elements = [];
  let elementChars = 0;
  let elementsTruncated = false;
  const add = (element, label, properties, budget = 4300, extra = {}) => {
    const id = `${prefix}-${elements.length + 1}`;
    const entry = { id, tag: element.tagName.toLowerCase(), label, ...properties };
    if (pointerPaths) {
      const rect = element.getBoundingClientRect();
      entry.bounds = [Math.max(0, rect.left), Math.max(0, rect.top), Math.min(viewportWidth, rect.right), Math.min(innerHeight, rect.bottom)].map(Math.round);
    }
    const size = JSON.stringify(entry).length;
    if (elementChars + size > budget) { elementsTruncated = true; return; }
    elementChars += size;
    refs.set(id, { element, label: labelFor(element), signature: signature(element), ...extra });
    elements.push(entry);
  };
  // Transform-based carousels are moved through their own tab controls, never
  // by changing page styles or guessing at a product link / "Next" button.
  const galleries = [];
  let tablists = 0;
  for (const list of document.querySelectorAll("[role='tablist']")) {
    if (++tablists > 40 || galleries.length >= 4) break;
    if (!visible(list)) continue;
    const tabs = [...list.querySelectorAll("[role='tab']")];
    if (tabs.length < 2 || tabs.length > 40 || tabs.some(tab => tab.closest("[role='tablist']") !== list)) continue;
    const controls = tabs.map(tab => tab.getAttribute("aria-controls"));
    if (controls.some(id => !id || /\s/.test(id) || id.length > 256) || new Set(controls).size !== tabs.length) continue;
    const safeTab = tab => {
      if (tab.matches(":disabled,[aria-disabled='true']") || tab.closest("form") || tab.form) return false;
      if (tab.matches("a[href]")) {
        const url = new URL(tab.href, location.href), here = new URL(location.href);
        let panel;
        try { panel = decodeURIComponent(url.hash.slice(1)); } catch { return false; }
        return url.origin === here.origin && url.pathname === here.pathname && url.search === here.search && panel === tab.getAttribute("aria-controls") && !tab.hasAttribute("download") && !tab.target;
      }
      return tab.matches("button,[role='tab']:not(a):not(input)");
    };
    if (!tabs.every(safeTab)) continue;
    const selected = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
    if (selected < 0 || tabs.filter(tab => tab.getAttribute("aria-selected") === "true").length !== 1) continue;
    let scope = list.parentElement, panels;
    for (let depth = 0; scope && depth < 6 && scope !== document.body; scope = scope.parentElement, depth++) {
      if (!/(^|[\s_-])(gallery|carousel|slideshow)([\s_-]|$)/i.test(`${scope.id} ${scope.getAttribute("class")} ${scope.getAttribute("aria-roledescription")}`)) continue;
      const candidates = [...scope.querySelectorAll("[role='tabpanel'][id]")].slice(0, 80);
      panels = controls.map(id => candidates.find(panel => panel.id === id));
      if (panels.every(Boolean)) break;
      panels = null;
    }
    if (!panels || !scope || scope === document.body) continue;
    const orientation = list.getAttribute("aria-orientation") === "vertical" ? "vertical" : "horizontal";
    const label = (scope.getAttribute("aria-label") || scope.querySelector("h1,h2,h3,[role='heading']")?.textContent || "Gallery").trim().slice(0, 100);
    const gallery = { scope, panels, orientation, label, rtl: getComputedStyle(list).direction === "rtl", tabs: tabs.map(tab => ({ element: tab, label: labelFor(tab), signature: signature(tab, true) })) };
    galleries.push(gallery);
    add(list, `${label} navigation`, { actions: ["scroll"], kind: "carousel", directions: orientation === "vertical" ? ["up", "down"] : ["left", "right"], currentItem: selected + 1, itemCount: tabs.length }, 1500, { gallery });
  }
  let examined = 0;
  const controls = "a[href],button,input,textarea,select,[role='button'],[role='tab'],[role='checkbox'],[role='radio'],[role='combobox'],[role='option'],[contenteditable='true'],[contenteditable='plaintext-only']";
  const dragTargets = "canvas,[draggable='true'],[role='slider'],[role='application'],[data-drag-handle]";
  const doubleTargets = "[ondblclick],[role=row],[role=gridcell],[role=treeitem],[role=listitem]";
  const candidates = pointerPaths ? controls + "," + dragTargets + "," + doubleTargets + ",[style*='cursor' i],[class*='handle' i],[class*='dragg' i]" : controls;
  for (const element of document.querySelectorAll(candidates)) {
    if (elements.length >= 50 || ++examined > 5000) { elementsTruncated = true; break; }
    if (!visible(element) || element.matches(":disabled,[aria-disabled='true'],input[type='hidden'],input[type='password'],input[type='file']")) continue;
    const label = labelFor(element);
    if (sensitive.test([label, element.name, element.id, element.autocomplete, element.getAttribute("placeholder")].join(" "))) continue;
    trackScrollAreas(element);
    const actions = element.matches(controls) ? ["click"] : [];
    if (pointerPaths && (element.matches(dragTargets + ",input[type='range']") || /^(grab|grabbing|move|crosshair|[nesw]+-resize)$/.test(getComputedStyle(element).cursor))) actions.push("drag");
    if (pointerPaths && (actions.length || element.matches(doubleTargets))) actions.push("double_click");
    if (!actions.length) continue;
    if (element.matches("input[type='checkbox'],input[type='radio']")) actions.push("set_checked");
    else if (element instanceof HTMLSelectElement) { if (!element.multiple) actions.push("select"); }
    else if (!element.readOnly && (element.matches("input:not([type='button']):not([type='submit']):not([type='reset']):not([type='image']),textarea") || element.isContentEditable)) actions.push("fill");
    const edit = element.matches("textarea,input:not([type]),input:is([type=text],[type=search],[type=url],[type=tel],[type=email])") || element.isContentEditable;
    if (pointerPaths && edit) {
      actions.push("select_text");
      if (!element.readOnly) actions.push("type_text", "press_key");
    }
    let options;
    if (element instanceof HTMLSelectElement) {
      options = [];
      for (const option of element.options) {
        const item = { value: option.value.slice(0, 120), label: option.label.slice(0, 120), disabled: option.disabled || !!option.closest("optgroup[disabled]") };
        if (options.length >= 30 || JSON.stringify([...options, item]).length > 800) break;
        options.push(item);
      }
    }
    const destination = element.closest("a[href]")?.href || (["submit", "image"].includes(element.type) && element.form
      ? (element.hasAttribute("formaction") ? element.formAction : element.form.action) : null);
    let destinationHost;
    if (destination && URL.canParse(destination)) {
      const target = new URL(destination);
      if (target.hostname && target.hostname !== location.hostname) destinationHost = target.hostname;
    }
    const fieldInfo = {};
    if (pointerPaths && edit) {
      fieldInfo.focused = document.activeElement === element;
      if (element.form) {
        const submit = Array.from(element.form.elements).find(node => ["submit", "image"].includes(node.type) && !node.disabled);
        const action = submit?.hasAttribute("formaction") ? submit.formAction : element.form.action;
        if (URL.canParse(action)) fieldInfo.submitHost = new URL(action).hostname;
      }
    }
    add(element, label, { actions, ...fieldInfo, ...(destinationHost ? { destinationHost } : {}), ...(element.getAttribute("role") === "tab" ? { role: "tab", selected: element.getAttribute("aria-selected") === "true" } : {}), ...(element.type ? { type: element.type } : {}), ...(element.required ? { required: true } : {}), ...(options ? { options, optionsTruncated: element.options.length > options.length } : {}) });
  }
  // Image-only strips have no text or clickable descendants to discover them.
  let media = 0;
  for (const element of root.querySelectorAll("img,canvas,video,[role='region'],[role='group']")) {
    if (++media > 300 || checkedAreas.size >= 500) break;
    if (visible(element)) trackScrollAreas(element);
  }
  for (const area of scrollAreas) {
    if (!visible(area) || galleries.some(gallery => gallery.scope.contains(area) && getComputedStyle(area).overflowX === "hidden")) continue;
    add(area, labelFor(area), { actions: ["scroll"], directions: scrollDirections(area), scrollTop: Math.round(area.scrollTop), scrollLeft: Math.round(area.scrollLeft) }, 5000);
  }
  globalThis.__safariChatRefs = { url: location.href, refs, viewport: { width: viewportWidth, height: innerHeight, x: scrollX, y: scrollY } };
  const page = document.scrollingElement ?? document.documentElement;
  return {
    ...excerpt, elements, elementsTruncated,
    viewport: { width: viewportWidth, height: innerHeight, scrollX: Math.round(page.scrollLeft), scrollY: Math.round(page.scrollTop), pageWidth: page.scrollWidth, pageHeight: page.scrollHeight },
    viewportOnly,
  };
}

export function actOnPage(operation, elementId, text, expectedURL, { direction, checked, preview = false, motionId, speed, path, speedChanges, inputOwner } = {}) {
  const state = globalThis.__safariChatRefs;
  if (!state || state.url !== location.href || location.href !== expectedURL) throw new Error("The page changed. Read it again before acting.");
  const labelFor = element => {
    const labelled = (element.getAttribute("aria-labelledby") || "").split(/\s+/).slice(0, 8).map(id => document.getElementById(id)?.textContent?.slice(0, 120) || "").join(" ").trim();
    const field = element.matches("input,textarea,select") || element.isContentEditable;
    return (element.getAttribute("aria-label") || labelled || element.labels?.[0]?.innerText || element.getAttribute("placeholder") || (!field && element.innerText) || element.name || element.tagName).trim().slice(0, 120);
  };
  const signature = (element, ignoreSelection = false) => JSON.stringify([element.tagName, element.type, element.name, element.getAttribute("role"), element.getAttribute("href"), element.closest("a[href]")?.href, element.getAttribute("target"), element.getAttribute("download"), element.form?.action, element.form?.method, element.getAttribute("formaction"), element.formAction, element.getAttribute("aria-controls"), ignoreSelection ? null : element.getAttribute("aria-selected"), element.getAttribute("aria-orientation")]);
  const reference = state.refs.get(elementId);
  const freePointer = operation === "move_pointer" && !elementId;
  const element = freePointer ? document.documentElement : reference?.element;
  const pageScroll = operation === "scroll" && !elementId;
  let label = "Page";
  const pageInput = operation === "bind_input" && !elementId;
  function validate() {
    if (location.href !== expectedURL) throw new Error("The page changed. Read it again.");
    if (pageScroll || pageInput || freePointer) return;
    if (!element?.isConnected || element.matches(":disabled,[aria-disabled='true']") || !element.getClientRects().length || element.closest("[hidden],[inert],[aria-hidden='true'],#safari-chat-host")) throw new Error("This element changed or is no longer available. Read the page again.");
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.opacity === "0") throw new Error("This element is no longer visible. Read the page again.");
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (++depth > 64 || getComputedStyle(parent).opacity === "0") throw new Error("This element is no longer visible. Read the page again.");
    }
    label = labelFor(element);
    if (label !== reference.label || signature(element) !== reference.signature) throw new Error("The element changed since approval. Read the page again.");
    if (element.matches("input[type='password'],input[type='file'],input[type='hidden']") || /password|passcode|credit.?card|debit.?card|card.?number|\bcc[-_](number|csc|exp|name)|\bcvc\b|\bcvv\b|security.?code|verification.?code|one.?time|\botp\b|secret|token/i.test([label, element.name, element.id, element.autocomplete, element.getAttribute("placeholder")].join(" "))) throw new Error("Enter sensitive information directly in the website.");
  }
  validate();
  function bindInput() {
    const prior = globalThis.__safariChatInput;
    prior?.dispose();
    const node = pageInput ? document.body : element;
    const binding = { owner: inputOwner, element: node, url: expectedURL, validate, page: pageInput,
      dispose() {
        clearTimeout(binding.timer);
        binding.typing?.abort();
        if (globalThis.__safariChatInput === binding) delete globalThis.__safariChatInput;
      },
    };
    binding.timer = setTimeout(binding.dispose, 300000);
    globalThis.__safariChatInput = binding;
  }
  if (operation === "bind_input") {
    bindInput();
    globalThis.__safariChatRefs = null;
    return { ok: true, label };
  }
  // A preview resolves the same validated target, but leaves the real action single-use.
  if (preview && (document.hidden || !(operation === "click" || operation === "set_checked" || reference?.gallery && operation === "scroll"))) return {};
  if (!preview) globalThis.__safariChatRefs = null;
  if (operation === "drag" || operation === "move_pointer") {
    const motion = globalThis.__safariChatStartPath(motionId, element, operation, path, speed, state.viewport);
    return { ok: true, operation, label, motion };
  }
  function click(target) {
    if (preview) {
      state.pointerTarget = { id: elementId, element: target };
      return;
    }
    state.showPointer?.(expectedURL, target, "press");
    target.click();
  }
  if (operation === "scroll") {
    if (!["up", "down", "left", "right", "top", "bottom"].includes(direction)) throw new Error("Choose a valid scroll direction.");
    const gallery = reference?.gallery;
    if (gallery) {
      const { tabs, orientation, rtl, panels, scope } = gallery;
      const currentTabs = [...element.querySelectorAll("[role='tab']")];
      const currentLabel = (scope.getAttribute("aria-label") || scope.querySelector("h1,h2,h3,[role='heading']")?.textContent || "Gallery").trim().slice(0, 100);
      const changedTab = tabs.some((tab, i) => currentTabs[i] !== tab.element || signature(tab.element, true) !== tab.signature || labelFor(tab.element) !== tab.label || tab.element.closest("form") || tab.element.form || !panels[i].isConnected || !scope.contains(panels[i]) || panels[i].id !== tab.element.getAttribute("aria-controls"));
      if (!scope.isConnected || !scope.contains(element) || currentLabel !== gallery.label || tabs.length !== currentTabs.length || changedTab || (getComputedStyle(element).direction === "rtl") !== rtl) throw new Error("The gallery changed since approval. Read the page again.");
      const forward = orientation === "vertical" ? "down" : rtl ? "left" : "right";
      const backward = orientation === "vertical" ? "up" : rtl ? "right" : "left";
      if (![forward, backward].includes(direction)) throw new Error("Use one of this gallery's listed scroll directions.");
      // Approval is for a direction within this gallery, not a fixed slide.
      // Autoplay may advance while the user reviews it; use the live selection
      // after checking the gallery structure and every navigation destination.
      const selected = tabs.findIndex(tab => tab.element.getAttribute("aria-selected") === "true");
      if (selected < 0 || tabs.filter(tab => tab.element.getAttribute("aria-selected") === "true").length !== 1) throw new Error("The gallery selection is unavailable. Read the page again.");
      const next = selected + (direction === forward ? 1 : -1);
      if (next < 0 || next >= tabs.length) return { ok: true, operation, moved: false, message: "This gallery is at its first or last item. Scroll in the other direction." };
      const control = tabs[next].element;
      const rect = control.getBoundingClientRect();
      if (control.matches(":disabled,[aria-disabled='true']") || control.closest("[hidden],[inert],[aria-hidden='true'],#safari-chat-host") || !control.getClientRects().length || rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth) || getComputedStyle(control).visibility !== "visible") throw new Error("The next gallery control is not available. Read the page again.");
      let depth = 0;
      for (let parent = control; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (++depth > 64 || style.opacity === "0" || (/auto|scroll|hidden|clip/.test(style.overflowX) && (rect.right <= clip.left || rect.left >= clip.right)) || (/auto|scroll|hidden|clip/.test(style.overflowY) && (rect.bottom <= clip.top || rect.top >= clip.bottom))) throw new Error("The next gallery control is not visible. Read the page again.");
      }
      click(control);
      if (preview) return { pointer: true };
      return { ok: true, operation, dispatched: true, fromItem: selected + 1, requestedItem: next + 1, message: "Gallery navigation activated. Read the page again to verify the newly visible cards." };
    }
    const target = pageScroll ? document.scrollingElement ?? document.documentElement : element;
    const axis = ["left", "right"].includes(direction) ? "overflowX" : "overflowY";
    if (!pageScroll && !/^(auto|scroll|hidden)$/.test(getComputedStyle(target)[axis])) throw new Error("This area cannot scroll in that direction. Use its listed directions or gallery controls.");
    if (motionId) {
      const motion = globalThis.__safariChatStartScroll(target, motionId, direction, speed, speedChanges ?? []);
      return { ok: true, operation, label, motion };
    }
    const before = { x: target.scrollLeft, y: target.scrollTop };
    let top = before.y, left = before.x;
    const height = pageScroll ? innerHeight : target.clientHeight;
    const width = pageScroll ? Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth) : target.clientWidth;
    if (direction === "up") top -= Math.max(1, Math.round(height * 0.8));
    if (direction === "down") top += Math.max(1, Math.round(height * 0.8));
    if (direction === "left") left -= Math.max(1, Math.round(width * 0.8));
    if (direction === "right") left += Math.max(1, Math.round(width * 0.8));
    if (direction === "top") top = 0;
    if (direction === "bottom") top = target.scrollHeight;
    target.scrollTo({ top, left, behavior: "instant" });
    const moved = target.scrollLeft !== before.x || target.scrollTop !== before.y;
    return { ok: true, operation, label, moved, scrollX: Math.round(target.scrollLeft), scrollY: Math.round(target.scrollTop), message: moved ? "Scrolled. Read the visible page again before the next action." : "No movement; this area is at its scroll boundary." };
  }
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  if (operation === "click") {
    const destination = element.closest("a[href]")?.href || (["submit", "image"].includes(element.type) && element.form
      ? (element.hasAttribute("formaction") ? element.formAction : element.form.action) : null);
    if (destination) {
      const url = new URL(destination);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only ordinary web links can be opened.");
    }
    const editable = element.matches("textarea,input:not([type]),input:is([type=text],[type=search],[type=url],[type=tel],[type=email])") || element.isContentEditable;
    if (!preview && editable) element.focus({ preventScroll: true });
    click(element);
    if (preview) return { pointer: true };
    const focused = editable && document.activeElement === element;
    if (inputOwner && focused) bindInput();
    return { ok: true, operation, label, focused, message: "Click dispatched. Read the page again to verify the outcome." };
  }
  if (operation === "set_checked") {
    if (!element.matches("input[type='checkbox'],input[type='radio']") || typeof checked !== "boolean") throw new Error("Choose a checkbox or radio button and a boolean checked state.");
    if (element.type === "radio" && !checked) throw new Error("Select another radio option instead of unchecking this one.");
    if (element.checked !== checked) {
      click(element);
      if (preview) return { pointer: true };
    }
    if (element.checked !== checked) throw new Error("The page did not keep the requested checked state. Read it again.");
    return { ok: true, operation, label, checked: element.checked };
  }
  if (operation === "select") {
    if (!(element instanceof HTMLSelectElement) || element.multiple) throw new Error("Choose a single-choice dropdown. Use clicks for custom controls.");
    if (typeof text !== "string" || text.length > 12000) throw new Error("Invalid option text.");
    const options = [...element.options];
    const byValue = options.filter(option => option.value === text);
    const matches = byValue.length ? byValue : options.filter(option => option.label === text);
    if (matches.length !== 1 || matches[0].disabled || matches[0].closest("optgroup[disabled]")) throw new Error("Choose one enabled option by its exact value or unique label.");
    const option = matches[0];
    element.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, option.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (element.value !== option.value) throw new Error("The page did not keep the selected option. Read it again.");
    return { ok: true, operation, label, message: "Option selected; the form was not submitted." };
  }
  if (operation !== "fill") throw new Error("Unsupported page operation.");
  if (typeof text !== "string" || text.length > 12000) throw new Error("Invalid field text.");
  if (element.readOnly) throw new Error("This field is read-only.");
  if (element instanceof HTMLSelectElement) throw new Error("Use select to choose a dropdown option.");
  if (element instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset", "image"].includes(element.type)) throw new Error("Use click or set_checked for this control.");
  element.focus({ preventScroll: true });
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
  } else if (element.isContentEditable) element.textContent = text;
  else throw new Error("This element is not an editable field.");
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  if ((element.isContentEditable ? element.textContent : element.value) !== text) throw new Error("The page did not keep the entered text. Read it again.");
  return { ok: true, operation, label, message: "Text entered; the form was not submitted." };
}
