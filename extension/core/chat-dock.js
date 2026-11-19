const storageKey = "chatDocks";
const frameKeys = ["left", "top", "width", "height"];

export function sourceTabId(sender) {
  const value = new URL(sender.url).searchParams.get("tab");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

export class ChatDock {
  constructor(api, panelURL) {
    this.api = api;
    this.panelURL = panelURL;
    this.entries = {};
    this.tail = Promise.resolve();
  }
  load() {
    if (!this.loaded) this.loaded = this.restoreSession().catch(error => { this.loaded = null; throw error; });
    return this.loaded;
  }
  async restoreSession() {
    const store = this.api.storage.session;
    const data = await store.get([storageKey, "chatWindows"]);
    this.entries = data[storageKey] ?? {};
    // Older sessions remembered a detached chat tab. The next toolbar click or
    // source navigation should mount the dock, even if that tab is still open.
    let migrated = false;
    for (const entry of Object.values(this.entries)) {
      if ("tab" in entry) { delete entry.tab; migrated = true; }
    }
    if (migrated) await this.save();
    // A session upgraded from the paired-window build may still own a resize.
    for (const group of data.chatWindows ?? []) {
      const win = await this.api.windows.get(group.windowId).catch(() => null);
      if (win?.state === "normal" && group.applied && group.original &&
          frameKeys.every(key => Number.isFinite(group.original[key]) && Math.abs(win[key] - group.applied[key]) <= 2)) {
        await this.api.windows.update(win.id, group.original);
        if (group.state && group.state !== "normal") await this.api.windows.update(win.id, { state: group.state });
      }
    }
    if (data.chatWindows) await store.remove("chatWindows");
  }
  serial(action) {
    const next = this.tail.then(() => this.load()).then(action);
    this.tail = next.catch(() => {});
    return next;
  }
  save() {
    const store = this.api.storage.session;
    return Object.keys(this.entries).length ? store.set({ [storageKey]: this.entries }) : store.remove(storageKey);
  }
  panelURLMatches(url) { return typeof url === "string" && url.split(/[?#]/)[0] === this.panelURL; }
  async owns(source, token) {
    await this.load();
    return !!token && this.entries[source]?.token === token;
  }
  async trusted(sender, token) {
    if (sender.id !== this.api.runtime.id || !this.panelURLMatches(sender.url)) return false;
    if (!sender.frameId) return !token && (!sender.tab?.url || this.panelURLMatches(sender.tab.url));
    if (typeof token !== "string" || !token) return false;
    const source = sourceTabId(sender);
    if (source === null || source !== sender.tab?.id) return false;
    await this.load();
    return this.entries[source]?.token === token || this.closing?.[source] === token;
  }
  async mount(tab, entry, restore) {
    if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error("Safari protects this page. Open Safari Chat on a website.");
    const url = this.panelURL + "?tab=" + tab.id;
    try { await this.api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/mount.js"] }); }
    catch { throw new Error("Safari could not open the pane here. Check Safari Chat's access to this website and try again."); }
    const reply = await this.api.tabs.sendMessage(tab.id, { type: "panel.show", url, token: entry.token, width: entry.width, restore }, { frameId: 0 }).catch(() => null);
    if (!reply?.ok) throw new Error("Safari could not display the pane on this page. Reload the page and try again.");
  }
  open(tab, { restore = false } = {}) {
    return this.serial(async () => {
      if (this.closed || this.panelURLMatches(tab.url)) return;
      let entry = this.entries[tab.id];
      if (restore && !entry) return;
      if (!entry) {
        entry = this.entries[tab.id] = { token: crypto.randomUUID() };
        await this.save();
      }
      await this.mount(tab, entry, restore);
      return true;
    });
  }
  width(source, token, width) {
    return this.serial(async () => {
      const entry = this.entries[source];
      if (this.closed || !entry || entry.token !== token || (width !== null && (!Number.isInteger(width) || width < 1 || width > 840))) return;
      if (width === null) delete entry.width; else entry.width = width;
      await this.save();
    });
  }
  dismiss(source, token, onDismiss) {
    return this.serial(async () => {
      if (!token || (this.entries[source]?.token !== token && this.closing?.[source] !== token)) return false;
      onDismiss();
      delete this.entries[source];
      if (this.closing) delete this.closing[source];
      await this.save();
      await this.api.tabs.sendMessage(source, { type: "panel.close" }, { frameId: 0 }).catch(() => {});
      return true;
    });
  }
  removed(id) {
    return this.serial(async () => {
      if (this.closing) delete this.closing[id];
      if (this.entries[id]) { delete this.entries[id]; await this.save(); }
    });
  }
  clear() {
    this.closed = true;
    return this.serial(async () => {
      this.closing ??= Object.fromEntries(Object.entries(this.entries).map(([id, entry]) => [id, entry.token]));
      this.entries = {};
      await this.save();
      if ((await this.api.storage.session.get(storageKey))[storageKey]) throw new Error("Safari still contains dock records. Retry cleanup.");
    });
  }
}
