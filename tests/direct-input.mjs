import assert from "node:assert/strict";
import { createBrowserTools } from "../extension/core/browser-tools.js";
import { PageInputs } from "../extension/core/page-input.js";
import { MotionSession } from "../extension/core/motion-session.js";

export async function testDirectInput(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.goto(origin + "/__workflow/one");
    await page.setContent('<form><label>Notes <input id="notes" value="hello world"></label><button>Submit</button></form><p>Outside <strong>the bold</strong> passage. Other text.</p><div contenteditable="true" aria-label="Rich editor">Editable text</div><button id="double">Open item</button><button id="replaced">Replaced</button><input type=password aria-label="Password">');
    await page.evaluate(() => {
      window.keys=[]; window.clicks=[]; window.presses=[]; window.submits=0;
      document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submits++};
      for (const name of ["keydown","beforeinput","input","keyup","paste"]) document.getElementById("notes").addEventListener(name,e=>window.keys.push([name, e.key ?? e.inputType]));
      for (const name of ["pointerdown","mousedown","pointerup","mouseup","click"]) document.getElementById("notes").addEventListener(name,()=>window.presses.push(name));
      for (const name of ["mousedown","mouseup","click","dblclick"]) document.getElementById("double").addEventListener(name,e=>window.clicks.push([name,e.detail]));
      document.getElementById("replaced").onclick=e=>{const n=document.createElement("button");n.textContent="Different control";n.onclick=()=>window.wrong=true;e.target.replaceWith(n)};
    });
    const api = { tabs: { get: async id => ({ id, status: "complete", url: page.url() }) }, scripting: { executeScript: async ({ func,args=[] }) => [{ result: await page.evaluate(({ code,args })=>eval(`(${code})`)(...args), {code:func.toString(),args}) }] } };
    let clipboard = "initial", reads=0;
    const inputs = new PageInputs(api, { write: async text=>{clipboard=text},read: async()=>{reads++;return clipboard} });
    const approvals=[], signal=new AbortController().signal;
    const perform = createBrowserTools({ api, inputs, motionSession: new MotionSession(api,()=>{}), defaultTabId:7, pageChars:6000, approve:async a=>{approvals.push(a)} });
    const act = (operation, fields={})=>perform({operation,...fields},signal);
    const find = async label => (await act("read")).elements.find(item=>item.label===label);
    const field = await find("Notes");
    await act("click",{elementId:field.id});
    assert.deepEqual(await page.evaluate(()=>presses),["pointerdown","mousedown","pointerup","mouseup","click"]);
    await act("select_text",{elementId:field.id,text:"world"});
    const copy = await act("copy");
    assert.equal(clipboard,"world"); assert.equal(copy.characters,5); assert.doesNotMatch(JSON.stringify(copy),/world/);
    await act("replace_selection",{text:"Safari"}); assert.equal(await page.locator("#notes").inputValue(),"hello Safari");
    await act("press_key",{text:"End"}); await act("type_text",{text:" ✨!"});
    assert.equal(await page.locator("#notes").inputValue(),"hello Safari ✨!");
    assert.ok(await page.evaluate(()=>keys.some(e=>e[0]==="keydown") && keys.some(e=>e[0]==="beforeinput") && keys.some(e=>e[0]==="keyup")));
    await act("press_key",{text:"Backspace"}); await act("press_key",{text:"Shift+ArrowLeft"});
    await act("copy"); assert.equal(clipboard,"✨");
    await act("delete_selection"); assert.equal(await page.locator("#notes").inputValue(),"hello Safari ");
    clipboard="external clipboard"; const pasted=await act("paste");
    assert.equal(await page.locator("#notes").inputValue(),"hello Safari external clipboard");
    assert.doesNotMatch(JSON.stringify(pasted),/external clipboard/);
    assert.ok(await page.evaluate(()=>keys.some(e=>e[0]==="paste")));
    await act("press_key",{text:"Enter"}); assert.equal(await page.evaluate(()=>submits),1);
    const rich=await find("Rich editor"); await act("click",{elementId:rich.id});
    await act("select_text",{elementId:rich.id,range:{start:0,end:8}});
    await act("replace_selection",{text:"Revised"}); await act("type_text",{text:" field"});
    assert.equal(await page.locator("[contenteditable]").innerText(),"Revised field text");
    await act("press_key",{text:"Meta+A"}); await act("copy");
    assert.equal(clipboard,"Revised field text");

    await act("read"); await act("select_text",{text:"side the bold pass"});
    const quote=await act("copy"); assert.equal(clipboard,"side the bold pass"); assert.equal(quote.characters,18);
    await act("replace_selection",{text:"SET"}); assert.equal(await page.locator("p").innerText(),"OutSETage. Other text.");
    assert.equal(await page.locator("p strong").count(),1);
    await act("read"); await act("select_text",{text:"Other text."});
    clipboard="Pasted"; await act("paste"); assert.equal(await page.locator("p").innerText(),"OutSETage. Pasted");
    await act("read"); await act("select_text",{text:"Pasted"}); await act("delete_selection");
    assert.equal(await page.locator("p").innerText(),"OutSETage.");
    await act("read"); await act("select_text",{text:"SET"}); await page.evaluate(()=>getSelection().removeAllRanges());
    await assert.rejects(act("paste"),/selection or target changed/i);
    assert.equal(reads,2,"a stale destination cannot read the clipboard");
    const notes = await find("Notes");
    const [left,top,right,bottom] = notes.bounds;
    await act("click",{point:{x:(left+right)/2,y:(top+bottom)/2}});
    await act("press_key",{text:"Home"}); await act("type_text",{text:"Hi "});
    const before = await page.locator("#notes").inputValue();
    assert.ok(before.startsWith("Hi "));
    await act("select_text",{elementId:notes.id,text:"Hi"});
    await page.locator("#notes").evaluate(el=>el.addEventListener("paste",()=>el.setSelectionRange(3,3),{once:true}));
    await assert.rejects(act("paste"),/selection or target changed/i);
    assert.equal(await page.locator("#notes").inputValue(),before);
    await act("read");
    const targetPoint = await page.locator("p").evaluate(el=>{
      el.addEventListener("dblclick",e=>{window.paragraphDouble=e.detail},{once:true});
      const r=el.getBoundingClientRect(); return {x:r.left+10,y:(r.top+r.bottom)/2};
    });
    assert.equal((await act("double_click",{point:targetPoint})).doubleClicked,true);
    assert.equal(await page.evaluate(()=>paragraphDouble),2);
    const button=await find("Open item"); const doubled=await act("double_click",{elementId:button.id});
    assert.equal(doubled.doubleClicked,true);
    assert.deepEqual(await page.evaluate(()=>clicks.filter(e=>["click","dblclick"].includes(e[0]))),[["click",1],["click",2],["dblclick",2]]);
    const replaced=await find("Replaced"); const partial=await act("double_click",{elementId:replaced.id});
    assert.equal(partial.clicks,1); assert.equal(partial.doubleClicked,false); assert.equal(await page.evaluate(()=>!!window.wrong),false);
    assert.ok(approvals.some(a=>a.operation==="replace_selection" && a.detail.includes("displayed page text")));
    assert.ok(!(await act("read")).elements.some(e=>e.label==="Password"));
    await inputs.release();
    console.log("Direct input passed double-click ordering and retarget protection, caret typing, editing keys, form submit, clipboard routing and partial edits across inline markup.");
  } finally { await page.close(); }
}
