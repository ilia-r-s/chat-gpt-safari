import { snapshotPage, actOnPage } from "../content/page.js";
import { readyTab, watchNavigation } from "./tab-navigation.js";
import { publicURL, safeWebURL } from "./context.js";
import { allowsAction, sitePermissionPattern, visibleWebsite } from "./website-access.js";

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

export async function readTab(api, tabId, limit, { viewportOnly = false, selectionOnly = false, expectedURL } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Select a Safari tab first.");
  const url = expectedURL ?? (await api.tabs.get(tabId)).url;
  if (url && !safeWebURL(url)) throw new Error("Safari protects this page. Open an ordinary website to attach it.");
  const results = await api.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [limit, viewportOnly, selectionOnly, url ?? null] });
  return scriptResult(results, "Could not read this page. Check that the tab finished loading and read it again.");
}

export async function sourceWindowId(api, tabId) {
  if (!Number.isInteger(tabId)) return undefined;
  try {
    const { windowId } = await api.tabs.get(tabId);
    if (Number.isInteger(windowId)) return windowId;
  }
  catch { throw new Error("The source tab was closed. Open Safari Chat from the window you want to use."); }
  throw new Error("Safari could not identify the source window. Open Safari Chat from the website again.");
}

export function createBrowserTools({ api, pageChars, approve, requestSiteAccess, verifySession, readAccess, initialTabs = [], defaultTabId = null, protectedTabId = null }) {
  const readableTabs = new Map(initialTabs.filter(tab => Number.isInteger(tab.id) && safeWebURL(tab.url)).map(tab => [tab.id, new URL(tab.url).origin]));
  // A requested destination is a hint for Safari's permission sheet, never proof
  // of the live tab's URL or a grant to share its contents.
  const destinations = new Map(), declinedSites = new Set();
  const snapshots = new Map();
  async function authorize(details, hosts, signal, sharedRead = false, siteOrigin = null) {
    const automatic = readAccess && allowsAction(await readAccess(), hosts);
    signal.throwIfAborted();
    const pattern = siteOrigin && sitePermissionPattern(siteOrigin);
    let choice;
    if (siteOrigin) {
      if (!requestSiteAccess) throw new Error("Allow Safari Chat to access " + hosts[0] + " in Safari website settings, then read the existing tab.");
      if (verifySession) await verifySession();
      signal.throwIfAborted();
      try {
        await requestSiteAccess(siteOrigin, signal);
        signal.throwIfAborted();
        if (!await api.permissions.contains({ origins: [pattern] })) throw new Error("Safari did not grant access to " + hosts[0] + ".");
      } catch (error) { declinedSites.add(pattern); throw error; }
      choice = "once";
    } else if (!sharedRead && !automatic) choice = await approve({ ...details, hosts }, signal);
    return {
      // A temporary read grant lasts for this tab/origin in this request.
      // Re-evaluate persistent grants on every read so revocation takes effect.
      rememberRead: sharedRead || (!automatic && choice !== "site" && choice !== "all"),
      async verify() {
        const latest = await readAccess?.();
        if (latest && !allowsAction(latest, hosts) && (automatic || choice === "site" || choice === "all") && !sharedRead) {
          throw new Error("Website access changed. Request this action again.");
        }
        if (pattern && !await api.permissions.contains({ origins: [pattern] })) throw new Error("Safari website permission changed. Read the existing tab again.");
        if (verifySession) await verifySession();
        signal.throwIfAborted();
        return latest;
      },
    };
  }
  async function readPage(tabId, signal) {
    const hint = destinations.get(tabId) ?? readableTabs.get(tabId);
    const committed = tab => !hint || tab.url !== "about:blank";
    let tab = await readyTab(api, tabId, signal, committed);
    let url = safeWebURL(tab.url), grant;
    const visibleTab = () => readyTab(api, tabId, signal, current => !!current.url && current.url !== "about:blank",
      "Safari still hides the address of this tab. It may have redirected. Check website access for the site shown in that tab.");
    const readGrant = (address, askSafari = false) => {
      const { hostname, origin } = new URL(address);
      if (declinedSites.has(sitePermissionPattern(origin))) throw new Error("Website access to " + hostname + " was declined for this task. Do not request it again.");
      return authorize({ operation: "read", title: "Read this page?", detail: publicURL(address) },
        [hostname], signal, readableTabs.get(tabId) === origin, askSafari ? origin : null);
    };
    if (!tab.url && hint && api.permissions?.contains) {
      const pattern = sitePermissionPattern(hint);
      if (!pattern) throw new Error("Safari cannot request website access for this address.");
      if (!await api.permissions.contains({ origins: [pattern] })) grant = await readGrant(hint, true);
      tab = await visibleTab();
      url = safeWebURL(tab.url);
      if (grant && (!url || new URL(url).origin !== hint)) throw new Error("The tab changed websites during the permission request. Read this same tab again to review its current site.");
    }
    if (!url) throw new Error(tab.url ? "Safari protects this page. Choose an HTTP or HTTPS website." : "Safari has not exposed this tab's address. Check Safari Chat's website access for the site in that tab.");
    const origin = new URL(url).origin;
    const requestedAccess = !!grant;
    grant ??= await readGrant(url);
    await grant.verify();
    const capture = () => readTab(api, tabId, pageChars, { viewportOnly: true, expectedURL: url });
    let page;
    try { page = await capture(); } catch (error) {
      // A tab's address may still be visible when Safari rejects injection.
      // Recover a permission failure once, without replaying a browser mutation.
      if (requestedAccess || !requestSiteAccess || !api.permissions?.contains ||
          !/permission|does not have access|access (?:was |is )?denied|cannot access contents/i.test(error.message)) throw error;
      signal.throwIfAborted();
      const pattern = sitePermissionPattern(origin);
      if (!pattern || await api.permissions.contains({ origins: [pattern] })) throw error;
      const current = await api.tabs.get(tabId);
      if (current.url && current.url !== url) throw new Error("The tab navigated before the read. Read this same tab again.");
      grant = await readGrant(url, true);
      if ((await visibleTab()).url !== url) throw new Error("The tab navigated during the permission request. Read this same tab again.");
      await grant.verify();
      page = await capture();
    }
    signal.throwIfAborted();
    if (readAccess) await grant.verify();
    if (new URL(page.url).origin !== origin) throw new Error("The tab changed websites while reading. Request permission for the new page.");
    if (grant.rememberRead) readableTabs.set(tabId, origin);
    snapshots.set(tabId, { url: page.url, elements: page.elements });
    return { ...page, url: publicURL(page.url), tabId };
  }
  return async function execute(args, signal) {
    const { operation, tabId: requestedTab, elementId, url, text, direction, checked } = args ?? {};
    const tabId = requestedTab ?? defaultTabId;
    if (!["read", "click", "fill", "select", "set_checked", "scroll", "navigate", "open_tab", "close_tab", "list_tabs"].includes(operation)) throw new Error("Unknown browser action.");
    signal.throwIfAborted();
    if (operation === "list_tabs") {
      const grant = await authorize({ operation, title: "Share your open tabs?", detail: "Share the titles and addresses of accessible tabs in this window." }, [], signal);
      const windowId = await sourceWindowId(api, defaultTabId);
      await grant.verify();
      const tabs = await api.tabs.query(Number.isInteger(windowId) ? { windowId } : { currentWindow: true });
      const access = readAccess ? await grant.verify() : undefined;
      return tabs.filter(tab => visibleWebsite(tab.url, access)).slice(0, 40).map(tab => ({ tabId: tab.id, title: (tab.title ?? "Untitled").slice(0, 160), url: publicURL(tab.url) }));
    }
    if (operation === "open_tab") {
      const target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS URLs without credentials are allowed.");
      const grant = await authorize({ operation, title: "Open a new tab?", detail: target }, [new URL(target).hostname], signal);
      const windowId = await sourceWindowId(api, defaultTabId);
      await grant.verify();
      const tab = await api.tabs.create({ url: target, active: false, ...(Number.isInteger(windowId) ? { windowId } : {}) });
      if (requestSiteAccess) destinations.set(tab.id, new URL(target).origin);
      return { ok: true, tabId: tab.id, url: publicURL(target), message: "Tab opened. To inspect it, call read with this tabId." };
    }
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("A valid tab ID is required.");
    if (tabId === protectedTabId) throw new Error("This tab contains Safari Chat. Choose a website tab.");
    if (operation === "read") return readPage(tabId, signal);
    const tab = await api.tabs.get(tabId);
    const currentURL = safeWebURL(tab.url);
    if (!currentURL) throw new Error("Safari has not exposed a website address for this tab. Read the tab before trying this action.");
    const hosts = [new URL(currentURL).hostname];
    const snapshot = snapshots.get(tabId);
    let detail;
    let target;
    let galleryScroll = false;
    if (operation === "navigate") {
      target = safeWebURL(url);
      if (!target) throw new Error("Only HTTP and HTTPS navigation is supported.");
      if (new URL(target).hostname !== hosts[0]) hosts.push(new URL(target).hostname);
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
      if (operation === "click" && ref.destinationHost && ref.destinationHost !== hosts[0]) {
        hosts.push(ref.destinationHost);
        detail += `\nDestination: ${ref.destinationHost}`;
      }
    }
    const grant = await authorize({ operation, title: galleryScroll ? "Move this gallery?" : { click: "Click this element?", fill: "Enter this text?", select: "Choose this option?", set_checked: "Change this checkbox or radio option?", scroll: "Scroll this page or area?", navigate: "Navigate this tab?", close_tab: "Close this tab?" }[operation], detail }, hosts, signal);
    signal.throwIfAborted();
    // The user may navigate while an approval is visible; reject stale permission.
    const now = await api.tabs.get(tabId);
    await grant.verify();
    if (now.url !== currentURL) throw new Error("The tab navigated while awaiting approval. Read it again.");
    snapshots.delete(tabId);
    if (operation === "navigate") {
      readableTabs.delete(tabId);
      await watchNavigation(api, tabId, currentURL, signal, () => api.tabs.update(tabId, { url: target }), true);
      if (requestSiteAccess) destinations.set(tabId, new URL(target).origin);
      return { ok: true, url: publicURL(target) };
    }
    if (operation === "close_tab") { readableTabs.delete(tabId); destinations.delete(tabId); await api.tabs.remove(tabId); return { ok: true }; }
    const dispatch = async () => scriptResult(await api.scripting.executeScript({ target: { tabId }, func: actOnPage, args: [operation, elementId, text, currentURL, { direction, checked }] }), "The page did not confirm the action. Read it again before retrying.");
    return operation === "click" ? watchNavigation(api, tabId, currentURL, signal, dispatch, false) : dispatch();
  };
}
