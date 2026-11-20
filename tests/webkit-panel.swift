// Run via SAFARI_CHAT_WEBKIT=1 with tests/ui-smoke.mjs. All transport is local fixture data.
import AppKit
import WebKit

final class PanelCheck: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "passed" else {
            fputs("WebKit panel check: \(message.body)\n", stderr); exit(1)
        }
        print("System WebKit passed at 320 px: local modules, composer, tab mention, popover, Settings and dark appearance.")
        exit(0)
    }
}

guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]),
      url.scheme == "http", url.host == "127.0.0.1" else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let check = PanelCheck()
configuration.userContentController.add(check, name: "panelCheck")
let script = #"""
const $check = id => document.getElementById(id);
let reads = 0;
const prefs = { theme: "light", interactionMode: "work", pageChars: 6000, inputChars: 24000, historyTurns: 4 };
window.browser = { runtime: {
  id: "webkit-fixture", onMessage: { addListener() {} },
  sendMessage: async ({type, settings, draft}) => {
    let value;
    if (type === "bootstrap") value = { prefs, auth: { account: "fixture", label: "Fixture account", generation: "session", connected: true, canInfer: true }, models: [{id:"fixture", name:"Fixture", reasoningEfforts:["low","high"]}] };
    if (type === "tabs.list") value = [{id: 1, title: "Travel notes", url: "https://example.org/notes"}];
    if (type === "context.read") { reads++; value = { kind: "page", key: "notes", tabId: 1, title: "Travel notes", text: "Arrive at noon." }; }
    if (type === "access.change") value = { mode: "auto", allowed: [], blocked: [] };
    if (type === "settings.save") value = Object.assign(prefs, settings);
    if (type === "draft.save") value = {...draft, revision:"saved"};
    return {ok:true, value};
  }
}};
addEventListener("load", async () => {
  const report = message => window.webkit.messageHandlers.panelCheck.postMessage(message);
  const wait = async condition => {
    for (let i = 0; i < 80; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 40)); }
    throw Error("Timed out: " + condition);
  };
  try {
    await wait(() => $check("account-label").textContent === "Fixture account" && !$check("prompt").disabled);
    if (document.documentElement.scrollWidth > innerWidth) throw Error("Horizontal overflow");
    const prompt = $check("prompt");
    prompt.focus(); prompt.value = "Compare @travel"; prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    prompt.dispatchEvent(new Event("input"));
    await wait(() => !$check("tab-mentions").hidden);
    if (reads) throw Error("Suggestions read page text");
    prompt.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true, cancelable:true}));
    await wait(() => prompt.value === "Compare " && $check("attachments").textContent.includes("Travel notes"));
    if (reads !== 1) throw Error("Unexpected number of page reads");
    $check("add-button").click(); await wait(() => $check("add-menu").matches(":popover-open")); $check("add-menu").hidePopover();
    $check("model-trigger").click(); await wait(() => $check("model-popover").matches(":popover-open"));
    if (!$check("effort").getClientRects().length) throw Error("Missing composer effort control");
    $check("select-model").click(); await wait(() => $check("model-list").getClientRects().length);
    $check("model-popover").hidePopover();
    $check("actions-guidance").click(); await wait(() => $check("access-menu").matches(":popover-open"));
    $check("auto-mode").click(); await wait(() => $check("mode-label").textContent === "Approve for me");
    $check("history-button").click(); await wait(() => $check("history-dialog").open);
    $check("settings-button").click(); await wait(() => $check("settings-dialog").open);
    $check("theme-setting").value = "dark"; $check("theme-setting").dispatchEvent(new Event("change"));
    await wait(() => getComputedStyle(document.querySelector(".panel-surface")).backgroundColor === "rgb(14, 14, 14)");
    report("passed");
  } catch (error) { report(error.message); }
});
"""#
configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
let frame = NSRect(x: -10000, y: -10000, width: 320, height: 640)
let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
window.contentView = webView
window.orderFront(nil)
webView.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fputs("WebKit panel did not finish.\n", stderr); exit(1) }
app.run()
