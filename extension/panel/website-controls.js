import { anchorPopover } from "./popover.js";
import { sitePermissionPattern } from "../core/website-access.js";

const $ = id => document.getElementById(id);
const emptyAccess = () => ({ mode: "ask", allowed: [], blocked: [] });

export function setupWebsiteControls({ state, rpc, answer, openSettings, report }) {
  const closeMode = anchorPopover($("access-menu"), $("actions-guidance"), 292);
  const closeChoices = anchorPopover($("approval-options"), $("approval-more"), 264);
  let access = emptyAccess(), revision = 0, saving = null, pending = null;

  function refresh() {
    const disabled = !state().enabled || !!saving;
    for (const id of ["actions-guidance", "ask-mode", "auto-mode", "default-access", "site-host", "site-rule", "save-site"]) $(id).disabled = disabled;
    for (const button of $("site-list").querySelectorAll("button")) button.disabled = disabled;
    $("default-access").value = access.mode;
    $("mode-label").textContent = access.mode === "auto" ? "Approve for me" : "Ask for approval";
    $("ask-mode").setAttribute("aria-pressed", String(access.mode === "ask"));
    $("auto-mode").setAttribute("aria-pressed", String(access.mode === "auto"));
  }
  function update(value) {
    access = value ?? emptyAccess();
    revision++;
    $("site-list").replaceChildren();
    for (const [rule, sites] of [["Allowed", access.allowed], ["Blocked", access.blocked]]) {
      for (const host of sites) {
        const row = document.createElement("li");
        const name = document.createElement("span"); name.textContent = host;
        const label = document.createElement("small"); label.textContent = rule;
        const remove = document.createElement("button"); remove.className = "icon-button"; remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove rule for ${host}`);
        remove.onclick = () => save({ host, rule: "remove" });
        row.append(name, label, remove); $("site-list").append(row);
      }
    }
    refresh();
  }
  async function save(change) {
    if (!state().enabled || saving) return false;
    const { account, generation } = state(), before = revision;
    const task = rpc("access.change", { account, generation, change });
    saving = task; refresh();
    try {
      const result = await task;
      if (saving !== task || state().generation !== generation) return false;
      if (revision === before) update(result);
      $("site-status").textContent = change.rule === "remove" ? "Website rule removed." : "Website access saved.";
      return true;
    } catch (error) {
      if (saving === task && state().generation === generation) {
        $("site-status").textContent = error.message; report(error.message);
      }
      return false;
    } finally {
      if (saving === task) { saving = null; refresh(); }
    }
  }
  function dismiss() {
    pending = null; closeChoices(); $("approval").hidden = true;
    $("approval-detail").textContent = ""; $("approval-title").textContent = ""; $("allow-host").textContent = "";
  }
  function respond(allow, scope = "once") {
    if (!pending) return;
    const id = pending.id;
    dismiss();
    answer({ type: "approval", id, allow, scope });
    $("prompt").focus();
  }
  function show(request) {
    pending = request; closeChoices();
    $("approve-button").textContent = request.siteOrigin ? "Allow in Safari…" : "Allow once";
    $("approve-button").disabled = false;
    $("approval-more").hidden = !!request.siteOrigin;
    $("approval-title").textContent = request.title;
    $("approval-detail").textContent = request.detail;
    $("allow-site").hidden = request.hosts?.length !== 1;
    $("allow-host").textContent = request.hosts?.length === 1 ? `Automatically allow browser actions on ${request.hosts[0]}.` : "";
    $("approval").hidden = false;
    $("approval").scrollIntoView({ block: "nearest" });
  }
  async function chooseMode(mode) {
    closeMode();
    const request = pending;
    if (await save({ mode }) && mode === "auto" && request && !request.siteOrigin && pending === request) respond(true);
  }
  for (const mode of ["ask", "auto"]) $(`${mode}-mode`).onclick = () => chooseMode(mode);
  $("default-access").onchange = () => chooseMode($("default-access").value);
  $("manage-sites").onclick = () => {
    closeMode(); openSettings(); $("website-section").open = true; $("browser-permissions").focus();
  };
  $("site-form").onsubmit = async event => {
    event.preventDefault();
    if (await save({ host: $("site-host").value, rule: $("site-rule").value })) $("site-host").value = "";
  };
  $("approve-button").onclick = async () => {
    const request = pending;
    if (!request?.siteOrigin) { respond(true); return; }
    const pattern = sitePermissionPattern(request.siteOrigin);
    if (!pattern) { respond(false); return; }
    $("approve-button").disabled = true;
    try {
      // Call Safari directly inside the click so it receives the user gesture.
      const granted = await browser.permissions.request({ origins: [pattern] });
      if (pending === request) respond(granted === true);
    } catch {
      const granted = await browser.permissions?.contains?.({ origins: [pattern] }).catch(() => false);
      if (pending === request) {
        if (granted) { respond(true); return; }
        $("approval-detail").textContent = "Safari couldn’t open its permission sheet. Check Safari Chat’s access to " + new URL(request.siteOrigin).hostname + " in Safari’s website settings, then try again.";
        $("approve-button").disabled = false;
      }
    }
  };
  $("decline-button").onclick = () => respond(false);
  $("allow-site").onclick = () => respond(true, "site");
  $("allow-all").onclick = () => respond(true, "all");

  function reset() {
    saving = null; dismiss(); closeMode();
    $("site-host").value = ""; $("site-status").textContent = ""; $("website-section").open = false;
    update(null);
  }
  return { update, refresh, show, dismiss, reset, get revision() { return revision; }, get saved() { return saving; } };
}
