import { snapshotPage, actOnPage } from "../content/page.js";
import { publicURL, safeWebURL } from "./context.js";

function scriptResult(results, fallback) {
  const injection = results?.[0];
  if (injection?.error != null) {
    const error = injection.error;
    const detail = typeof error === "string" ? error : error?.message;
    throw new Error(typeof detail === "string" && detail.trim() ? detail.slice(0, 700) : fallback);
  }
  if (!injection?.result) throw new Error(fallback);
  return injection.result;
}

export async function readTab(api, tabId, limit, viewportOnly = false) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Select a Safari tab first.");
  const tab = await api.tabs.get(tabId);
  if (tab.url && !safeWebURL(tab.url)) throw new Error("Safari protects this page. Open an ordinary website to attach it.");
  const results = await api.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [limit, viewportOnly] });
  return scriptResult(results, "Could not read this page. Allow the extension on this website in Safari.");
}

export async function readyTab(api, tabId, signal) {
  signal.throwIfAborted();
  const tab = await api.tabs.get(tabId);
  signal.throwIfAborted();
  if (tab.status !== "loading" || !api.tabs.onUpdated) return tab;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); api.tabs.onUpdated.removeListener(updated); api.tabs.onRemoved?.removeListener(removed); signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve(value);
    };
    const updated = (id, change, value) => { if (id === tabId && change.status === "complete") finish(null, value); };
    const removed = id => { if (id === tabId) finish(new Error("The tab was closed while loading.")); };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("The page is still loading. Wait for it to finish, then try again.")), 10000);
    api.tabs.onUpdated.addListener(updated); api.tabs.onRemoved?.addListener(removed); signal.addEventListener("abort", aborted, { once: true });
    // Recheck after subscribing so a completion between get() and addListener() is not lost.
    api.tabs.get(tabId).then(value => { if (value.status !== "loading") finish(null, value); }, error => finish(error));
    if (signal.aborted) aborted();
  });
}

export function createBrowserTools({ api, pageChars, approve, initialTabs = [], defaultTabId = null, protectedTabId = null }) {
  const readableTabs = new Map(initialTabs.filter(tab => Number.isInteger(tab.id) && safeWebURL(tab.url)).map(tab => [tab.id, new URL(tab.url).origin]));
  const snapshots = new Map();
  return async function execute(args, signal) {
    const { operation, tabId: requestedTab, elementId, url, text, direction, checked } = args ?? {};
    const tabId = requestedTab ?? defaultTabId;
    if (!["read", "click", "fill", "select", "set_checked", "scroll", "navigate", "open_tab", "close_tab", "list_tabs"].includes(operation)) throw new Error("Unknown browser action.");
    signal.throwIfAborted();
    if (operation === "list_tabs") {
      await approve({ operation, title: "Share your open tabs?", detail: "This shares titles and website addresses of accessible tabs for this request." }, signal);
      signal.throwIfAborted();
      const tabs = await api.tabs.query({ currentWindow: true });
      return tabs.filter(tab => safeWebURL(tab.url)).slice(0, 40).map(tab => ({ tabId: tab.id, title: (tab.title ?? "Untitled").slice(0, 160), url: publicURL(tab.url) }));
    }
    if (operation === "open_tab") {
      const target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS URLs without credentials are allowed.");
      await approve({ operation, title: "Open a new tab?", detail: target }, signal);
      signal.throwIfAborted();
      const tab = await api.tabs.create({ url: target, active: false });
      return { ok: true, tabId: tab.id, url: publicURL(target), message: "Tab opened. Read it to continue; Safari may require website access first." };
    }
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("A valid tab ID is required.");
    if (["navigate", "close_tab"].includes(operation) && tabId === protectedTabId) throw new Error("This tab contains the chat panel. Open chat in its own tab before navigating or closing this page.");
    const tab = operation === "read" ? await readyTab(api, tabId, signal) : await api.tabs.get(tabId);
    const currentURL = safeWebURL(tab.url);
    if (!currentURL) throw new Error("Safari has not granted access to this tab. Open the extension on that website first.");
    if (operation === "read") {
      const origin = new URL(currentURL).origin;
      if (readableTabs.get(tabId) !== origin) {
        await approve({ operation, title: "Read this page?", detail: publicURL(currentURL) }, signal);
        readableTabs.set(tabId, origin);
      }
      signal.throwIfAborted();
      const page = await readTab(api, tabId, pageChars, true);
      signal.throwIfAborted();
      if (new URL(page.url).origin !== origin) throw new Error("The tab changed websites while reading. Request permission for the new page.");
      snapshots.set(tabId, { url: page.url, elements: page.elements });
      return { ...page, url: publicURL(page.url), tabId };
    }
    const snapshot = snapshots.get(tabId);
    let detail;
    let target;
    let galleryScroll = false;
    if (operation === "navigate") {
      target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS navigation is supported.");
      detail = `${publicURL(currentURL)} \u2192 ${target}`;
    } else if (operation === "close_tab") detail = `${tab.title ?? "Tab"}\n${publicURL(currentURL)}\nUnsaved work in this tab may be lost.`;
    else {
      if (operation === "scroll" && !["up", "down", "left", "right", "top", "bottom"].includes(direction)) throw new Error("Choose a valid scroll direction.");
      if (operation === "set_checked" && typeof checked !== "boolean") throw new Error("Choose a boolean checked state.");
      if (["fill", "select"].includes(operation) && (typeof text !== "string" || text.length > 12000)) throw new Error("Invalid field text.");
      if (!snapshot || snapshot.url !== currentURL) throw new Error("Read the current page before acting on an element.");
      const ref = snapshot?.elements.find(element => element.id === elementId);
      if (!(operation === "scroll" && !elementId) && !ref) throw new Error("Read the current page before acting on an element.");
      if (ref?.actions && !ref.actions.includes(operation)) throw new Error("This control does not support that action. Read the page and use one of its listed actions.");
      if (operation === "scroll" && ref?.directions && !ref.directions.includes(direction)) throw new Error("Use one of this area's listed scroll directions.");
      galleryScroll = operation === "scroll" && ref?.kind === "carousel";
      detail = `${publicURL(currentURL)}\n${ref?.label ?? "Page"}${["fill", "select"].includes(operation) ? `\n${text}` : ""}${operation === "scroll" ? `\n${galleryScroll ? "Advance gallery" : "Scroll"} ${direction}` : ""}${operation === "set_checked" ? `\n${checked ? "Check" : "Uncheck"}` : ""}`;
    }
    await approve({ operation, title: galleryScroll ? "Move this gallery?" : { click: "Click this element?", fill: "Enter this text?", select: "Choose this option?", set_checked: "Change this checkbox or radio option?", scroll: "Scroll this page or area?", navigate: "Navigate this tab?", close_tab: "Close this tab?" }[operation], detail }, signal);
    signal.throwIfAborted();
    // The user may navigate while an approval is visible; reject stale permission.
    const now = await api.tabs.get(tabId);
    signal.throwIfAborted();
    if (now.url !== currentURL) throw new Error("The tab navigated while awaiting approval. Read it again.");
    snapshots.delete(tabId);
    if (operation === "navigate") { readableTabs.delete(tabId); await api.tabs.update(tabId, { url: target }); return { ok: true, url: publicURL(target) }; }
    if (operation === "close_tab") { readableTabs.delete(tabId); await api.tabs.remove(tabId); return { ok: true }; }
    const result = await api.scripting.executeScript({ target: { tabId }, func: actOnPage, args: [operation, elementId, text, currentURL, { direction, checked }] });
    return scriptResult(result, "The page did not confirm the action. Read it again before retrying.");
  };
}
