import { snapshotPage, actOnPage } from "../content/page.js";
import { publicURL, safeWebURL } from "./context.js";

export async function readTab(api, tabId, limit) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Select a Safari tab first.");
  const tab = await api.tabs.get(tabId);
  if (tab.url && !safeWebURL(tab.url)) throw new Error("Safari protects this page. Open an ordinary website to attach it.");
  const results = await api.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [limit] });
  if (!results[0]?.result) throw new Error("Could not read this page. Allow the extension on this website in Safari.");
  return results[0].result;
}

export function createBrowserTools({ api, pageChars, approve, initialTabs = [] }) {
  const readableTabs = new Map(initialTabs.filter(tab => Number.isInteger(tab.id) && safeWebURL(tab.url)).map(tab => [tab.id, new URL(tab.url).origin]));
  const snapshots = new Map();
  return async function execute(args, signal) {
    const { operation, tabId, elementId, url, text } = args ?? {};
    if (!["read", "click", "fill", "navigate", "open_tab", "close_tab", "list_tabs"].includes(operation)) throw new Error("Unknown browser action.");
    signal.throwIfAborted();
    if (operation === "list_tabs") {
      await approve({ operation, title: "Share your open tabs?", detail: "This shares titles and website addresses of accessible tabs for this request." }, signal);
      const tabs = await api.tabs.query({ currentWindow: true });
      return tabs.filter(tab => safeWebURL(tab.url)).slice(0, 40).map(tab => ({ tabId: tab.id, title: (tab.title ?? "Untitled").slice(0, 160), url: publicURL(tab.url) }));
    }
    if (operation === "open_tab") {
      const target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS URLs without credentials are allowed.");
      await approve({ operation, title: "Open a new tab?", detail: target }, signal);
      signal.throwIfAborted();
      const tab = await api.tabs.create({ url: target, active: false });
      return { tabId: tab.id, url: publicURL(target), message: "Tab opened. Request a read after it loads." };
    }
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("A valid tab ID is required.");
    const tab = await api.tabs.get(tabId);
    const currentURL = safeWebURL(tab.url);
    if (!currentURL) throw new Error("Safari has not granted access to this tab. Open the extension on that website first.");
    if (operation === "read") {
      const origin = new URL(currentURL).origin;
      if (readableTabs.get(tabId) !== origin) {
        await approve({ operation, title: "Read this page?", detail: publicURL(currentURL) }, signal);
        readableTabs.set(tabId, origin);
      }
      signal.throwIfAborted();
      const page = await readTab(api, tabId, pageChars);
      if (new URL(page.url).origin !== origin) throw new Error("The tab changed websites while reading. Request permission for the new page.");
      snapshots.set(tabId, { url: page.url, elements: page.elements });
      return { ...page, url: publicURL(page.url), tabId };
    }
    const snapshot = snapshots.get(tabId);
    let detail;
    let target;
    if (operation === "navigate") {
      target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS navigation is supported.");
       detail = `${publicURL(currentURL)} \u2192 ${target}`;
    } else if (operation === "close_tab") detail = `${tab.title ?? "Tab"}\n${publicURL(currentURL)}`;
    else {
      const ref = snapshot?.elements.find(element => element.id === elementId);
      if (!ref || snapshot.url !== currentURL) throw new Error("Read the current page before acting on an element.");
      if (operation === "fill" && (typeof text !== "string" || text.length > 12000)) throw new Error("Invalid field text.");
      detail = `${publicURL(currentURL)}\n${ref.label}${operation === "fill" ? `\n${text}` : ""}`;
    }
    await approve({ operation, title: { click: "Click this element?", fill: "Enter this text?", navigate: "Navigate this tab?", close_tab: "Close this tab?" }[operation], detail }, signal);
    signal.throwIfAborted();
    // The user may navigate while an approval is visible; reject stale permission.
    const now = await api.tabs.get(tabId);
    if (now.url !== currentURL) throw new Error("The tab navigated while awaiting approval. Read it again.");
    snapshots.delete(tabId);
    if (operation === "navigate") { readableTabs.delete(tabId); await api.tabs.update(tabId, { url: target }); return { ok: true, url: publicURL(target) }; }
    if (operation === "close_tab") { readableTabs.delete(tabId); await api.tabs.remove(tabId); return { ok: true }; }
    const result = await api.scripting.executeScript({ target: { tabId }, func: actOnPage, args: [operation, elementId, text, currentURL] });
    return result[0]?.result ?? { error: "The page did not confirm the action." };
  };
}
