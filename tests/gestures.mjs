import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { MotionSession } from "../extension/core/motion-session.js";

export async function testGestures(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 800, height: 650 } });
  try {
    await page.goto(origin + "/__workflow/one");
    await page.setContent('<style>body{margin:0}#pad{width:420px;height:240px;touch-action:none}#pan{height:80px;width:240px;overflow:auto}#pan div{width:800px;height:400px}#grab,#drop{display:inline-block;width:100px;height:60px}</style><canvas id="pad" aria-label="Surface"></canvas><div id="pan"><div></div></div><div id="grab" draggable="true">Grab</div><div id="drop">Drop</div><input type="password">');
    await page.evaluate(() => {
      window.log = [];
      const pad = document.getElementById("pad");
      for (const type of ["wheel", "touchstart", "touchend", "pointerdown", "pointerup", "pointermove", "pointercancel", "contextmenu", "click", "dblclick"]) {
        pad.addEventListener(type, e => {
          window.log.push({ type, x:e.clientX, y:e.clientY, dx:e.deltaX, dy:e.deltaY, dz:e.deltaZ, mode:e.deltaMode, ctrl:e.ctrlKey, shift:e.shiftKey, pressure:e.pressure, tilt:e.tiltX, count:e.touches?.length, button:e.button, buttons:e.buttons });
          if (type === "wheel") e.preventDefault();
        }, { passive:false });
      }
      document.getElementById("grab").ondragstart = e => e.dataTransfer.setData("text/plain", "Card");
      const drop = document.getElementById("drop");
      drop.ondragover = e => e.preventDefault(); drop.ondrop = e => { e.preventDefault(); drop.textContent = e.dataTransfer.getData("text/plain"); };
    });
    const api = { tabs: { get: async id => ({ id, url:page.url(), active:true, status:"complete" }) }, scripting: {
      executeScript: async ({ func, args = [] }) => [{ result: await page.evaluate(({ code, args }) => eval("(" + code + ")")(...args), { code:func.toString(), args }) }],
    } };
    const controller = new AbortController(), approvals = [], motionSession = new MotionSession(api, () => {});
    const call = createBrowserTools({ api, pageChars:6000, defaultTabId:1, motionSession, approve: async request => { approvals.push(request); } });
    const tool = args => call(args, controller.signal);
    const gesture = async (device, frames, extra) => { await tool({operation:"read"}); return tool({ operation:"gesture", device, frames, ...extra }); };
    const p = (id,x,y,more) => ({id,x,y,...more});
    const f = (at, ...points) => ({at,points});
    const pair = (at,x,y) => f(at,p(1,x,y),p(2,x+30,y));
    const result = await gesture("trackpad", [pair(0,170,50),pair(80,160,50),pair(150,70,55),f(165)], { anchor:{x:110,y:60} });
    assert.equal(result.motion.reason,"gesture finished");
    const wheels = await page.evaluate(() => log.filter(e => e.type === "wheel"));
    assert.ok(wheels.length > 2 && wheels.every(e => e.x === 110 && e.y === 60 && !e.ctrl));
    assert.ok(Math.abs(wheels.reduce((n,e) => n + e.dx,0) - 100) < 0.01);
    assert.ok(result.motion.prevented > 0);
    await page.evaluate(() => log.length = 0);
    const anchor = { x: 145, y: 55 };
    const swept = await gesture("wheel", [{ at:0 },{ at:75, deltaX:38, deltaY:-18 },{ at:160, deltaX:-10, deltaZ:4 }], { anchor });
    assert.ok(swept.motion.wheelEvents > 2);
    const diagonal = await page.evaluate(() => log.filter(e => e.type === "wheel"));
    for (const [axis, expected] of [["dx",28],["dy",-18],["dz",4]]) assert.ok(Math.abs(diagonal.reduce((sum,e) => sum + e[axis],0) - expected) < .01);
    assert.ok(diagonal.every(e => e.x === anchor.x && e.y === anchor.y));
    await page.evaluate(() => log.length = 0);
    await gesture("wheel", [{ at:0 },{ at:50,deltaY:2,modifiers:["Shift"] },{ at:120,deltaY:-1,modifiers:[] }], { anchor, deltaMode:"line", discrete:true });
    assert.deepEqual(await page.evaluate(()=>log.filter(e=>e.type==="wheel").map(e=>[e.dy,e.mode,e.shift])), [[2,1,true],[-1,1,false]]);
    const pan = await gesture("trackpad", [pair(0,175,260),pair(100,80,260),f(120)], {anchor:{x:140,y:270}});
    assert.ok(pan.motion.scrollX >= 85);
    assert.ok(await page.locator("#pan").evaluate(el=>el.scrollLeft > 85));
    const turn = [pair(0,70,90),f(95,p(1,60,65),p(2,60,135)),f(115)];
    const transformed = await gesture("trackpad", turn);
    assert.ok(transformed.motion.scale > 2 && Math.abs(transformed.motion.rotation-90) < 0.1);
    await gesture("touch", [pair(0,30,40),f(90,p(1,50,40),p(2,80,80),p(3,90,30)),f(170,p(3,77,33)),f(190)]);
    assert.deepEqual(await page.evaluate(() => log.filter(e => e.type === "touchstart").map(e=>e.count)),[2,3]);
    assert.deepEqual(await page.evaluate(() => log.filter(e => e.type === "touchend").map(e=>e.count)),[1,0]);
    assert.equal(await page.evaluate(() => log.filter(e => e.type === "click").length),0);
    await gesture("pen",[f(0,p(4,50,80,{pressure:0.25,tiltX:20})),f(120,p(4,70,90,{pressure:0.8,tiltX:45})),f(130)]);
    assert.ok(await page.evaluate(() => log.some(e => e.type==="pointermove" && e.pressure > 0.75 && e.tilt===45)));
    await gesture("mouse",[f(0,p(3,50,55,{buttons:2})),f(70),f(100,p(3,40,35,{buttons:1})),f(120),f(170,p(3,40,35,{buttons:1})),f(190)]);
    assert.equal(await page.evaluate(()=>log.filter(e=>e.type==="contextmenu").length),1);
    assert.equal(await page.evaluate(()=>log.filter(e=>e.type==="dblclick").length),1);
    await page.evaluate(() => log.length = 0);
    await gesture("mouse",[f(0,p(3,40,35,{buttons:3})),f(100)]);
    assert.deepEqual(await page.evaluate(()=>log.filter(e=>["pointerdown","pointerup"].includes(e.type)).map(e=>[e.type,e.buttons])), [["pointerdown",1],["pointerup",0]]);
    await gesture("mouse",[f(0,p(0,45,345,{buttons:1})),f(150,p(0,160,345,{buttons:1})),f(210)],{dragDrop:true});
    assert.equal(await page.locator("#drop").innerText(),"Card");
    const pending = await gesture("touch",[f(0,p(2,80,100)),f(4000,p(2,100,120)),f(4010)],{wait:false});
    assert.equal(pending.motion.active,true);
    await tool({operation:"set_speed",speed:0});
    await tool({operation:"stop_motion"});
    assert.ok(await page.evaluate(()=>log.some(e=>e.type==="pointercancel")));
    const count = approvals.length;
    await assert.rejects(gesture("touch",[f(0,p(1,10,10),p(1,30,30)),f(20)]),/distinct/);
    assert.equal(approvals.length,count,"a malformed gesture never asks for a write grant");
    console.log("Timed trackpad, smooth wheel swipes, discrete notches, touch, pen, mouse chords, HTML drop, cancellation and nested scroll passed.");
  } finally { await page.close(); }
}
