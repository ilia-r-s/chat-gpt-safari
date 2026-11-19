import { snapshotPage, actOnPage } from "../content/page.js";
import { installPointerPath } from "../content/pointer-path.js";
import { showActionPointer } from "../content/action-pointer.js";
import { readyTab, watchNavigation } from "./tab-navigation.js";
import { INPUT_ACTIONS } from "./page-input.js";
import { motionResult } from "./motion-session.js";
import { publicURL, safeWebURL } from "./context.js";
import { allowsAction, sitePermissionPattern, visibleWebsite } from "./website-access.js";

function describePath(path, viewport, bounds) {
  if (!viewport || !bounds || !Array.isArray(path) || path.length < 2 || path.length > 128) throw new Error("Read the target and choose 2-128 visible viewport points.");
  for (const point of path) {
    const { x, y, speed } = point ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw new Error("Every point must fit inside the visible viewport.");
    if (speed != null && (!Number.isFinite(speed) || speed < 0)) throw new Error("Waypoint speeds must be finite and nonnegative.");
  }
  const [left, top, right, bottom] = bounds, first = path[0], last = path.at(-1);
  if (first.x < left || first.x >= right || first.y < top || first.y >= bottom) throw new Error("Start the path inside the selected target's visible bounds.");
  return path.length + " waypoints from (" + first.x + ", " + first.y + ") to (" + last.x + ", " + last.y + ").";
}

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

export async function indicatePageAction(api, tabId, url, target, effect = "copy", frameId = 0) {
  if (!safeWebURL(url) || !Number.isInteger(frameId) || frameId < 0) return;
  try {
    const result = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: showActionPointer, args: [url, target, effect] });
    // Allow one visible arrival before navigation. The background timer also
    // completes when the source tab becomes hidden and its own timers suspend.
    const delay = result?.[0]?.result;
    if (effect === "aim" && delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 125)));
  } catch { /* A missing frame or an unavailable visual must not replay or block an action. */ }
}

export async function readTab(api, tabId, limit, { viewportOnly = false, selectionOnly = false, expectedURL, pointerPaths = false } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Select a Safari tab first.");
  const url = expectedURL ?? (await api.tabs.get(tabId)).url;
  if (url && !safeWebURL(url)) throw new Error("Safari protects this page. Open an ordinary website to attach it.");
  const results = await api.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [limit, viewportOnly, selectionOnly, url ?? null, true, pointerPaths] });
  const { pointerRect, ...page } = scriptResult(results, "Could not read this page. Check that the tab finished loading and read it again.");
  if (pointerRect) await indicatePageAction(api, tabId, page.url, pointerRect);
  return page;
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

