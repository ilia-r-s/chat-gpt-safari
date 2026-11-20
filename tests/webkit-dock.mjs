import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { installCarouselProvider } from "./carousel-workflow.mjs";
import { installTabProvider, paintWorkflow, financeWorkflow } from "./tab-workflows.mjs";
import { serveWorkflow } from "./workflow-pages.mjs";
const run = promisify(execFile);

// Only the test copy gets the deterministic provider and UI driver. WebKit
// supplies the real toolbar, script injection, framed runtime ports and storage.
function installProvider(destination, manualTab) {
  let requests = manualTab ? 32 : 0, release, scrollingTab, initialY, fieldID;
  browser.runtime.onMessage.addListener(message => {
    if (message.type === "test.finish") { release(); return Promise.resolve(requests); }
  });
  const event = data => "data: " + JSON.stringify(data) + "\n\n";
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: "gpt-6-sol" }] });
    if (url !== "https://api.openai.com/v1/responses") throw Error("Unexpected fixture URL");
    requests++;
    const callTool = (args, name = "browser") => {
      const call = { type: "function_call", name, call_id: "call-" + requests, arguments: JSON.stringify(args) };
      return new Response(event({ type: "response.completed", response: { output: [call] } }));
    };
    if (requests === 1) return callTool({ operation: "read" });
    if (requests === 3) return callTool({ operation: "open_tab", url: destination });
    if (requests === 33) return callTool({operation:"list_tabs"});
    if ([6,9,14,17,30,37,45].includes(requests)) return callTool({ operation: "read" });
    const observation = JSON.parse(options.body).input.findLast(item => item.type === "function_call_output");
    const result = JSON.parse(observation.output);
    if (requests === 47 || requests === 49) {
      if (result.motion?.reason !== "gesture finished") throw Error("WebKit gesture failed: " + JSON.stringify(result));
      if (requests === 49) {
        const [count] = await browser.scripting.executeScript({target:{tabId:scrollingTab},func:()=>document.body.dataset.contactCount});
        if (count.result !== "3") throw Error("WebKit touch delivery: " + JSON.stringify(result.motion));
      }
      return callTool({operation:"read"});
    }
    if (requests === 4 && result.ok && Number.isInteger(result.tabId)) return callTool({ operation: "read", tabId: result.tabId });
    if (requests === 5 && result.text?.includes("Workflow step Two") && result.url === destination) {
      return new Response(event({ type: "response.output_text.delta", delta: "Read the second website." }) + event({ type: "response.completed", response: { output: [] } }));
    }
    if (requests === 7) {
      const button = result.elements.find(item => item.label === "Page help");
      const [instrumented] = await browser.scripting.executeScript({ target: { tabId: result.tabId }, func: () => {
        const button = document.querySelector("button");
        button.addEventListener("click", () => {
          const box = globalThis.__safariChatActionPointer?.position.getBoundingClientRect();
          const hit = box && document.elementFromPoint(box.left + 3, box.top + 3);
          button.dataset.pointerHit = String(!!hit && button.contains(hit));
        }, { once: true });
        return !!globalThis.__safariChatActionPointer?.host.isConnected;
      } });
      if (!instrumented.result) throw Error("No WebKit pointer after the page read.");
      return callTool({ operation: "click", elementId: button.id });
    }
    if (requests === 8 && result.ok) return new Response(event({ type: "response.output_text.delta", delta: "Opened page help." }) + event({ type: "response.completed", response: { output: [] } }));
    if (requests === 10) {
      scrollingTab = result.tabId; initialY = result.viewport.scrollY;
      return callTool({ operation: "scroll", direction: "down", speed: 173.25 });
    }
    if (requests === 11 && result.motion?.speed === 173.25) {
      const deadline = Date.now() + 2500;
      const position = async () => (await browser.scripting.executeScript({ target: { tabId: scrollingTab }, func: () => scrollY }))[0].result;
      while (await position() < initialY + 10) {
        if (Date.now() >= deadline) throw Error("WebKit did not physically scroll.");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return callTool({ operation: "set_speed", speed: 937.125 });
    }
    if (requests === 12 && result.motion?.speed === 937.125) return callTool({ operation: "wait_motion" });
    if (requests === 13 && result.motion?.reason === "stopped by user") {
      const position = async () => (await browser.scripting.executeScript({ target: { tabId: scrollingTab }, func: () => scrollY }))[0].result;
      const stopped = await position();
      await new Promise(resolve => setTimeout(resolve, 180));
      if (stopped === initialY || stopped !== await position()) throw Error("WebKit moved after Stop scrolling.");
      return new Response(event({ type: "response.output_text.delta", delta: "Stopped scrolling." }) + event({ type: "response.completed", response: { output: [] } }));
    }
    if (requests === 15) {
      const pad = result.elements.find(item => item.label === "Sketch pad");
      const [x, y] = pad.bounds;
      return callTool({ operation: "drag", elementId: pad.id, path: [[10,10,180.25], [70,40,426.75], [25,60,700], [110,25,null]].map(([dx,dy,speed]) => ({ x: x+dx, y: y+dy, speed })) });
    }
    if (requests === 16 && result.motion?.released && result.motion.waypoint === 3) return new Response(event({ type: "response.output_text.delta", delta: "Finished the stroke." }) + event({ type: "response.completed", response: { output: [] } }));
    if (requests >= 18 && requests <= 29) {
      if (result.error || result.ok === false) throw Error("WebKit input failed at request " + requests + ": " + JSON.stringify(result));
      if (requests === 18) return callTool({ operation: "double_click", elementId: result.elements.find(el => el.label === "Double target").id });
      if (requests === 19 || requests === 26) return callTool({ operation: "read" });
      if (requests === 20) { fieldID = result.elements.find(el => el.label === "Notes").id; return callTool({ operation: "click", elementId: fieldID }); }
      if (requests === 21) return callTool({ operation: "type_text", text: "Hi" });
      if (requests === 22) return callTool({ operation: "select_text", elementId: fieldID, text: "Hi" });
      if (requests === 23) return callTool({ operation: "copy" });
      if (requests === 24) return callTool({ operation: "replace_selection", text: "Yes" });
      if (requests === 25 || requests === 28) return callTool({ operation: "paste" });
      if (requests === 27) return callTool({ operation: "select_text", text: "beta" });
      return new Response(event({ type: "response.output_text.delta", delta: "Finished the text edits." }) + event({ type: "response.completed", response: { output: [] } }));
    }
    if (requests === 31) {
      const path = [{x:158,y:91,speed:180.5}, {x:48,y:121,speed:860.25}, {x:119,y:146,speed:null}];
      await browser.scripting.executeScript({ target: { tabId: result.tabId }, args: [path], func: points => {
        let next = 0;
        const record = e => {
          if (e.isTrusted) return;
          if (e.type !== "pointermove" || e.buttons !== 0) { document.body.dataset.hover = "pressed"; return; }
          if (points[next]?.x === e.clientX && points[next].y === e.clientY) {
            next++;
            if (next === points.length && !document.body.dataset.hover) document.body.dataset.hover = "complete";
          }
        };
        for (const name of ["pointermove","pointerdown","pointerup","click"]) document.addEventListener(name, record);
      } });
      return callTool({ operation:"move_pointer", elementId:null, path });
    }
    if (requests === 32 && result.motion?.reason === "path finished") return new Response(event({type:"response.output_text.delta",delta:"Finished moving the pointer."}) + event({type:"response.completed",response:{output:[]}}));
    if (requests === 34) {
      const hidden = result.find(tab => tab.needsWebsiteAccess);
      if (result.length !== 2 || hidden?.title !== "Tab 2" || hidden.url) throw Error("Missing redacted tab: " + JSON.stringify(result));
      return callTool({operation:"read",tabId:hidden.tabId});
    }
    if (requests === 35 && result.text?.includes("Manually opened Yahoo fixture") && !result.text.includes("announces a concert"))
      return callTool({ operation: "find_text", text: "Taylor Swift", tabId: result.tabId });
    if (requests === 36 && result.found && result.excerpt.includes("announces a concert")) {
      const [field] = await browser.scripting.executeScript({ target: { tabId: result.tabId }, func: () => document.querySelector("input").value });
      if (field.result !== "Tailor Swift") throw Error("Find on page changed the site's search field.");
      return new Response(event({type:"response.output_text.delta",delta:"Read the manually opened tab."}) + event({type:"response.completed",response:{output:[]}}));
    }
    if (requests === 38) {
      scrollingTab = result.tabId;
      return callTool({ operation: "scroll_until", direction: "down", text: "carousel", speed: 4500 });
    }
    if (requests === 39 && result.found && !result.motion.active) {
      const position = async () => (await browser.scripting.executeScript({ target: { tabId: scrollingTab }, func: () => scrollY }))[0].result;
      const stopped = await position(); await new Promise(resolve => setTimeout(resolve, 250));
      if (stopped !== await position()) throw Error("WebKit overshot the gallery while the model was thinking.");
      return callTool({ operation: "read" });
    }
    if (requests === 40 || requests === 42) {
      const gallery = result.elements.find(item => item.kind === "carousel");
      if (gallery?.currentItem !== (requests === 40 ? 3 : 2)) throw Error("Unexpected carousel position.");
      return callTool({ operation: "scroll", elementId: gallery.id, direction: "left" });
    }
    if ([41,43].includes(requests) && result.dispatched) return callTool({ operation: "read" });
    if (requests === 44 && result.elements.find(item => item.kind === "carousel")?.currentItem === 1)
      return new Response(event({type:"response.output_text.delta",delta:"Moved the carousel two slides left."}) + event({type:"response.completed",response:{output:[]}}));
    if (requests === 46) {
      const y = 110;
      const pair = (at, x1, y1, x2, y2) => ({ at, points: [{id:1,x:x1,y:y1},{id:2,x:x2,y:y2}] });
      return callTool({device:"trackpad",anchor:{x:65,y},frames:[pair(0,110,y,150,y),pair(140,50,y,90,y),pair(260,70,y-35,70,y+35),{at:285,points:[]}]}, "gesture");
    }
    if (requests === 48) return callTool({device:"touch", frames:[{at:0,points:[{id:1,x:50,y:100},{id:2,x:75,y:105},{id:3,x:95,y:110}]},{at:100,points:[]}]}, "gesture");
    if (requests === 50) return callTool({device:"wheel",anchor:{x:65,y:110},discrete:true,deltaMode:"line",frames:[{at:0},{at:90,deltaX:3,deltaY:1}]}, "gesture");
    if (requests === 51) {
      const [read] = await browser.scripting.executeScript({target:{tabId:scrollingTab},func:()=>({...document.body.dataset})});
      if (result.motion?.reason !== "gesture finished" || Number(read.result.wheel) !== 3 || read.result.contactCount !== "3" ||
          !(Number(read.result.scale) > 1.6 && Number(read.result.rotation) > 85)) throw Error("WebKit gesture delivery: " + JSON.stringify({result,read}));
      return new Response(event({type:"response.output_text.delta",delta:"Delivered the trackpad sequence."}) + event({type:"response.completed",response:{output:[]}}));
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

async function drivePanel(scenario) {
  const native = (type, extra) => browser.runtime.sendNativeMessage("org.safarichat.app", { type, ...extra });
  const wait = async (condition, description, timeout = 9000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Timed out waiting for " + description + ". Panel: " + document.body.innerText.slice(0, 900));
  };
  const el = id => document.getElementById(id);
  const draft = "Remember my follow-up.";
  function type(text) { el("prompt").value = text; el("prompt").dispatchEvent(new Event("input")); }
  async function readManualTabAndFindGallery() {
    await wait(() => !el("approval").hidden && el("approval-title").textContent === "Read Tab 2?", "the manually opened tab");
    el("approve-button").click();
    await wait(() => el("tab-access-dialog").open, "exact-site permission for a hidden address");
    el("tab-address").value = "http://localhost";
    const allow = el("tab-access-allow").getBoundingClientRect();
    await native("test.clickPermission", { x:allow.x + allow.width / 2, y:allow.y + allow.height / 2 });
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Read the manually opened tab."), "reading the same manually opened tab");
    type("Find the carousel and swipe left twice."); el("composer").requestSubmit();
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Moved the carousel two slides left."), "stopping at the carousel and using its controls");
    type("Pan, pinch and rotate over the page."); el("composer").requestSubmit();
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Delivered the trackpad sequence."), "scripted trackpad events reaching WebKit page listeners");
    await native("test.done");
  }
  try {
    const phase = await native("test.phase");
    await wait(() => !el("prompt").disabled && el("model-name").textContent === "GPT-6", "the connected composer");
    if (scenario === "paint" || scenario === "finance") {
      await native("test.showSource"); el("actions-guidance").click(); el("auto-mode").click();
      await wait(() => el("mode-label").textContent === "Approve for me", "automatic actions");
      type(scenario === "paint" ? "Open Paint in another tab and draw a house for ten seconds." : "Open the finance site, look up EXMP and close its tab."); el("composer").requestSubmit();
      await wait(() => !el("approval").hidden && el("approve-button").textContent.includes("Safari"), "access to the new website");
      const allow = el("approve-button").getBoundingClientRect();
      await native("test.clickPermission", { x: allow.x + allow.width / 2, y: allow.y + allow.height / 2 });
      if (scenario === "finance") {
        await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Example Company was quoted at 123.45"), "the quote and closed finance tab", 25000);
        const details = el("messages").querySelector("details");
        if (!details || !/read/i.test(details.textContent) || !/click/i.test(details.textContent)) throw Error("The failed stale click should be visible in Action details.");
        await native("test.done"); return;
      }
      await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Finished drawing in Paint."), "the completed drawing and restored chat", 30000);
      el("actions-guidance").click(); el("ask-mode").click();
      await wait(() => el("mode-label").textContent === "Ask for approval", "per-action approval");
      type("Switch to Paint and back to this tab."); el("composer").requestSubmit();
      let approvals = 0;
      await wait(() => {
        if (!el("approval").hidden && !el("approve-button").disabled && !document.hidden) {
          el("approve-button").click(); approvals++;
        }
        return el("stop-button").hidden && el("messages").innerText.includes("Switched to Paint and back.");
      }, "three approvals in the visible source tab");
      if (approvals !== 3) throw Error("Expected one visible approval for the listing and each explicit switch, got " + approvals);
      await native("test.done"); return;
    }
    if (scenario === "carousel") {
      if (el("chat-mode").getAttribute("aria-pressed") !== "true") throw Error("Fresh profile did not start in Chat");
      await native("test.showSource"); el("actions-guidance").click(); el("auto-mode").click();
      await wait(() => el("mode-label").textContent === "Approve for me", "the composer approval setting");
      type("Find the carousel. Swipe left twice and right twice, go to the bottom and back to the top, move in a zigzag at varying speeds, then draw a turtle in one stroke.");
      el("composer").requestSubmit();
      await wait(() => !el("stop-button").hidden, "the browser workflow to start");
      for (let i = 0; i < 600 && !el("stop-button").hidden; i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!el("messages").innerText.includes("Completed the gallery and drawing workflow.")) throw Error(el("messages").innerText);
      if (el("actions-left").textContent !== "100/100 browser actions left") throw Error("Action allowance did not reset");
      await native("test.done"); return;
    }
    if (scenario === "tabs") {
      await native("test.showSource");
      await native("test.manualTab");
      el("actions-guidance").click(); el("auto-mode").click();
      await wait(() => el("mode-label").textContent === "Approve for me", "automatic tab listing");
      type("Which tabs do you see, and what is in the second one?"); el("composer").requestSubmit();
      await readManualTabAndFindGallery();
      return;
    }
    if (phase === 1) { type("Read this page."); el("composer").requestSubmit(); }
    if (phase < 3) {
      await wait(() => !el("approval").hidden, "the read approval");
      if (!el("actions-left").textContent.startsWith("99/100 ")) throw Error("The pending read did not retain its counter.");
      if (phase === 1) { type(draft); await native("test.reload"); return; }
      if (el("prompt").value !== draft) throw Error("The follow-up draft was lost.");
      el("approve-button").click();
    }
    if (phase <= 3) {
      await wait(() => el("messages").innerText.includes("First half") && !el("stop-button").hidden, "the partial reply");
      if (phase === 2) { await native("test.followLink"); return; }
      if (phase !== 3 || el("prompt").value !== draft) throw Error("Unexpected reload or draft.");
      await native("test.earlyRestore");
      if (await browser.runtime.sendMessage({ type: "test.finish" }) !== 2) throw Error("The approved task was replayed.");
      await wait(() => el("stop-button").hidden && el("messages").innerText.includes("First half and last half."), "the complete reply");
      el("actions-guidance").click(); el("auto-mode").click();
      await wait(() => el("mode-label").textContent === "Approve for me", "automatic actions");
      type("Open the second website in another tab, and read it."); el("composer").requestSubmit();
    }
    await wait(() => !el("approval").hidden && el("approve-button").textContent.includes("Safari"), "the destination's Safari permission");
    if (!el("approval-title").textContent.includes("localhost") || !el("approval-more").hidden) throw Error("Wrong website permission prompt in phase " + phase + ": " + el("approval").innerText);
    if (phase === 3) { await native("test.reload"); return; }
    const button = el("approve-button").getBoundingClientRect();
    await native("test.clickPermission", { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Read the second website."), "the background tab read");
    await native("test.showSource");
    type("Click Page help on this page."); el("composer").requestSubmit();
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Opened page help."), "the visible page click");
    type("Scroll continuously, speed up, and keep going until I stop it."); el("composer").requestSubmit();
    await wait(() => !el("motion-controls").hidden && el("motion-speed").valueAsNumber === 937.125, "variable-speed continuous scrolling");
    el("motion-speed").value = "0"; el("motion-speed").dispatchEvent(new Event("change"));
    await wait(() => el("motion-status").textContent.includes("Paused"), "the zero-speed pause");
    el("motion-speed").value = "361.75"; el("motion-speed").dispatchEvent(new Event("change"));
    await wait(() => !el("motion-status").textContent.includes("Paused"), "the live decimal speed change");
    el("stop-motion").click();
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Stopped scrolling."), "manual scroll stop");
    if (!el("actions-left").textContent.startsWith("100/100 ")) throw Error("The allowance did not reset after the scrolling turn.");
    await native("test.sketch");
    el("actions-guidance").click(); el("ask-mode").click();
    await wait(() => el("mode-label").textContent === "Ask for approval", "one-time approvals");
    type("Draw a zigzag with changing speeds on the sketch pad."); el("composer").requestSubmit();
    await wait(() => !el("approval").hidden && el("approval-title").textContent === "Read this page?", "the sketch read approval");
    el("approve-button").click();
    await wait(() => !el("approval-path").hidden, "the drag path preview");
    if (el("approval-path").querySelector("polyline").points.length !== 4) throw Error("Wrong approved path preview.");
    el("approve-button").click();
    await wait(() => el("stop-button").hidden && el("messages").innerText.includes("Finished the stroke."), "the drawing gesture");
    if (!el("actions-left").textContent.startsWith("100/100 ")) throw Error("The allowance did not reset after the drawing turn.");
    await native("test.input");
    type("Double-click the item, type into Notes, copy a selection and paste it into the paragraph."); el("composer").requestSubmit();
    await wait(() => {
      if (!el("approval").hidden) el("approve-button").click();
      return el("stop-button").hidden && el("messages").innerText.includes("Finished the text edits.");
    }, "keyboard and clipboard input through the extension");
    type("Move over the sketch in a zigzag without clicking."); el("composer").requestSubmit();
    await wait(() => {
      if (!el("approval").hidden) el("approve-button").click();
      return el("stop-button").hidden && el("messages").innerText.includes("Finished moving the pointer.");
    }, "a freely moving pointer with its button up");
    await native("test.done");
  } catch (error) { await native("test.fail", { error: error.message }); }
}

const workflows = ["tabs", "navigation", "carousel", "paint", "finance"];

export async function testWebKitDock(origin, scenarios = workflows) {
  for (const scenario of scenarios) if (!workflows.includes(scenario)) throw Error("Unknown WebKit workflow: " + scenario);
  const version = (await run("sw_vers", ["-productVersion"])).stdout.split(".").map(Number);
  if (version[0] < 15 || (version[0] === 15 && version[1] < 4)) { console.log("WebKit workflows skipped. WKWebExtensionController requires macOS 15.4 or later."); return; }
  await mkdir("build", { recursive: true });
  const folder = await mkdtemp(path.resolve("build/webkit-dock-"));
  try {
    const ext = path.join(folder, "extension");
    await cp("extension", ext, { recursive: true });
    const manifestPath = path.join(ext, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.background.scripts.unshift("provider-fixture.js");
    const destination = new URL("/__workflow/two", origin);
    destination.hostname = "localhost";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const panelPath = path.join(ext, "panel/panel.html");
    await writeFile(panelPath, (await readFile(panelPath, "utf8")).replace("</body>", '<script type="module" src="driver-fixture.js"></script></body>'));
    const host = path.join(folder, "check");
    await run("xcrun", ["clang", "-fmodules", "-fmodules-cache-path=.cache/clang", "-fobjc-arc", "-framework", "AppKit", "-framework", "WebKit", "tests/webkit-dock.m", "-o", host]);
    for (const scenario of scenarios) {
      let provider = `(${installProvider})(${JSON.stringify(destination.href)}, ${scenario === "tabs"});`;
      if (scenario === "carousel") provider = `(${installCarouselProvider})();`;
      if (scenario === "paint" || scenario === "finance") provider = `(${installTabProvider})(${scenario === "paint" ? paintWorkflow : financeWorkflow}, ${JSON.stringify(new URL("/__workflow/" + scenario, destination).href)});`;
      await writeFile(path.join(ext, "provider-fixture.js"), provider);
      await writeFile(path.join(ext, "panel/driver-fixture.js"), `(${drivePanel})(${JSON.stringify(scenario)});`);
      const start = origin + "/__workflow/" + ({ carousel: "carousel", paint: "paint-source", finance: "finance-source", tabs: "one?slow-resource", navigation: "one" })[scenario];
      const { stdout } = await run(host, [ext, start], { timeout: 90000 });
      process.stdout.write(stdout);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// No provider credentials or Playwright installation are needed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer(async (req, res) => {
    if (!await serveWorkflow(req, res)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await testWebKitDock("http://127.0.0.1:" + server.address().port, process.argv.length > 2 ? process.argv.slice(2) : workflows); }
  finally { server.close(); }
}
