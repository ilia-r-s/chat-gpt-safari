// A run can select a tab in its source window. Keep the dock on the source
// and yield the selection if the user has since chosen another tab.
export class TabFocus {
  constructor(api, sourceId) {
    this.api = api;
    this.sourceId = sourceId;
    this.selection = null;
  }

  async show(tabId, url, verify, temporary = false) {
    const tabs = this.api.tabs;
    if (!Number.isInteger(this.sourceId) || typeof tabs.update !== "function") throw new Error("This Safari window does not support switching tabs from chat.");
    const { windowId } = await tabs.get(this.sourceId);
    if (!Number.isInteger(windowId)) throw new Error("Safari could not identify the window containing this chat.");
    await verify();
    const [source, target, activeTabs] = await Promise.all([tabs.get(this.sourceId), tabs.get(tabId), tabs.query?.({ windowId, active: true })]);
    if (source.windowId !== windowId || target.windowId !== windowId) throw new Error("Choose a tab in the same Safari window as this chat.");
    if (target.url !== url) throw new Error("The tab navigated before it could be selected. Read its current page again.");
    if (!target.active) {
      const previous = activeTabs?.[0] ?? (source.active ? source : null);
      const previousId = this.selection?.id === previous?.id && this.selection?.temporary
        ? this.selection.previousId : previous?.id;
      await tabs.update(tabId, { active: true });
      this.selection = { id: tabId, windowId, previousId, temporary };
    } else if (!temporary) this.selection = { id: tabId, windowId, temporary: false };
    await verify();
    const selected = await tabs.get(tabId);
    if (selected.url !== url || selected.windowId !== windowId || !selected.active) throw new Error("The selected tab changed. Read the target tab again before continuing.");
  }

  async returnSelection(forApproval, verify) {
    const selection = this.selection;
    if (!selection || (!forApproval && !selection.temporary)) return;
    this.selection = null;
    const returnId = forApproval ? this.sourceId : selection.previousId;
    if (!Number.isInteger(returnId) || returnId === selection.id) return;
    const tabs = this.api.tabs;
    // The user can switch tabs, close either one, or drag it to another window.
    await verify();
    const [current, previous] = await Promise.all([tabs.get(selection.id), tabs.get(returnId)]).catch(() => []);
    if (current?.active && current.windowId === selection.windowId && previous?.windowId === selection.windowId) {
      await tabs.update(returnId, { active: true }).catch(() => {});
    }
  }
}

// WebKit can acknowledge tabs.update before the document becomes visible.
// Poll from the background since a hidden document's own timers may suspend.
export async function waitForVisiblePage(api, tabId, url, signal) {
  const deadline = Date.now() + 1800;
  do {
    signal.throwIfAborted();
    const [probe] = await api.scripting.executeScript({ target: { tabId }, func: expected =>
      location.href !== expected ? "changed" : document.visibilityState, args: [url] });
    if (probe?.result === "visible") return;
    if (probe?.result !== "hidden") throw new Error("The tab changed while becoming visible. Read the current page again.");
    if (!(await api.tabs.get(tabId)).active) throw new Error("Another tab was selected before the gesture started.");
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("Safari selected the tab, but its document is still hidden. Show the Safari window to perform this motion.");
}
