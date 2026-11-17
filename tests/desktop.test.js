import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopController } from '../extension/core/desktop.js';

const sessionId = '00000000-0000-4000-8000-000000000010';
const requestId = '00000000-0000-4000-8000-000000000011';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const replies = [], writes = []; let enabled = true, closed = false, account = 'a';
  const api = { tabs: { get: async id => ({ id, url: 'https://example.com/' }), query: async () => [], create: async args => { writes.push(args); return { id: 2 }; } }, scripting: { executeScript: async ({ func, args }) => func.name === 'snapshotPage' ? [{ result: { url: 'https://example.com/', text: 'Page', elements: [{ id: 'ref', label: 'Field', actions: ['fill'] }] } }] : (writes.push(args), [{ result: { ok: true } }]) } };
  const controller = new DesktopController({ api, preferences: async () => ({ desktopControl: enabled, pageChars: 6000 }), isClosed: () => closed, verify: async () => ({ account, hostID: 'host' }), reply: async payload => replies.push(payload) });
  const request = args => controller.handle({ sessionId, requestId, kind: 'request', args });
  const approve = allow => { const item = replies.findLast(item => item.type === 'approval'); return controller.handle({ sessionId, requestId, kind: 'approval', approvalId: item.approvalId, allow }); };
  return { controller, replies, writes, request, approve, setAccount: value => { account = value; }, disable: () => { enabled = false; }, close: () => { closed = true; } };
}
test('desktop approvals are returned to the calling session and exact request before writes', async () => {
  const f = fixture();
  const run = f.request({ operation: 'open_tab', url: 'https://example.com/' }); await tick();
  assert.equal(f.writes.length, 0); assert.equal(f.replies[0].type, 'approval');
  await f.controller.handle({ sessionId, requestId, kind: 'approval', approvalId: 'wrong', allow: true });
  assert.equal(f.writes.length, 0);
  await f.approve(true); await run;
  assert.equal(f.writes.length, 1); assert.equal(f.replies.at(-1).type, 'result');
  assert.equal(f.replies.at(-1).result.tabId, 2);
});
test('desktop refusal, account changes, and revocation never perform the pending action', async () => {
  for (const change of ['decline', 'account', 'disable', 'cleanup']) {
    const f = fixture(); const run = f.request({ operation: 'open_tab', url: 'https://example.com/' }); await tick();
    if (change === 'account') f.setAccount('b');
    if (change === 'disable') f.disable();
    if (change === 'cleanup') f.close();
    await f.approve(change !== 'decline'); await run;
    assert.equal(f.writes.length, 0); assert.ok(f.replies.at(-1).error);
  }
});
test('desktop sessions preserve fresh reads across calls and invalidate them on account change', async () => {
  const f = fixture();
  const read = f.request({ operation: 'read', tabId: 1 }); await tick(); await f.approve(true); await read;
  const fill = f.request({ operation: 'fill', tabId: 1, elementId: 'ref', text: 'Hello' }); await tick(); await f.approve(true); await fill;
  assert.equal(f.writes.length, 1);
  f.setAccount('b');
  await f.request({ operation: 'fill', tabId: 1, elementId: 'ref', text: 'Other account' });
  assert.match(f.replies.at(-1).error, /account changed/); assert.equal(f.writes.length, 1);
});
test('desktop cleanup cancels pending approvals and disabled control fails closed', async () => {
  const f = fixture(); const run = f.request({ operation: 'open_tab', url: 'https://example.com/' }); await tick();
  await f.controller.cancelAll(); await run;
  assert.equal(f.writes.length, 0); assert.equal(f.controller.approvals.size, 0);
  f.disable(); await f.request({ operation: 'list_tabs' });
  assert.match(f.replies.at(-1).error, /Enable ChatGPT desktop control/);
});
