import { actOnPage } from "../content/page.js";
import { performPageInput } from "../content/direct-input.js";
import { installTextSelection } from "../content/text-selection.js";
import { publicURL } from "./context.js";

export const INPUT_ACTIONS = ["double_click", "type_text", "press_key", "select_text", "copy", "paste", "delete_selection", "replace_selection"];

export class PageInputs {
  constructor(api, clipboard) {
    this.api = api; this.clipboard = clipboard;
    this.owner = crypto.randomUUID();
    this.targets = new Map();
  }

  async inject(tabId, func, args) {
    const [injection] = await this.api.scripting.executeScript({ target: { tabId }, func, args });
    if (injection?.error || !injection?.result) throw new Error(injection?.error?.message || "The input target is unavailable. Read the page again.");
    return injection.result;
  }

  async release() {
    const dispose = owner => { const b = globalThis.__safariChatInput; if (b?.owner === owner) b.dispose(); return true; };
    await Promise.allSettled([...this.targets.keys()].map(id => this.inject(id, dispose, [this.owner])));
    this.targets.clear();
  }

  async execute(args, tabId, url, snapshot, authorize, signal, indicate) {
    const { operation, elementId, text, point, range, occurrence } = args;
    const current = this.targets.get(tabId);
    const clicking = operation === "double_click" || operation === "click";
    const fresh = snapshot?.url === url;
    const pointField = fresh && clicking && point && !elementId && snapshot.elements.find(item => {
      if (!item.actions?.includes("select_text") || !item.bounds) return false;
      const [left, top, right, bottom] = item.bounds;
      return point.x >= left && point.x < right && point.y >= top && point.y < bottom;
    });
    const page = !elementId && !pointField && (operation === "select_text" || clicking && !!point);
    const prior = !page && !clicking && current?.url === url && (!elementId || current.ref?.id === elementId) ? current : null;
    const ref = prior?.ref ?? (fresh && (pointField || snapshot.elements.find(item => item.id === elementId)));
    const selected = !!prior?.selected;
    if (!prior && (!fresh || !page && !ref)) throw new Error("Read the visible page and choose the target first.");
    const editable = !!ref?.actions?.includes("type_text");
    if (["type_text","press_key"].includes(operation) && !editable) throw new Error("Click a writable text field or editor first.");
    if (["copy","delete_selection","replace_selection"].includes(operation) && !selected) throw new Error("Select the intended text first.");
    if (operation === "paste" && !selected && !editable) throw new Error("Select text or click an editable field to paste.");
    if (["type_text","replace_selection","press_key"].includes(operation) && (typeof text !== "string" || text.length > 12000)) throw new Error("Use at most 12,000 characters per input action.");
    if (operation === "type_text" && (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) throw new Error("Type printable text and line breaks. Use press_key for editing keys.");
    if (operation === "select_text" && (page && range || text != null && (typeof text !== "string" || text.length > 24000))) throw new Error("Use an exact quote on the visible page, or offsets within a selected element.");
    if (point && (!clicking || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || fresh && (point.x >= snapshot.viewport?.width || point.y >= snapshot.viewport?.height))) throw new Error("Choose a point inside the visible website.");
    if (!page && operation === "double_click" && !ref?.actions?.includes("double_click")) throw new Error("Select a listed target or give a visible double-click point.");
    const isStatic = !editable && !ref?.actions?.includes("select_text");
    const label = ref?.label ?? (clicking ? "Visible page" : "Visible page text");
    const titles = { click: "Click this element?", double_click: "Double-click this target?", type_text: "Type into this field?", press_key: "Press this key?", select_text: "Select this text?", copy: "Copy this selection to your clipboard?", paste: "Paste your clipboard here?", delete_selection: "Delete this selection?", replace_selection: "Replace this selection?" };
    let detail = publicURL(url) + "\n" + label;
    if (typeof text === "string" && text) detail += "\n" + text;
    if (range) detail += "\nCharacters " + range.start + " to " + range.end;
    if (point) detail += "\nPoint (" + point.x + ", " + point.y + ")";
    if (isStatic && ["delete_selection","replace_selection","paste"].includes(operation)) detail += "\nChanges the displayed page text. Reloading the page can restore it.";
    if (operation === "double_click") detail += "\nSends two clicks to the same target.";
    const hosts = [new URL(url).hostname];
    const destination = clicking ? ref?.destinationHost : operation === "press_key" && text === "Enter" ? ref?.submitHost : null;
    if (destination && destination !== hosts[0]) { hosts.push(destination); detail += "\nDestination: " + destination; }
    if (operation === "press_key" && text === "Enter") detail += "\nEnter can submit a form.";
    const grant = await authorize({ operation, title: titles[operation], detail }, hosts, signal);
    await grant.verify();
    if ((await this.api.tabs.get(tabId)).url !== url) throw new Error("The tab navigated while awaiting approval. Read it again.");
    await grant.verify();
    const target = prior ?? { url, ref: ref || null, selected: false };
    if (!prior) {
      await this.inject(tabId, actOnPage, ["bind_input", ref?.id ?? null, null, url, { inputOwner: this.owner }]);
      this.targets.set(tabId, target);
    }
    const run = (step, payload = {}) => this.inject(tabId, performPageInput, [this.owner, step, payload]);
    if (clicking) {
      const { point: p } = await run("aim_click", { point });
      await indicate({ left: p.x-1, top: p.y-1, right: p.x+1, bottom: p.y+1 }, "aim");
      await grant.verify();
      const first = await run("click", { count: 1, hosts });
      if (operation === "click") return { ...first, message: "Pressed and released the target. Verify the result." };
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await grant.verify();
        const result = await run("click", { count: 2, hosts });
        return { ...result, message: result.doubleClicked ? "Two clicks and a double-click event dispatched. Verify the result." : "Both clicks were sent but the target changed before the double-click event." };
      } catch (error) { signal.throwIfAborted(); return { ok: false, clicks: 1, doubleClicked: false, error: "The first click was confirmed. Check the page before retrying. " + error.message }; }
    }
    await this.inject(tabId, installTextSelection, [this.owner]);
    if (operation === "copy") {
      const selection = await run("copy");
      await grant.verify(); await this.clipboard.write(selection.text);
      if (selection.rect) await indicate(selection.rect, "copy");
      return { ok: true, characters: selection.text.length, message: "Copied the selection to the system clipboard." };
    }
    if (operation === "paste") {
      await run("paste_check"); await grant.verify();
      const value = await this.clipboard.read();
      if (typeof value !== "string" || value.length > 24000) throw new Error("Paste requires plain text of at most 24,000 characters.");
      await grant.verify();
      const result = await run("paste", { text: value }); target.selected = false; return result;
    }
    if (operation === "type_text") {
      const value = text.replace(/\r\n?/g, "\n");
      await run("begin_typing", { text: value }); target.selected = false;
      let typed = 0;
      try {
        const keys = Array.from(value);
        for (let i = 0; i < keys.length; i += 64) {
          await grant.verify();
          const result = await run("type_text", { text: keys.slice(i,i+64).join("") });
          typed += result.typed;
          if (!result.ok) return { ...result, typed };
        }
      } catch (error) { signal.throwIfAborted(); return { ok: false, typed, error: "Typing was interrupted. Check the field before retrying. " + error.message }; }
      finally { await run("end_typing").catch(() => {}); }
      return { ok: true, typed, message: "Typed at the caret." };
    }
    await grant.verify();
    const result = await run(operation, { text, range, occurrence, hosts });
    target.selected = (operation === "select_text" && result.ok) || result.selected > 0;
    return result;
  }
}
