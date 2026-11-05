import test from "node:test";
import assert from "node:assert/strict";
import { LocalData } from "../extension/core/local-data.js";

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
test("cleanup drains started writes, rejects queued writes, and verifies empty storage", async () => {
  const data = { settings: { theme: "dark" }, "chat:old": "private" };
  const storage = { clear: async () => { for (const key of Object.keys(data)) delete data[key]; }, get: async () => ({ ...data }) };
  const local = new LocalData(storage);
  const started = deferred(); const release = deferred();
  const first = local.write(async () => { started.resolve(); await release.promise; data["chat:late"] = "late"; });
  await started.promise;
  const queued = assert.rejects(local.write(() => { data.draft = "must never save"; }), /erased/);
  const erase = local.clear();
  release.resolve();
  await Promise.all([first, queued, erase]);
  assert.deepEqual(data, {});
  await assert.rejects(local.write(() => { data.recreated = true; }), /erased/);
  assert.deepEqual(data, {});
});
test("failed erasure stays closed and can be retried without a persistent marker", async () => {
  let fail = true; const data = { secret: "private" };
  const local = new LocalData({ clear: async () => { if (fail) throw new Error("disk error"); delete data.secret; }, get: async () => data });
  await assert.rejects(local.clear(), /disk error/);
  assert.equal(local.closed, true);
  fail = false; await local.clear(); assert.deepEqual(data, {});
});
test("cleanup never reports success if storage still contains data", async () => {
  const local = new LocalData({ clear: async () => {}, get: async () => ({ remaining: "private" }) });
  await assert.rejects(local.clear(), /verify/);
});
