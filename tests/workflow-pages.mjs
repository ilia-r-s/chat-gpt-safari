import { readFile } from "node:fs/promises";

export async function serveWorkflow(request, response) {
  if (["/__workflow/carousel", "/__workflow/paint"].includes(request.url)) {
    response.writeHead(200, { "Content-Type": "text/html" }).end(await readFile(new URL("./fixtures/" + request.url.split("/").pop() + ".html", import.meta.url)));
    return true;
  }
  if (request.url === "/__dock-slow-head") {
    setTimeout(() => response.writeHead(200, { "Content-Type": "text/javascript" }).end(), 2200);
    return true;
  }
  if (request.url === "/__dock-slow-resource") {
    setTimeout(() => response.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), 4200);
    return true;
  }
  if (request.url === "/__workflow/yahoo") {
    response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><title>Yahoo</title><main>Manually opened Yahoo fixture<input type="search" value="Tailor Swift"><div style="height:2800px"></div><article><h2>Taylor <em>Swift</em> announces a concert</h2></article></main>');
    return true;
  }
  if (request.url === "/__workflow/finance") {
    response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><title>Market news</title><main><form action="/__workflow/quote"><label>Search quotes <input type="search" name="symbol"></label><button>Search</button></form></main>');
    return true;
  }
  if (request.url.startsWith("/__workflow/quote?")) {
    const symbol = new URL(request.url, "http://localhost").searchParams.get("symbol");
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Quote results</title><main>" + (symbol === "EXMP" ? "Example Company (EXMP) 123.45" : "No matching quote") + "</main>");
    return true;
  }
  if (request.url.startsWith("/__workflow/")) {
    const step = request.url.endsWith("/three") ? "Three" : request.url.endsWith("/two") ? "Two" : "One";
    response.setHeader("Content-Type", "text/html");
    const items = [1,2,3];
    const slow = new URL(request.url, "http://localhost").searchParams.has("slow-resource") ? '<img src="/__dock-slow-resource" alt=""><section class="gallery" aria-label="Offers"><div role="tablist">' +
      items.map(n => `<button style="position:static" role="tab" aria-controls="offer-${n}" aria-selected="${n === 3}" onclick="for(const t of this.parentNode.children)t.setAttribute('aria-selected',t===this)">Offer ${n}</button>`).join("") +
      '</div>' + items.map(n => `<p role="tabpanel" id="offer-${n}">Card ${n}</p>`).join("") + '</section><footer style="height:6000px">Footer</footer><script>addEventListener("wheel",e=>{if(!e.isTrusted){if(e.deltaX)document.body.dataset.wheel=String(e.deltaX);e.preventDefault()}},{passive:false});addEventListener("gesturechange",e=>{document.body.dataset.scale=String(e.scale);document.body.dataset.rotation=String(e.rotation)});addEventListener("touchstart",e=>{document.body.dataset.contactCount=String(e.touches.length)});</script>' : "";
    const head = request.url.includes("slow-head") ? '<script>new MutationObserver(()=>{if(!document.body && document.getElementById("safari-chat-host"))window.paneMountedBeforeBody=true}).observe(document,{childList:true,subtree:true})</script><script src="/__dock-slow-head"></script>' : "";
    response.end(`<!doctype html><html><head>${head}<title>Step ${step}</title><style>*{box-sizing:border-box}body{margin:0}main{width:100vw;height:230vh;padding:75px 24px}header{position:fixed;inset:0 0 auto;width:100vw}button{position:fixed;right:16px;bottom:16px}@media(max-width:1050px){main{display:grid;align-content:start;gap:16px}}</style></head><body><header>Workflow</header><main>Workflow step ${step}<a href="/__workflow/three">Continue</a></main><button>Page help</button>${slow}`); return true;
  }
  return false;
}
