import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { snapshotPage } from '../extension/content/page.js';

export async function testPanelMount(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const installBrowser = ({ origin }) => {
    globalThis.browser = { runtime: {
      id: 'dock-test', getURL: name => `${origin}/${name}`,
      onMessage: { addListener: listener => { globalThis.__mountMessage = listener; } },
      sendMessage: async message => {
        if (message.type === 'panel.present') await parent.__mountMessage({ type: 'panel.ready', token: message.dockToken }, { id: 'dock-test' });
        if (message.type === 'dock.dismiss') await globalThis.__mountMessage({ type: 'panel.close' }, { id: 'dock-test' });
        return { ok: true, value: message.type === 'bootstrap' ? {
        prefs: { theme: 'light', model: 'test-model', pageChars: 12000, inputChars: 48000, historyTurns: 8, maxToolRounds: 6, desktopControl: false },
        auth: { connected: true, canInfer: true, account: 'dock-test', generation: 'dock-session', label: 'Test account' }, models: [{ id: 'test-model', name: 'Test model', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        } : undefined };
      },
    } };
  };
  await page.addInitScript(installBrowser, { origin });
  await page.goto(`${origin}/__workflow/one`);
  await page.setContent(`<!doctype html><html style="padding-right:0px;color:rgb(20,20,20)"><head><style>
    * { box-sizing:border-box } body { margin:0; font:16px system-ui; color:#202020; background:#f5f5f5 }
    #site { width:100vw; overflow-x:clip } header { position:fixed; left:0; top:0; width:100%; height:68px; padding:22px 32px; background:white; border-bottom:1px solid #ddd }
    main { padding:110px 48px 48px; min-height:1900px } h1 { font-size:36px; letter-spacing:-1px } p { max-width:650px; line-height:1.7 }
    .cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px; margin-top:32px }
    article { padding:24px; background:white; border:1px solid #ddd; border-radius:14px; min-height:180px }
    #floating { position:fixed; right:20px; bottom:24px; padding:12px 20px; border:0; border-radius:20px; background:#252525; color:white }
    input { padding:10px; border:1px solid #aaa; border-radius:8px }
  </style></head><body><div id="site"><header>Example website <span style="float:right">Account</span></header><main>
    <h1>A page with room to work</h1><p>The website reflows on the left while Safari Chat stays beside it. The fixed header and floating page controls remain accessible.</p>
    <label>Your draft <input id="draft" value="Keep this text"></label><div class="cards"><article>Research</article><article>Planning</article><article>Writing</article></div>
    </main><button id="floating">Page help</button></div></body></html>`);
  await page.evaluate(installBrowser, { origin });
  // Observe the fixture's closed shadow root so Retry and Close can be exercised
  // with trusted pointer input, including when the panel document never loads.
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      const shadow = attach.call(this, init);
      if (this.id === 'safari-chat-host') window.dockShadow = shadow;
      return shadow;
    };
  });
  const source = await readFile('extension/content/mount.js', 'utf8');
  await page.evaluate(source);
  await page.locator('#draft').focus();
  await page.locator('#floating').evaluate(button => button.addEventListener('click', () => { window.pageClicks = (window.pageClicks ?? 0) + 1; }));
  const initial = await page.evaluate(() => ({ root: document.documentElement.style.cssText, body: document.body.style.cssText, site: document.getElementById('site').style.cssText, header: document.querySelector('header').style.cssText, floating: document.getElementById('floating').style.cssText }));
  const message = type => page.evaluate(type => globalThis.__mountMessage({ type, token: 'test-grant', url: browser.runtime.getURL('panel/panel.html?tab=1') }, { id: browser.runtime.id }), type);
  await assert.rejects(page.evaluate(() => globalThis.__mountMessage({ type: 'panel.show', url: 'https://other.example/panel.html' }, { id: browser.runtime.id })), /Invalid panel URL/);
  assert.equal(await page.evaluate(() => globalThis.__mountMessage({ type: 'panel.show', url: browser.runtime.getURL('panel/panel.html') }, { id: 'another-extension' })), undefined);
  assert.equal((await message('panel.show')).ok, true);
  assert.ok(await page.evaluate(() => {
    const frame = window.dockShadow.querySelector('iframe');
    return frame.getAttribute('aria-label') === 'Safari Chat' && !frame.hasAttribute('title');
  }), 'the frame has an accessible name without a tooltip across the conversation');
  const panel = page.frames().find(frame => frame.url().includes('/panel/panel.html')) ?? await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/panel/panel.html') });
  await panel.waitForFunction(() => document.getElementById('account-label')?.textContent === 'Test account');
  const bounds = () => page.evaluate(() => {
    const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, width: box.width }; };
    return { panel: rect(document.getElementById('safari-chat-host')), site: rect(document.getElementById('site')), header: rect(document.querySelector('header')), floating: rect(document.getElementById('floating')) };
  });
  let boxes = await bounds();
  assert.equal(boxes.panel.width, 440); assert.equal(boxes.panel.right, 1440);
  for (const name of ['site', 'header', 'floating']) assert.ok(boxes[name].right <= boxes.panel.left + 1, `${name} must stay beside the panel`);
  const readPage = () => page.evaluate(fn => eval(`(${fn})`)(12000, true), snapshotPage.toString());
  assert.equal((await readPage()).viewport.width, boxes.panel.left, 'page tools use the space remaining beside chat');
  await page.screenshot({ path: 'build/screenshots/panel-docked.png' });
  const waitWidth = width => page.waitForFunction(width => document.getElementById('safari-chat-host')?.getBoundingClientRect().width === width, width);
  const dragBy = async distance => {
    const { panel } = await bounds();
    await page.mouse.move(panel.left + 3, 450);
    await page.mouse.down();
    await page.mouse.move(panel.left + 3 - distance, 450, { steps: 10 });
    await page.mouse.up();
  };
  await dragBy(200); await waitWidth(640);
  boxes = await bounds();
  for (const name of ['site', 'header', 'floating']) assert.ok(boxes[name].right <= boxes.panel.left + 1, `${name} must follow panel dragging`);
  assert.equal((await readPage()).viewport.width, 800);
  await page.screenshot({ path: 'build/screenshots/panel-resized.png' });
  await dragBy(400); await waitWidth(840);
  await dragBy(-700); await waitWidth(320);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the panel fits its minimum width');
  await panel.locator('#prompt').fill('Draft survives resizing');
  await dragBy(120); await waitWidth(440);
  assert.equal(await panel.locator('#prompt').inputValue(), 'Draft survives resizing', 'resizing keeps the original iframe and draft');
  await page.keyboard.press('ArrowLeft'); await waitWidth(456);
  await page.keyboard.press('Shift+ArrowRight'); await waitWidth(392);
  await page.keyboard.press('End'); await waitWidth(840);
  await page.setViewportSize({ width: 1000, height: 900 }); await waitWidth(680);
  await page.setViewportSize({ width: 1440, height: 900 }); await waitWidth(840);
  await page.keyboard.press('Home'); await waitWidth(320);
  // Escape restores the width at the beginning of the active gesture.
  await page.mouse.move(1123, 450); await page.mouse.down();
  await page.mouse.move(943, 450); await waitWidth(500);
  await page.keyboard.press('Escape'); await waitWidth(320); await page.mouse.up();
  await page.keyboard.press('Enter'); await waitWidth(440);
  await dragBy(160); await waitWidth(600);
  await page.mouse.dblclick(843, 450); await waitWidth(440);
  await dragBy(80); await waitWidth(520);
  await message('panel.close'); await message('panel.show'); await waitWidth(520);
  const reopenedPanel = page.frames().find(frame => frame.url().includes('/panel/panel.html')) ?? await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/panel/panel.html') });
  await reopenedPanel.waitForFunction(() => document.getElementById('account-label')?.textContent === 'Test account');
  await page.mouse.dblclick(923, 450); await waitWidth(440);
  assert.equal(await page.locator('#draft').inputValue(), 'Keep this text');
  await page.locator('#draft').fill('Typed beside chat');
  await page.locator('#floating').click();
  assert.equal(await page.evaluate(() => window.pageClicks), 1, 'the dock must not block website interaction');
  assert.equal(await page.locator('#safari-chat-host').isVisible(), true, 'page clicks must not dismiss chat');
  await page.evaluate(() => scrollTo(0, 400));
  assert.equal((await bounds()).header.top, 0, 'fixed headers stay fixed while scrolling');
  await message('panel.show');
  assert.equal(await page.locator('#safari-chat-host').count(), 1, 'reopening must reuse the same panel');
  assert.equal(page.frames().filter(frame => frame.url().includes('/panel/panel.html')).length, 1);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'dynamic'; button.textContent = 'New page control';
    button.style.cssText = 'position:fixed;right:24px;top:110px'; document.body.append(button);
    document.documentElement.style.paddingRight = '8px';
    document.body.style.backgroundColor = 'rgb(240, 240, 240)';
  });
  await page.waitForFunction(() => document.getElementById('dynamic').getBoundingClientRect().right <= document.getElementById('safari-chat-host').getBoundingClientRect().left);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForFunction(() => document.getElementById('safari-chat-host').getBoundingClientRect().width === 400);
  boxes = await bounds();
  for (const name of ['site', 'header', 'floating']) assert.ok(boxes[name].right <= boxes.panel.left + 1, `${name} must follow window resizing`);
  await message('panel.close');
  assert.equal(await page.locator('#safari-chat-host').count(), 0);
  const restored = await page.evaluate(() => ({ padding: document.documentElement.style.paddingRight, color: document.documentElement.style.color, sizing: document.documentElement.style.boxSizing, background: document.body.style.backgroundColor, site: document.getElementById('site').style.cssText, header: document.querySelector('header').style.cssText, floating: document.getElementById('floating').style.cssText, dynamic: document.getElementById('dynamic').style.cssText, focus: document.activeElement.id }));
  assert.equal(restored.padding, '8px', 'preserve newer site edits to an owned property');
  assert.equal(restored.color, 'rgb(20, 20, 20)'); assert.equal(restored.sizing, '');
  assert.equal(restored.background, 'rgb(240, 240, 240)');
  for (const name of ['site', 'header', 'floating']) assert.equal(restored[name], initial[name]);
  assert.ok(!restored.dynamic.includes('translate')); assert.equal(restored.focus, 'draft');
  assert.equal(await page.locator('#draft').inputValue(), 'Typed beside chat');
  assert.equal((await readPage()).viewport.width, 1000, 'closing restores the full viewport for page tools');
  await page.evaluate(() => { document.body.style.position = 'fixed'; document.body.style.width = '100%'; });
  await message('panel.show');
  assert.ok(await page.evaluate(() => document.body.getBoundingClientRect().right <= document.getElementById('safari-chat-host').getBoundingClientRect().left + 1), 'fixed body layouts also leave room for chat');
  await page.locator('#safari-chat-host').evaluate(host => host.remove());
  await page.waitForFunction(() => globalThis.__safariChatPageRight === undefined);
  assert.equal(await page.evaluate(() => document.body.style.position), 'fixed', 'restore the website fixed-body layout');
  await page.setViewportSize({ width: 640, height: 700 });
  assert.equal((await message('panel.show')).ok, true);
  const narrow = page.frames().find(frame => frame.url().includes('/panel/panel.html')) ?? await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/panel/panel.html') });
  await narrow.waitForFunction(() => document.getElementById('account-label')?.textContent === 'Test account');
  await narrow.locator('#prompt').fill('Present beside the page');
  for (const width of [640, 500, 390]) {
    await page.setViewportSize({ width, height: 700 }); await waitWidth(width / 2);
    const { panel, site, floating } = await bounds();
    assert.equal(panel.right, width); assert.ok(site.right <= panel.left + 1 && floating.right <= panel.left + 1);
    assert.equal(await narrow.locator('#prompt').inputValue(), 'Present beside the page');
    assert.ok(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await narrow.getByRole('button', { name: 'Settings', exact: true }).click();
    await narrow.getByRole('button', { name: 'Close settings' }).click();
    if (width === 640) await page.screenshot({ path: 'build/screenshots/panel-narrow-docked.png' });
  }
  await message('panel.close');

  const panelURL = origin + '/panel/panel.html?tab=1';
  const status = selector => page.evaluateHandle(selector => window.dockShadow.querySelector(selector), selector);
  const waitForRetry = () => page.waitForFunction(() => !window.dockShadow.querySelector('button:not(.close)').hidden);
  const waitForChat = () => page.waitForFunction(() => window.dockShadow.querySelector('.load-status').hidden);
  const held = Promise.withResolvers();
  await page.route(panelURL, route => held.resolve(route), { times: 1 });
  await message('panel.show');
  const route = await held.promise;
  await waitForRetry();
  assert.equal(await page.locator('#safari-chat-host').count(), 1);
  await route.continue(); await waitForChat();
  await message('panel.close');

  await page.route(panelURL, route => route.abort(), { times: 1 });
  await message('panel.show'); await waitForRetry();
  await (await status('.load-status button:not(.close)')).asElement().click();
  await waitForChat();
  await message('panel.close');
  await page.route(panelURL, route => route.abort(), { times: 1 });
  await message('panel.show');
  await (await status('.load-status .close')).asElement().click();
  await page.locator('#safari-chat-host').waitFor({ state: 'detached' });
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(errors, []);
  await page.close();
}
