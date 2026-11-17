import assert from 'node:assert/strict';
import { snapshotPage, actOnPage } from '../extension/content/page.js';

export async function testPageInteractions(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<main>
    <h1>Profile form</h1>
    <label for="name">Full name</label><input id="name" value="PRIVATE FIELD VALUE">
    <label for="country">Country</label><select id="country"><option value="us">United States</option><option value="ca">Canada</option><option value="blocked" disabled>Unavailable</option></select>
    <label for="updates">Receive updates</label><input id="updates" type="checkbox">
    <label for="radio">Standard plan</label><input id="radio" type="radio" name="plan">
    <label for="readonly">Read-only field</label><input id="readonly" readonly>
    <label for="card">Card number</label><input id="card" autocomplete="cc-number">
    <label for="notes">Notes</label><textarea id="notes">PRIVATE TEXTAREA VALUE</textarea>
    <div aria-label="Rich text" contenteditable="true">PRIVATE EDITABLE VALUE</div>
    <fieldset disabled><input aria-label="Disabled field"></fieldset>
    <div style="opacity:0"><span>INVISIBLE TEXT</span><button>Invisible action</button></div>
    <a id="link" href="https://example.com/first">Details</a>
    <div role="region" aria-label="Scrollable notes" style="height:120px;overflow:auto"><p>Start of notes</p><div style="height:600px"></div><p>End of notes</p></div>
    <div style="height:1400px"></div><p id="bottom">Bottom of the page</p><button>Bottom action</button>
  </main>`);
  const read = () => page.evaluate(() => window.snapshotPage(12000, true));
  await page.evaluate(({ snapshot, act }) => { window.snapshotPage = eval(`(${snapshot})`); window.actOnPage = eval(`(${act})`); }, { snapshot: snapshotPage.toString(), act: actOnPage.toString() });
  const action = (operation, elementId, text, extra = {}) => page.evaluate(args => window.actOnPage(args.operation, args.elementId, args.text, location.href, args.extra), { operation, elementId, text, extra });
  let snapshot = await read();
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.ok(!snapshot.elements.some(element => /Card number|Disabled field/.test(element.label)));
  assert.ok(!snapshot.text.includes('INVISIBLE'));
  assert.ok(!snapshot.elements.some(element => element.label === 'Invisible action'));
  assert.ok(!snapshot.text.includes('Bottom of the page'));
  const find = label => snapshot.elements.find(element => element.label === label);
  const attachment = await page.evaluate(() => window.snapshotPage(6000, false));
  assert.equal(attachment.elements, undefined, 'attaching a page leaves existing action references intact');
  assert.deepEqual(find('Full name').actions, ['click', 'fill']);
  assert.equal(find('Country').options[1].value, 'ca');
  assert.ok(!find('Read-only field').actions.includes('fill'));
  await page.evaluate(() => { document.getElementById('name').addEventListener('input', event => { window.receivedInput = event.target.value; }); });
  await action('fill', find('Full name').id, 'Ada Lovelace');
  assert.equal(await page.locator('#name').inputValue(), 'Ada Lovelace');
  assert.equal(await page.evaluate(() => window.receivedInput), 'Ada Lovelace');
  await assert.rejects(action('fill', find('Full name').id, 'Stale'), /Read it again/);
  snapshot = await read();
  await action('select', find('Country').id, 'Canada');
  assert.equal(await page.locator('#country').inputValue(), 'ca');
  snapshot = await read();
  await assert.rejects(action('select', find('Country').id, 'blocked'), /enabled option/);
  snapshot = await read();
  await action('set_checked', find('Receive updates').id, null, { checked: true });
  assert.equal(await page.locator('#updates').isChecked(), true);
  snapshot = await read();
  await action('set_checked', find('Receive updates').id, null, { checked: false });
  assert.equal(await page.locator('#updates').isChecked(), false);
  snapshot = await read();
  await assert.rejects(action('set_checked', find('Standard plan').id, null, { checked: false }), /another radio/);
  snapshot = await read();
  await assert.rejects(action('fill', find('Read-only field').id, 'Must not write'), /read-only/);
  snapshot = await read();
  await page.locator('#name').evaluate(element => { element.parentElement.style.opacity = '0'; });
  await assert.rejects(action('fill', find('Full name').id, 'Hidden after approval'), /no longer visible/);
  await page.locator('#name').evaluate(element => { element.parentElement.style.opacity = ''; });
  snapshot = await read();
  await page.locator('#link').evaluate(element => { element.href = 'https://other.example/changed'; });
  await assert.rejects(action('click', find('Details').id), /changed since approval/);
  snapshot = await read();
  await page.locator('#name').evaluate(element => { element.autocomplete = 'cc-number'; });
  await assert.rejects(action('fill', find('Full name').id, 'Not allowed'), /sensitive/);
  await page.locator('#name').evaluate(element => { element.autocomplete = ''; element.addEventListener('change', () => { element.value = ''; }); });
  snapshot = await read();
  await assert.rejects(action('fill', find('Full name').id, 'Rejected by page'), /did not keep/);
  snapshot = await read();
  const region = snapshot.elements.find(element => element.label === 'Scrollable notes' && element.actions.includes('scroll'));
  assert.ok(region);
  assert.equal((await action('scroll', region.id, null, { direction: 'bottom' })).moved, true);
  snapshot = await read();
  assert.ok(snapshot.text.includes('End of notes'));
  assert.ok(!snapshot.text.includes('Start of notes'));
  await action('scroll', null, null, { direction: 'bottom' });
  snapshot = await read();
  assert.ok(snapshot.text.includes('Bottom of the page'));
  assert.ok(snapshot.elements.some(element => element.label === 'Bottom action'));
  assert.equal((await action('scroll', null, null, { direction: 'bottom' })).moved, false);
  await read(); await action('scroll', null, null, { direction: 'top' });
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.setContent(`<main><h1>Many controls</h1>${Array.from({ length: 80 }, (_, i) => `<button>${i}: ${'Label '.repeat(30)}</button>`).join('')}<select aria-label="Many choices">${Array.from({ length: 100 }, (_, i) => `<option>${i}: ${'Choice '.repeat(30)}</option>`).join('')}</select></main>`);
  await page.setViewportSize({ width: 1200, height: 3000 });
  const bounded = await read();
  assert.ok(JSON.stringify(bounded).length <= 18000, 'control descriptions must fit within the tool result budget');
  assert.ok(bounded.elementsTruncated);
  await page.setContent('<main><video width="320" height="180"></video><p>Introduction to the lesson</p></main>');
  await page.evaluate(() => {
    const video = document.querySelector('video');
    const captions = video.addTextTrack('captions', 'English', 'en'); captions.mode = 'showing';
    captions.addCue(new VTTCue(65, 70, 'The experiment starts here.'));
    captions.addCue(new VTTCue(71, 80, 'More detail '.repeat(300)));
    const hidden = video.addTextTrack('subtitles', 'Other'); hidden.mode = 'hidden'; hidden.addCue(new VTTCue(0, 1, 'Unused track'));
  });
  const shared = await page.evaluate(() => window.snapshotPage(200, false));
  assert.match(shared.text, /1:05 The experiment starts here/);
  assert.ok(shared.text.includes('Introduction') && shared.text.length <= 200 && shared.truncated);
  assert.ok(!shared.text.includes('Unused track'));
  assert.ok(!(await read()).text.includes('The experiment starts here'), 'viewport reads do not collect a video transcript');
  const selected = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('p'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    return window.snapshotPage(12, false, true);
  });
  assert.equal(selected.selection, 'Introduction'); assert.equal(selected.text, undefined); assert.ok(selected.truncated);
  await page.close();
}
