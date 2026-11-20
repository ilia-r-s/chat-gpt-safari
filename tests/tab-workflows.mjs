// The provider only chooses actions. Real WebExtension calls select tabs, read
// sites, and dispatch input. Each yield receives the preceding tool result.
export function installTabProvider(workflow, destination) {
  const event = value => "data: " + JSON.stringify(value) + "\n\n";
  const steps = workflow(destination);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-6-sol" }] });
    if (!url.endsWith("/responses")) throw Error("Unexpected provider request");
    const output = JSON.parse(options.body).input.findLast(item => item.type === "function_call_output");
    const result = output && JSON.parse(output.output);
    const { value } = await steps.next(result);
    if (typeof value === "string") {
      return new Response(event({ type: "response.output_text.delta", delta: value }) + event({ type: "response.completed", response: { output: [] } }));
    }
    if (!value?.operation) throw Error("Unexpected repeated browser action");
    return new Response(event({ type: "response.completed", response: { output: [
      { type: "function_call", name: "browser", call_id: "tab-" + ++calls, arguments: JSON.stringify(value) },
    ] } }));
  };
}

export async function* paintWorkflow(destination) {
  const opened = yield { operation: "open_tab", url: destination };
  const paint = opened.tabId;
  if (!Number.isInteger(paint) || (await browser.tabs.get(paint)).active) throw Error("Paint should initially be in the background");
  const page = yield { operation: "read", tabId: paint };
  const pad = page.elements?.find(item => item.label === "Paint canvas");
  const [visibility] = await browser.scripting.executeScript({ target: { tabId: paint }, func: () => document.visibilityState });
  if (!pad || visibility.result !== "hidden") throw Error("The initial read did not reach the hidden canvas");
  const [left, top] = pad.bounds;
  const vertices = [[30,140],[30,65],[90,20],[150,65],[150,140],[30,140]];
  const length = vertices.slice(1).reduce((sum, [x,y], i) => sum + Math.hypot(x - vertices[i][0], y - vertices[i][1]), 0);
  const path = vertices.map(([x,y], i) => ({ x: left+x, y: top+y, speed: i ? null : length / 10 }));
  const receipt = yield { operation: "drag", tabId: paint, elementId: pad.id, path };
  if (receipt.motion?.reason !== "path finished" || !receipt.motion.released) throw Error("The drawing did not finish: " + JSON.stringify(receipt));
  const [drawing] = await browser.scripting.executeScript({ target: { tabId: paint }, func: () => {
    const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
    const ink = [[30,100],[90,20],[150,100],[90,140]].every(([x,y]) => ctx.getImageData(x,y,1,1).data[3] > 0);
    return { ...canvas.dataset, ink, visible: !document.hidden, duplicateDock: !!document.querySelector("#safari-chat-host") };
  } });
  const { presses, releases, elapsed, ink, visible, duplicateDock } = drawing.result;
  if (!ink || !visible || duplicateDock || presses !== "1" || releases !== "1" || !(elapsed >= 9400 && elapsed < 18000)) throw Error("Wrong ink, duration or tab: " + JSON.stringify(drawing.result));
  yield "Finished drawing in Paint.";
  const tabs = yield { operation: "list_tabs" };
  const source = tabs.find(tab => tab.active)?.tabId;
  if (tabs.length !== 2 || !Number.isInteger(source) || source === paint) throw Error("Chat should be visible after drawing");
  const shown = yield { operation: "switch_tab", tabId: paint };
  if (!shown.active || !(await browser.tabs.get(paint)).active) throw Error("Explicit selection did not show Paint");
  const back = yield { operation: "switch_tab", tabId: source };
  if (!back.active || !(await browser.tabs.get(source)).active) throw Error("Switching back did not show the source");
  return "Switched to Paint and back.";
}

export async function* financeWorkflow(destination) {
  const opened = yield { operation: "open_tab", url: destination };
  const tabId = opened.tabId;
  const page = yield { operation: "read", tabId };
  const field = page.elements?.find(item => item.label === "Search quotes");
  if (!field || (await browser.tabs.get(tabId)).active) throw Error("Expected a searchable inactive finance tab");
  const changes = [];
  const record = (id, change) => { if (id === tabId) changes.push(change); };
  browser.tabs.onUpdated.addListener(record);
  const focused = yield { operation: "click", elementId: field.id, tabId };
  browser.tabs.onUpdated.removeListener(record);
  if (!focused.ok) throw Error("Could not focus the search field: " + JSON.stringify({ focused, changes, tab: await browser.tabs.get(tabId) }));
  const typed = yield { operation: "type_text", text: "EXMP", tabId };
  if (typed.typed !== 4) throw Error("Could not type the full symbol: " + JSON.stringify(typed));
  const entered = yield { operation: "press_key", text: "Enter", tabId };
  if (entered.error) throw Error("Submission failed: " + entered.error);
  const stale = yield { operation: "click", elementId: field.id, tabId };
  if (!/read/i.test(stale.error || "")) throw Error("The old field should produce an actionable error after navigation");
  const result = yield { operation: "read", tabId };
  if (!result.url?.includes("/__workflow/quote") || !result.text?.includes("Example Company") || !result.text.includes("123.45")) throw Error("Missing evidence from the quote result: " + JSON.stringify(result));
  const closed = yield { operation: "close_tab", tabId };
  if (!closed.ok) throw Error("Could not close the quote tab");
  const tabs = yield { operation: "list_tabs" };
  if (tabs.length !== 1 || !tabs[0].active || tabs[0].tabId === tabId) throw Error("Wrong tab remained open");
  return "Example Company was quoted at 123.45 in the fixture. The finance tab is closed.";
}
