import assert from 'node:assert/strict';
import { runAgent } from '../extension/core/agent.js';
import { createBrowserTools } from '../extension/core/browser-tools.js';

// The provider is simulated; everything from SSE parsing through approval,
// tab targeting and content-script execution uses the production code.
export async function testBrowserAgent(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${origin}/__dock_fixture__`);
  await page.setContent('<main><h1>Top of the page</h1><div style="height:2200px"></div><h2>Bottom of the page</h2></main>');
  const approvals = [], operations = [];
  const api = {
    tabs: { get: async id => { assert.equal(id, 7); return { id, url: page.url(), status: 'complete' }; } },
    scripting: { executeScript: async ({ target, func, args }) => {
      assert.equal(target.tabId, 7); operations.push(func.name);
      const result = await page.evaluate(({ source, args }) => eval(`(${source})`)(...args), { source: func.toString(), args });
      return [{ result }];
    } },
  };
  const executeTool = createBrowserTools({ api, pageChars: 6000, defaultTabId: 7, approve: async action => { approvals.push(action.operation); } });
  const stream = (items, terminal = { type: 'response.completed', response: { output: [] } }) => new Response([
    ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), terminal,
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const call = (operation, direction = null) => ({ type: 'function_call', namespace: 'safari', name: 'browser', call_id: `call-${operation}-${direction}`, arguments: JSON.stringify({ operation, tabId: null, elementId: null, direction, text: null, checked: null, url: null }) });
  const base = { input: [{ role: 'user', content: 'Can you scroll?' }, { role: 'assistant', content: 'I cannot interact with the browser in this chat.' }, { role: 'user', content: 'Scroll this page down.' }], model: 'test-model', settings: {}, signal: new AbortController().signal };
  let round = 0, text = '';
  const result = await runAgent(base, {
    credential: async () => 'fixture-only', executeTool,
    emit: event => { if (event.type === 'delta') text += event.text; },
    fetchImpl: async (_, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.tools[0].type, 'namespace');
      assert.match(request.instructions, /Safari browser tools are available/);
      assert.match(request.instructions, /Earlier assistant replies may describe capabilities that have since changed/);
      if (round++ === 0) return stream([call('read')]);
      const output = JSON.parse(request.input.at(-1).output);
      if (round === 2) { assert.equal(output.tabId, 7); assert.equal(output.viewport.scrollY, 0); return stream([call('scroll', 'down')]); }
      if (round === 3) { assert.equal(output.moved, true); return stream([call('read')]); }
      assert.ok(output.viewport.scrollY > 0);
      return stream([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Scrolled down.' }] }]);
    },
  });
  assert.equal(result.text, 'Scrolled down.'); assert.equal(text, result.text);
  assert.ok(await page.evaluate(() => scrollY > 0));
  assert.deepEqual(approvals, ['read', 'scroll']);
  assert.deepEqual(operations, ['snapshotPage', 'actOnPage', 'snapshotPage']);
  await page.evaluate(() => scrollTo(0, 0));
  await assert.rejects(runAgent(base, {
    credential: async () => 'fixture-only', executeTool, emit() {},
    fetchImpl: async () => stream([call('scroll', 'down')], { type: 'response.failed', response: { error: { message: 'Provider failed before completion' } } }),
  }), /Provider failed/);
  assert.equal(await page.evaluate(() => scrollY), 0, 'a streamed call must not execute before successful completion');
  assert.equal(operations.length, 3);
  await page.close();
}
