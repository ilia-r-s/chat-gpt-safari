import { safeWebURL } from "../core/context.js";
import { sitePermissionPattern, visibleWebsite } from "../core/website-access.js";

// A real click gives Safari an opportunity to identify just this existing tab.
// If Safari still withholds the address, the user can supply its exact website.
export function setupTabAccess(getAccess, rpc) {
  const dialog = document.getElementById("tab-access-dialog");
  const input = document.getElementById("tab-address"), status = document.getElementById("tab-access-status");
  const allow = document.getElementById("tab-access-allow");
  let pending, sequence = 0;
  function close() {
    sequence++;
    if (pending) {
      pending.reject(new Error("Website access was cancelled."));
    }
    pending = null;
    if (dialog.open) dialog.close();
    input.value = "";
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  document.getElementById("tab-access-cancel").onclick = close;
  dialog.querySelector("form").onsubmit = async event => {
    event.preventDefault();
    const current = pending;
    if (!current) return;
    const value = input.value.trim();
    const address = safeWebURL(value.includes("://") ? value : "https://" + value);
    const pattern = sitePermissionPattern(address);
    if (!pattern || !visibleWebsite(address, getAccess())) { status.textContent = "Enter an allowed HTTP or HTTPS website."; return; }
    allow.disabled = true;
    try {
      if (!await browser.permissions.request({ origins: [pattern] })) throw new Error("Safari declined website access.");
      const origin = await rpc("tabs.origin", { tabId: current.tabId, wait: true });
      if (current !== pending) return;
      if (sitePermissionPattern(origin) !== pattern || !visibleWebsite(origin, getAccess())) throw new Error("That website does not match this tab's current address.");
      pending = null; dialog.close(); input.value = ""; current.resolve(origin);
    } catch (error) { if (pending === current) status.textContent = error.message; }
    finally { if (pending === current) allow.disabled = false; }
  };
  async function identify(tabId, title) {
    close();
    const start = sequence;
    const origin = await rpc("tabs.origin", { tabId });
    if (start !== sequence) throw new Error("The tab request changed.");
    if (origin) return origin;
    document.getElementById("tab-access-heading").textContent = "Website in " + title;
    status.textContent = ""; allow.disabled = false;
    return new Promise((resolve, reject) => {
      pending = { tabId, resolve, reject };
      dialog.showModal(); input.focus();
    });
  }
  return { identify, close };
}
