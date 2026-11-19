import assert from 'node:assert/strict';
import { snapshotPage, actOnPage } from '../extension/content/page.js';
import { showActionPointer } from '../extension/content/action-pointer.js';

export async function testGalleryInteractions(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<style>
    .gallery { width:300px; overflow:hidden; margin:10px 0 }
    .track { display:flex; width:900px }
    .slide { width:300px; flex:none; height:70px }
    [role=tablist] { display:flex; gap:20px }
  </style><main><section class="entertainment-gallery"><h2>Endless entertainment</h2>
    ${['TV', 'Music'].map(group => `<div class="gallery" role="group" aria-label="${group}"><div class="track">${[1, 2, 3].map(n => `<div class="slide" role="tabpanel" id="item-${n}"><a href="https://example.com/${group}/${n}">${group} card ${n}</a></div>`).join('')}</div></div>`).join('')}
    <div role="tablist">${[1, 2, 3].map(n => `<a role="tab" href="#item-${n}" aria-controls="item-${n}" aria-selected="${n === 1}">Item ${n}</a>`).join('')}</div>
  </section></main>`);
  // Mirrors the observed Apple markup: two transformed strips with duplicate
  // panel IDs and one shared dot navigation. Scrolling must not click offers.
  await page.evaluate(({ snapshot, act }) => {
    window.snapshotPage = eval(`(${snapshot})`); window.actOnPage = eval(`(${act})`);
    for (const [index, tab] of [...document.querySelectorAll('[role=tab]')].entries()) tab.addEventListener('click', event => {
      event.preventDefault();
      for (const control of document.querySelectorAll('[role=tab]')) control.setAttribute('aria-selected', String(control === tab));
      for (const track of document.querySelectorAll('.track')) track.style.transform = `translateX(${-index * 300}px)`;
    });
    window.productClicks = 0;
    for (const link of document.querySelectorAll('.slide a')) link.addEventListener('click', event => { event.preventDefault(); window.productClicks++; });
  }, { snapshot: snapshotPage.toString(), act: actOnPage.toString() });
  const read = () => page.evaluate(() => window.snapshotPage(12000, true));
  const scroll = (id, direction) => page.evaluate(({ id, direction }) => window.actOnPage('scroll', id, null, location.href, { direction }), { id, direction });
  const gallery = snapshot => snapshot.elements.find(element => element.kind === 'carousel');
  let snapshot = await read();
  assert.equal(gallery(snapshot).label, 'Endless entertainment navigation');
  assert.deepEqual(gallery(snapshot).directions, ['left', 'right']);
  assert.equal(gallery(snapshot).currentItem, 1);
  assert.equal(gallery(snapshot).itemCount, 3);
  assert.ok(!snapshot.elements.some(element => element.label === 'TV' && element.actions.includes('scroll')), 'transformed strip is not exposed as a native scroll area');
  assert.ok(await page.evaluate(({ id, draw }) => {
    const preview = window.actOnPage('scroll', id, null, location.href, { direction: 'right', preview: true });
    return preview.pointer && eval('(' + draw + ')')(location.href, { ref: id }, 'aim') > 0;
  }, { id: gallery(snapshot).id, draw: showActionPointer.toString() }));
  assert.equal((await scroll(gallery(snapshot).id, 'right')).dispatched, true);
  assert.ok(await page.evaluate(() => {
    const box = window.__safariChatActionPointer.position.getBoundingClientRect();
    return document.querySelector('[aria-selected=true]').contains(document.elementFromPoint(box.left + 3, box.top + 3));
  }), 'the arrow lands on the activated slide control');
  snapshot = await read();
  assert.equal(gallery(snapshot).currentItem, 2);
  assert.match(snapshot.text, /Music card 2/);
  assert.ok(!snapshot.text.includes('Music card 1'));
  assert.equal(await page.evaluate(() => window.productClicks), 0);
  await scroll(gallery(snapshot).id, 'left');
  snapshot = await read();
  assert.equal((await scroll(gallery(snapshot).id, 'left')).moved, false);
  snapshot = await read();
  await assert.rejects(scroll(gallery(snapshot).id, 'down'), /listed scroll directions/);
  snapshot = await read();
  await page.locator('[role=tab]').nth(1).evaluate(tab => { tab.href = 'https://example.com/checkout'; });
  await assert.rejects(scroll(gallery(snapshot).id, 'right'), /gallery changed/);
  assert.equal(await page.evaluate(() => window.productClicks), 0);
  assert.equal(gallery(await read()), undefined, 'external navigation is not a scroll control');
  await page.locator('[role=tab]').nth(1).evaluate(tab => { tab.href = '#item-2'; });
  snapshot = await read();
  await page.locator('[role=tab]').nth(1).evaluate(tab => { tab.target = '_blank'; });
  await assert.rejects(scroll(gallery(snapshot).id, 'right'), /gallery changed/);
  await page.locator('[role=tab]').nth(1).evaluate(tab => { tab.removeAttribute('target'); });
  snapshot = await read();
  // Simulate autoplay advancing while a directional action awaits approval.
  await page.locator('[role=tab]').nth(1).click();
  const advanced = await scroll(gallery(snapshot).id, 'left');
  assert.equal(advanced.fromItem, 2); assert.equal(advanced.requestedItem, 1);
  snapshot = await read();
  assert.equal(gallery(snapshot).currentItem, 1, 'relative navigation follows the live selected item');
  await page.locator('[role=tab]').nth(1).evaluate(tab => tab.setAttribute('aria-selected', 'true'));
  await assert.rejects(scroll(gallery(snapshot).id, 'right'), /selection is unavailable/);
  await page.locator('[role=tab]').nth(1).click();
  snapshot = await read();
  const offer = snapshot.elements.find(element => element.label === 'TV card 2');
  assert.ok(offer?.actions.includes('click'), 'a visible offer remains a distinct clickable control');
  await page.evaluate(id => window.actOnPage('click', id, null, location.href), offer.id);
  assert.equal(await page.evaluate(() => window.productClicks), 1, 'an explicitly requested offer can be clicked');
  await page.locator('section').evaluate(section => { section.className = ''; });
  assert.equal(gallery(await read()), undefined, 'ordinary tab sets are not relabeled as carousels');
  await page.locator('section').evaluate(section => { section.className = 'gallery'; const form = document.createElement('form'); section.replaceWith(form); form.append(section); });
  assert.equal(gallery(await read()), undefined, 'form controls are not treated as gallery navigation');

  await page.setContent(`<main><h1>Image strips</h1>
    ${['auto', 'hidden', 'clip'].map(overflow => `<div role="region" aria-label="${overflow} strip" style="width:280px;overflow-x:${overflow};overflow-y:clip;display:flex;margin:10px 0"><img alt="" width="800" height="40" style="flex:none" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></div>`).join('')}
    <div role="region" aria-label="RTL strip" dir="rtl" style="width:280px;overflow:auto;display:flex"><canvas width="800" height="40" style="flex:none"></canvas></div>
  </main>`);
  snapshot = await read();
  assert.ok(!snapshot.elements.some(element => element.label === 'clip strip'));
  for (const label of ['auto strip', 'hidden strip', 'RTL strip']) {
    snapshot = await read();
    const region = snapshot.elements.find(element => element.label === label);
    assert.deepEqual(region.directions, ['left', 'right']);
    const direction = label.startsWith('RTL') ? 'left' : 'right';
    assert.equal((await scroll(region.id, direction)).moved, true, `${label} must move`);
    await page.getByRole('region', { name: label, exact: true }).evaluate(element => { element.scrollLeft = element.dir === 'rtl' ? -element.scrollWidth : element.scrollWidth; });
    snapshot = await read();
    assert.equal((await scroll(snapshot.elements.find(element => element.label === label).id, direction)).moved, false, `${label} reports its boundary`);
  }
  await page.close();
}
