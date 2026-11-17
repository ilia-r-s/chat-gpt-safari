/** The unsigned binary can test MCP discovery/refusal without reading credentials or opening Safari. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const binary = process.env.SAFARI_CHAT_BINARY ?? path.resolve('build/DerivedData/Build/Products/Debug/Safari Chat.app/Contents/MacOS/Safari Chat');
const child = spawn(binary, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let buffer = '', stderr = '', nextID = 0;
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
  }
});
child.on('exit', code => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited (${code}): ${stderr.slice(0, 800)}`)); } pending.clear(); });
function request(method, params = {}) {
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr.slice(0, 800)}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'safari-chat');
  const catalog = await request('tools/list');
  assert.equal(catalog.result.tools.length, 10);
  for (const name of ['safari_fill', 'safari_scroll', 'safari_open_tab', 'safari_navigate', 'safari_close_tab']) assert.ok(catalog.result.tools.some(tool => tool.name === name));
  const refused = await request('tools/call', { name: 'safari_open_tab', arguments: { url: 'https://example.com/' } });
  assert.match(refused.error.message, /form elicitation/);
  assert.ok(!JSON.stringify(initialized).includes('token'));
  console.log('MCP smoke passed: native stdio startup, protocol discovery, ten tool schemas, and refusal without client approval support. No Keychain or Safari actions were requested.');
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  clearTimeout(timer);
}
