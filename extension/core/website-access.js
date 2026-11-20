import { publicURL, safeWebURL } from "./context.js";

// Website grants belong to one connection in one Safari profile.
export const accessKey = account => `website-access:${account}`;

export function websiteHost(input) {
  if (typeof input !== "string" || !input.trim() || /[\s/@?#*\\]/.test(input.trim())) return null;
  try {
    const raw = input.trim();
    if (raw.includes(":") && !(raw.startsWith("[") && raw.endsWith("]"))) return null;
    const host = new URL(`https://${raw}`).hostname.replace(/\.$/, "");
    return host && host.length <= 253 ? host : null;
  } catch { return null; }
}

// WebExtension host patterns scope by scheme and hostname, across ports.
export function sitePermissionPattern(value) {
  const safe = safeWebURL(value);
  if (!safe) return null;
  const url = new URL(safe);
  return websiteHost(url.hostname) ? url.protocol + "//" + url.hostname + "/*" : null;
}

export async function readWebsiteAccess(storage, account) {
  const key = accessKey(account);
  const value = (await storage.get(key))[key];
  return { mode: value?.mode === "auto" ? "auto" : "ask",
    allowed: Array.isArray(value?.allowed) ? value.allowed : [],
    blocked: Array.isArray(value?.blocked) ? value.blocked : [] };
}

export function changeWebsiteAccess(access, change) {
  if (change?.mode === "ask" || change?.mode === "auto") return { ...access, mode: change.mode };
  const url = safeWebURL(change?.host);
  const host = websiteHost(url ? new URL(url).hostname : change?.host);
  if (!host || !["allow", "block", "remove"].includes(change.rule)) throw new Error("Enter a website host, such as example.com.");
  const allowed = access.allowed.filter(item => item !== host);
  const blocked = access.blocked.filter(item => item !== host);
  if (change.rule !== "remove") {
    if (allowed.length + blocked.length >= 200) throw new Error("Remove a saved website before adding another.");
    (change.rule === "allow" ? allowed : blocked).push(host);
  }
  return { mode: access.mode, allowed, blocked };
}

export function visibleWebsite(url, access) {
  const safe = safeWebURL(url);
  return !!safe && !access?.blocked.includes(websiteHost(new URL(safe).hostname));
}

// Safari can return a real tab ID and position with both the URL and title redacted.
export function listedTabs(tabs, access, limit, protectedId = null) {
  const rows = [];
  for (const [index, tab] of tabs.entries()) {
    if (rows.length >= limit) break;
    if (!Number.isInteger(tab.id) || tab.id < 0 || tab.id === protectedId) continue;
    const active = typeof tab.active === "boolean" ? { active: tab.active } : {};
    if (!tab.url) {
      const position = Number.isInteger(tab.index) && tab.index >= 0 ? tab.index + 1 : index + 1;
      rows.push({ id: tab.id, title: "Tab " + position, url: "", needsWebsiteAccess: true, ...active });
    } else if (visibleWebsite(tab.url, access)) {
      rows.push({ id: tab.id, title: (tab.title || "Untitled").slice(0, 160), url: publicURL(tab.url), ...active });
    }
  }
  return rows;
}

// A tab listing spans websites. Only all-sites access can authorize it automatically.
export function allowsAction(access, hosts) {
  const blocked = hosts.find(host => access.blocked.includes(websiteHost(host)));
  if (blocked) throw new Error(`Browser access to ${blocked} is blocked in Website access settings.`);
  return access.mode === "auto" || (hosts.length > 0 && hosts.every(host => access.allowed.includes(websiteHost(host))));
}
