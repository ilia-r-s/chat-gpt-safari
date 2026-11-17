import test from "node:test";
import assert from "node:assert/strict";
import { modelCatalog, resolveEffort } from "../extension/core/models.js";
import { normalizeSettings } from "../extension/core/config.js";

test("model catalog preserves server reasoning capabilities and hides unavailable models", () => {
  const result = modelCatalog({ models: [
    { slug: "future-model", display_name: "Future model", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }, { effort: "high" }, { effort: "invalid" }] },
    { slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [] },
    { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: ["low"] },
  ] });
  assert.deepEqual(result, [
    { id: "future-model", name: "Future model", reasoningEfforts: ["low", "high"] },
    { id: "gpt-6.1-sol", name: "gpt-6.1-sol", reasoningEfforts: [] },
  ]);
});

test("API-key catalog uses documented exact models, without guessing variants", () => {
  const result = modelCatalog({ data: ["gpt-6.1-sol", "gpt-5.5-2026-04-23", "gpt-5.1", "gpt-5", "gpt-6-astra-pro", "gpt-4.1", "gpt-image-1"].map(id => ({ id })) });
  assert.deepEqual(result.map(model => model.reasoningEfforts), [
    ["low", "medium", "high", "xhigh", "max"], ["none", "low", "medium", "high", "xhigh"],
    ["none", "low", "medium", "high"], ["minimal", "low", "medium", "high"], [], [],
  ]);
});

test("Auto omits an effort override and unsupported choices are refused", () => {
  const model = { reasoningEfforts: ["low", "high"] };
  assert.equal(resolveEffort(undefined, "auto"), undefined);
  assert.equal(resolveEffort(model, "high"), "high");
  for (const value of ["max", "none", "bogus", 1, {}]) assert.throws(() => resolveEffort(model, value), /not available/);
  assert.throws(() => resolveEffort(undefined, "high"), /not available/);
  assert.equal(normalizeSettings({ reasoningEffort: "high" }).reasoningEffort, "high");
  assert.equal(normalizeSettings({ reasoningEffort: "invalid" }).reasoningEffort, "auto");
});
