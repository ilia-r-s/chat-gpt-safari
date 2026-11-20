import { anchorPopover } from "./popover.js";
import { sitePermissionPattern } from "../core/website-access.js";

const $ = id => document.getElementById(id);
const emptyAccess = () => ({ mode: "ask", allowed: [], blocked: [] });

export function setupWebsiteControls({ state, rpc, answer, openSettings, report, tabAccess }) {
  const closeMode = anchorPopover($("access-menu"), $("actions-guidance"), 292);
  const closeChoices = anchorPopover($("approval-options"), $("approval-more"), 264);
  let access = emptyAccess(), revision = 0, saving = null, pending = null;

  function refresh() {
    const disabled = !state().enabled || !!saving;
    for (const id of ["actions-guidance", "ask-mode", "auto-mode", "site-host", "site-rule", "save-site"]) $(id).disabled = disabled;
    for (const button of $("site-list").querySelectorAll("button")) button.disabled = disabled;
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
    if (pending?.tabLabel) tabAccess.close();
    pending = null; closeChoices(); $("approval").hidden = true;
    $("approval-path").hidden = true;
    $("approval-path").querySelector("svg").replaceChildren();
    $("approval-detail").textContent = ""; $("approval-title").textContent = ""; $("allow-host").textContent = "";
  }
  function respond(allow, scope = "once", origin) {
    if (!pending) return;
    const id = pending.id;
    dismiss();
    answer({ type: "approval", id, allow, scope, ...(origin && { origin }) });
    $("prompt").focus();
  }
  function show(request) {
    pending = request; closeChoices();
    $("approve-button").textContent = request.siteOrigin || request.tabLabel ? "Allow in Safari…" : "Allow once";
    $("approve-button").disabled = false;
    $("approval-more").hidden = !!(request.siteOrigin || request.tabLabel);
    $("approval-title").textContent = request.title;
    $("approval-detail").textContent = request.detail;
    const preview = $("approval-path"), paths = request.paths || (request.path ? [request.path] : []), points = paths.flat();
    preview.hidden = !points?.length;
    if (points?.length) {
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
      const pad = Math.max(8, width * 0.08, height * 0.12);
      const svg = preview.querySelector("svg"), shape = tag => document.createElementNS("http://www.w3.org/2000/svg", tag);
      svg.setAttribute("viewBox", [x - pad, y - pad, width + 2 * pad, height + 2 * pad].join(" "));
      svg.setAttribute("aria-label", paths.length === 1 ? "Proposed path, from the dot to the ring" : "Proposed contact paths, from dots to rings");
      svg.replaceChildren(...paths.map(path => {
        const group = shape("g"), line = shape("polyline");
        line.setAttribute("points", path.map(p => p.join(",")).join(" ")); group.append(line);
        for (const [i, [cx, cy]] of [path[0], path.at(-1)].entries()) {
          const circle = shape("circle");
          circle.setAttribute("cx", cx); circle.setAttribute("cy", cy); circle.setAttribute("r", pad * (i ? 0.44 : 0.3));
          group.append(circle);
        }
        return group;
      }));
    }
    $("allow-site").hidden = request.hosts?.length !== 1;
    $("allow-host").textContent = request.hosts?.length === 1 ? `Automatically allow browser actions on ${request.hosts[0]}.` : "";
    $("approval").hidden = false;
    $("approval").scrollIntoView({ block: "nearest" });
  }
  async function chooseMode(mode) {
    closeMode();
    const request = pending;
    if (await save({ mode }) && mode === "auto" && request && !request.siteOrigin && !request.tabLabel && pending === request) respond(true);
  }
  for (const mode of ["ask", "auto"]) $(`${mode}-mode`).onclick = () => chooseMode(mode);
  $("manage-sites").onclick = () => {
    closeMode(); openSettings(); $("website-section").open = true; $("browser-permissions").focus();
  };
  $("site-form").onsubmit = async event => {
    event.preventDefault();
    if (await save({ host: $("site-host").value, rule: $("site-rule").value })) $("site-host").value = "";
  };
  $("approve-button").onclick = async () => {
    const request = pending;
    if (request?.tabLabel) {
      $("approve-button").disabled = true;
      try {
        const origin = await tabAccess.identify(request.tabId, request.tabLabel);
        if (pending === request) respond(true, "once", origin);
      } catch (error) {
        if (pending === request) { report(error.message); respond(false); }
      }
      return;
    }
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
    tabAccess.close();
    saving = null; dismiss(); closeMode();
    $("site-host").value = ""; $("site-status").textContent = ""; $("website-section").open = false;
    update(null);
  }
  return { update, refresh, show, dismiss, reset, get access() { return access; }, get revision() { return revision; }, get saved() { return saving; } };
}
