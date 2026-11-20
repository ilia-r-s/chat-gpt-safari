// Runs inside the test copy of the WebExtension. Each next call depends on
// the previous tool observation, just as a Responses function call does.
export function installCarouselProvider() {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const read = { operation: "read" };
  function* workflow() {
    let page = yield read;
    check(page.viewport.scrollY === 0 && !page.elements.some(e => e.kind === "carousel"), "Carousel must start offscreen");
    const search = yield { operation: "scroll_until", text: "carousel", direction: "down", speed: 3200 };
    check(search.found && !search.motion.active, "Scroll did not stop at the carousel");
    page = yield read;
    const galleryY = page.viewport.scrollY;
    check(galleryY > 0, "The page never scrolled to the gallery");
    for (const [before, after] of [[2,3], [3,4], [4,3], [3,2]]) {
      const gallery = page.elements.find(e => e.kind === "carousel");
      const picture = page.elements.find(e => e.label === "Offer picture " + before);
      check(gallery?.currentItem === before && picture?.bounds, "Missing slide or visible picture " + before);
      const [left, top, right, bottom] = picture.bounds;
      const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2);
      const pair = (at, dx) => ({ at, points: [{ id: 1, x: x+dx, y }, { id: 2, x: x+dx+18, y: y+4 }] });
      const swipe = yield { device: "trackpad", anchor: { x, y }, frames: [pair(0, 0), pair(150, (before-after)*110), { at: 170, points: [] }] };
      check(swipe.motion?.reason === "gesture finished", "Trackpad swipe did not finish");
      page = yield read;
      check(page.elements.find(e => e.kind === "carousel")?.currentItem === after, "Swipe failed to select slide " + after);
      check(Math.abs(page.viewport.scrollY-galleryY) <= 1, "Vertical scroll continued during a horizontal swipe");
    }
    yield { operation: "scroll", direction: "bottom" };
    page = yield read;
    check(Math.abs(page.viewport.pageHeight-page.viewport.height-page.viewport.scrollY) <= 1, "Bottom of the page was not reached");
    yield { operation: "scroll", direction: "top" };
    page = yield read;
    check(page.viewport.scrollY === 0, "Page did not return to the top");
    const pad = () => page.elements.find(e => e.label === "Sketch pad" && e.actions.includes("drag"));
    const path = points => points.map(([x,y,speed]) => ({ x: pad().bounds[0]+x, y: pad().bounds[1]+y, ...(speed && { speed }) }));
    const hover = yield { operation: "move_pointer", path: path([[25,20,160], [125,65,1200], [25,110,210], [125,155]]) };
    check(hover.motion?.reason === "path finished", "Zigzag did not finish");
    page = yield read;
    const turtle = [[42,110],[53,96],[62,68],[85,50],[111,48],[138,62],[150,83],[168,76],[183,80],[185,92],[169,98],[150,98],[143,112],[143,124],[132,132],[127,113],[83,113],[76,130],[66,134],[65,114],[48,109],[42,110]];
    const drawing = yield { operation: "drag", elementId: pad().id, speed: 640, path: path(turtle) };
    check(drawing.motion?.reason === "path finished" && drawing.motion.released, "Turtle stroke was not released");
  }
  const steps = workflow();
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: "gpt-6-sol" }] });
    check(url === "https://api.openai.com/v1/responses", "Unexpected provider endpoint");
    const body = JSON.parse(options.body);
    check(body.model === "gpt-6-sol" && body.reasoning.effort === "medium", "Unexpected Chat model");
    const observation = body.input.findLast(item => item.type === "function_call_output");
    const result = observation && JSON.parse(observation.output);
    check(!result?.error, result?.error);
    const step = steps.next(result);
    const output = step.done ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed the gallery and drawing workflow." }] }]
      : [{ type: "function_call", namespace: "safari", name: step.value.device ? "gesture" : "browser", call_id: "step-" + ++calls, arguments: JSON.stringify(step.value) }];
    return new Response("data: " + JSON.stringify({ type: "response.completed", response: { output } }) + "\n\n");
  };
}
