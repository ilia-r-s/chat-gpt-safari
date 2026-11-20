import { INPUT_ACTIONS } from "./page-input.js";

// These commands are implemented locally. Tab-level operations depend on the
// WebExtension methods exposed by this installation of Safari.
export const TAB_METHODS = { open_tab: "create", close_tab: "remove", list_tabs: "query", switch_tab: "update", navigate: "update", back: "goBack", forward: "goForward", zoom: "setZoom" };
export const PAGE_ACTIONS = ["read", "find_text", "click", "fill", "select", "set_checked", "scroll", "scroll_until", "drag", "move_pointer", "set_speed", "stop_motion", "wait_motion", ...INPUT_ACTIONS];
export const BROWSER_ACTIONS = [...PAGE_ACTIONS, ...Object.keys(TAB_METHODS)];

export function availableBrowserActions(api) {
  return BROWSER_ACTIONS.filter(action => Object.hasOwn(TAB_METHODS, action)
    ? typeof api.tabs?.[TAB_METHODS[action]] === "function"
    : typeof api.scripting?.executeScript === "function");
}