export function createBrowserTools({ api, pageChars, approve, requestSiteAccess, verifySession, readAccess, motionSession, inputs, initialTabs = [], defaultTabId = null, protectedTabId = null }) {
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
    const capture = () => readTab(api, tabId, pageChars, { viewportOnly: true, expectedURL: url, pointerPaths: !!motionSession });
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
    snapshots.set(tabId, { url: page.url, elements: page.elements, viewport: page.viewport });
    return { ...page, url: publicURL(page.url), tabId, ...(motionSession?.last?.tabId === tabId && { motion: motionSession.last }) };
  }
  return async function execute(args, signal) {
    const { operation, tabId: requestedTab, elementId, url, text, direction, speed, checked, path, wait, speedChanges } = args ?? {};
    const tabId = requestedTab ?? defaultTabId;
    if (!["read", "click", "fill", "select", "set_checked", "scroll", "drag", "move_pointer", "set_speed", "stop_motion", "wait_motion", "navigate", "open_tab", "close_tab", "list_tabs", ...INPUT_ACTIONS].includes(operation)) throw new Error("Unknown browser action.");
    signal.throwIfAborted();
    const motion = motionSession?.current;
    const pointerPath = operation === "drag" || operation === "move_pointer";
    const continuous = operation === "scroll" && speed != null;
    if (speedChanges != null && (!continuous || motion || !Array.isArray(speedChanges) || speedChanges.length > 128 ||
        speedChanges.some((change, i) => !Number.isFinite(change?.after) || change.after < 0 || (i && change.after <= speedChanges[i-1].after) || !Number.isFinite(change?.speed) || change.speed < 0))) {
      throw new Error("On starting a continuous scroll, supply up to 128 speed changes with increasing distances in CSS pixels and nonnegative speeds.");
    }
    if (["stop_motion", "wait_motion", "set_speed"].includes(operation)) {
      if (!motionSession || motionSession.last?.tabId !== tabId) throw new Error("There is no motion for this run in that tab.");
      let state = motionSession.last;
      if (operation === "set_speed") {
        state = await motionSession.adjust(motion, speed);
        if (wait && motion) state = await motion.finished;
      } else if (motion) state = operation === "wait_motion" ? await motion.finished : await motionSession.stop("stopped by model");
      signal.throwIfAborted();
      if (!state.active) snapshots.delete(tabId);
      return motionResult(state);
    }
    if (continuous || pointerPath) {
      if (!motionSession) throw new Error("Use Safari side chat for continuous scroll and pointer paths.");
      if (speed != null && (!Number.isFinite(speed) || speed < 0)) throw new Error("Use a finite speed of zero or more CSS pixels per second.");
      if (motionSession.last?.reason === "stopped by user") throw new Error("The user stopped motion. Leave it stopped for this message.");
      if (continuous && !["up", "down", "left", "right"].includes(direction)) throw new Error("Continuous scroll needs up, down, left or right.");
      if (motion) {
        if (!continuous || motion.kind !== "scroll" || motion.tabId !== tabId || elementId) throw new Error("Stop the current motion before starting another. Use set_speed to adjust it.");
        if (!motion.directions.includes(direction)) throw new Error("Use a direction supported by the scrolling area.");
        const state = await motionSession.adjust(motion, speed, direction);
        return motionResult(wait ? await motion.finished : state);
      }
    }
    if (motion && !["read", "list_tabs"].includes(operation)) {
      await motionSession.stop("another action");
      snapshots.delete(motion.tabId);
      signal.throwIfAborted();
    }
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
    const fieldClick = inputs && operation === "click" && (args.point || snapshot?.elements.find(item => item.id === elementId)?.actions?.includes("type_text"));
    if (INPUT_ACTIONS.includes(operation) || fieldClick) {
      if (!inputs) throw new Error("Use Safari side chat for direct keyboard, selection and pointer input.");
      const indicate = (target, effect) => indicatePageAction(api, tabId, currentURL, target, effect);
      snapshots.delete(tabId);
      return inputs.execute(args, tabId, currentURL, snapshot, authorize, signal, indicate);
    }
    let detail;
    let target;
    let galleryScroll = false;
    let directions;
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
      if (!(["scroll", "move_pointer"].includes(operation) && !elementId) && !ref) throw new Error("Read the current page before acting on an element.");
      if (operation !== "move_pointer" && ref?.actions && !ref.actions.includes(operation)) throw new Error("This control does not support that action. Read the page and use one of its listed actions.");
      if (operation === "scroll" && ref?.directions && !ref.directions.includes(direction)) throw new Error("Use one of this area's listed scroll directions.");
      galleryScroll = operation === "scroll" && ref?.kind === "carousel";
      if (continuous && galleryScroll) throw new Error("This gallery has discrete navigation controls. Use scroll with speed null for each item.");
      directions = ref?.directions ?? ["up", "down", "left", "right"];
      detail = `${publicURL(currentURL)}\n${ref?.label ?? "Page"}${["fill", "select"].includes(operation) ? `\n${text}` : ""}${operation === "scroll" ? `\n${galleryScroll ? "Advance gallery" : "Scroll"} ${direction}` : ""}${operation === "set_checked" ? `\n${checked ? "Check" : "Uncheck"}` : ""}`;
      if (operation === "click" && ref.destinationHost && ref.destinationHost !== hosts[0]) {
        hosts.push(ref.destinationHost);
        detail += `\nDestination: ${ref.destinationHost}`;
      }
      if (pointerPath) detail += "\n" + describePath(path, snapshot.viewport, ref?.bounds ?? [0, 0, snapshot.viewport?.width, snapshot.viewport?.height]);
      if (continuous) detail += "\nStart at " + speed + " px/s. Speed and direction can change within this area. You can stop scrolling in chat or on the page.";
    }
    const title = continuous ? "Scroll continuously?" : galleryScroll ? "Move this gallery?" : {
      drag: "Drag along this path?", move_pointer: "Move the pointer along this path?", click: "Click this element?",
      fill: "Enter this text?", select: "Choose this option?", set_checked: "Change this checkbox or radio option?",
      scroll: "Scroll this page or area?", navigate: "Navigate this tab?", close_tab: "Close this tab?",
    }[operation];
    const grant = await authorize({ operation, title, detail, ...(pointerPath && { path: path.map(({ x, y }) => [x, y]) }) }, hosts, signal);
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
    const inject = (preview = false, motionId = null) => api.scripting.executeScript({
      target: { tabId }, func: actOnPage,
      args: [operation, elementId ?? null, text ?? null, currentURL, { direction: direction ?? null, checked: checked ?? null, preview, ...(inputs && operation === "click" && { inputOwner: inputs.owner }), ...(motionId && { motionId, speed: speed ?? 600, ...(pointerPath && { path }), ...(speedChanges && { speedChanges }) }) }],
    });
    if (now.active !== false && (operation === "click" || operation === "set_checked" || galleryScroll)) {
      const preview = await inject(true).catch(() => null);
      if (preview?.[0]?.result?.pointer) await indicatePageAction(api, tabId, currentURL, { ref: elementId }, "aim");
      // The user can stop the run or revoke a grant while a visible pointer paints.
      await grant.verify();
    }
    const dispatch = async motionId => scriptResult(await inject(false, motionId), "The page did not confirm the action. Read it again before retrying.");
    if (pointerPath) {
      scriptResult(await api.scripting.executeScript({ target: { tabId }, func: installPointerPath }), "Safari could not prepare the pointer path.");
      await grant.verify();
      const { x, y } = path[0];
      await indicatePageAction(api, tabId, currentURL, { left: x - 1, top: y - 1, right: x + 1, bottom: y + 1 }, "aim");
    }
    if (continuous || pointerPath) return motionSession.start(tabId, operation, directions, grant.verify, signal, dispatch, wait ?? pointerPath);
    if (operation !== "click") return dispatch();
    const result = await watchNavigation(api, tabId, currentURL, signal, dispatch, false);
    if (inputs && result.focused) inputs.targets.set(tabId, { url: currentURL, ref: snapshot.elements.find(item => item.id === elementId), selected: false });
    return result;
  };
}
