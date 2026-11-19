import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const run = promisify(execFile);

// Only the test copy gets the deterministic provider and UI driver. WebKit
// supplies the real toolbar, script injection, framed runtime ports and storage.
function installProvider(destination) {
  let requests = 0, release;
  browser.runtime.onMessage.addListener(message => {
    if (message.type === "test.finish") { release(); return Promise.resolve(requests); }
  });
  const event = data => "data: " + JSON.stringify(data) + "\n\n";
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: "gpt-5" }] });
    if (url !== "https://api.openai.com/v1/responses") throw Error("Unexpected fixture URL");
    requests++;
    const callTool = args => {
      const call = { type: "function_call", name: "browser", call_id: "call-" + requests, arguments: JSON.stringify(args) };
      return new Response(event({ type: "response.completed", response: { output: [call] } }));
    };
    if (requests === 1) return callTool({ operation: "read" });
    if (requests === 3) return callTool({ operation: "open_tab", url: destination });
    const observation = JSON.parse(options.body).input.findLast(item => item.type === "function_call_output");
    const result = JSON.parse(observation.output);
    if (requests === 4 && result.ok && Number.isInteger(result.tabId)) return callTool({ operation: "read", tabId: result.tabId });
    if (requests === 5 && result.text?.includes("Workflow step Two") && result.url === destination) {
      return new Response(event({ type: "response.output_text.delta", delta: "Read the second website." }) + event({ type: "response.completed", response: { output: [] } }));
    }
    if (requests !== 2 || !result.text?.includes("Workflow step One")) throw Error("Unexpected fixture tool output: " + JSON.stringify(result));
    return new Response(new ReadableStream({ start(controller) {
      const send = data => controller.enqueue(new TextEncoder().encode(event(data)));
      send({ type: "response.output_text.delta", delta: "First half" });
      release = () => {
        send({ type: "response.output_text.delta", delta: " and last half." });
        send({ type: "response.completed", response: { output: [] } });
        controller.close();
      };
    } }));
  };
}

async function drivePanel() {
  const native = (type, extra) => browser.runtime.sendNativeMessage("org.safarichat.app", { type, ...extra });
  const wait = async (condition, description) => {
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Timed out waiting for " + description + ". Panel: " + document.body.innerText.slice(0, 900));
  };
  const el = id => document.getElementById(id);
  const draft = "Remember my follow-up.";
  function type(text) { el("prompt").value = text; el("prompt").dispatchEvent(new Event("input")); }
  try {
    const phase = await native("test.phase");
    await wait(() => !el("prompt").disabled && el("model").value, "the connected composer");
    if (phase === 1) { type("Read this page."); el("composer").requestSubmit(); }
    if (phase < 3) {
      await wait(() => !el("approval").hidden, "the read approval");
      if (phase === 1) { type(draft); await native("test.reload"); return; }
      if (el("prompt").value !== draft) throw Error("The follow-up draft was lost.");
      el("approve-button").click();
    }
    if (phase <= 3) {
      await wait(() => el("messages").innerText.includes("First half") && !el("stop-button").hidden, "the partial reply");
      if (phase === 2) { await native("test.reload"); return; }
      if (phase !== 3 || el("prompt").value !== draft) throw Error("Unexpected reload or draft.");
      if (await browser.runtime.sendMessage({ type: "test.finish" }) !== 2) throw Error("The approved task was replayed.");
      await wait(() => el("stop-button").hidden && el("messages").innerText.includes("First half and last half."), "the complete reply");
      el("actions-guidance").click(); el("auto-mode").click();
      await wait(() => el("mode-label").textContent === "Approve for me", "automatic actions");
      type("Open the second website in another tab, and read it."); el("composer").requestSubmit();
    }
    await wait(() => !el("approval").hidden && el("approve-button").textContent.includes("Safari"), "the destination's Safari permission");
    if (!el("approval-title").textContent.includes("localhost") || !el("approval-more").hidden) throw Error("Wrong website permission prompt");
    if (phase === 3) { await native("test.reload"); return; }
    const button = el("approve-button").getBoundingClientRect();
    await native("test.clickPermission", { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Read the second website."), "the background tab read");
    await native("test.done");
  } catch (error) { await native("test.fail", { error: error.message }); }
}

export async function testWebKitDock(origin) {
  const version = (await run("sw_vers", ["-productVersion"])).stdout.split(".").map(Number);
  if (version[0] < 15 || (version[0] === 15 && version[1] < 4)) return;
  const folder = await mkdtemp(path.resolve("build/webkit-dock-"));
  try {
    const ext = path.join(folder, "extension");
    await cp("extension", ext, { recursive: true });
    const manifestPath = path.join(ext, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.background.scripts.unshift("provider-fixture.js");
    const destination = new URL("/__workflow/two", origin);
    destination.hostname = "localhost";
    await writeFile(path.join(ext, "provider-fixture.js"), "(" + installProvider.toString() + ")(" + JSON.stringify(destination.href) + ");");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const panelPath = path.join(ext, "panel/panel.html");
    await writeFile(panelPath, (await readFile(panelPath, "utf8")).replace("</body>", '<script type="module" src="driver-fixture.js"></script></body>'));
    await writeFile(path.join(ext, "panel/driver-fixture.js"), "(" + drivePanel.toString() + ")();");
    const host = path.join(folder, "check");
    await run("xcrun", ["clang", "-fmodules", "-fmodules-cache-path=.cache/clang", "-fobjc-arc", "-framework", "AppKit", "-framework", "WebKit", "tests/webkit-dock.m", "-o", host]);
    const { stdout } = await run(host, [ext, origin + "/__workflow/one"], { timeout: 50000 });
    process.stdout.write(stdout);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
