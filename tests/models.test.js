import test from "node:test";
import assert from "node:assert/strict";
import { chatFamilies, chatLevel, modelCatalog, resolveEffort } from "../extension/core/models.js";

test("Chat offers authorized families and routes levels independently from Work", () => {
  const make = (...ids) => modelCatalog({ data: ids.map(id => ({ id })) });
  const [six, older] = chatFamilies(make("gpt-6.2-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol"));
  assert.deepEqual([six.name,older.name], ["GPT-6","GPT-5.6 Sol"]);
  assert.deepEqual(six.reasoningEfforts, ["instant","medium","high","xhigh","pro"]);
  assert.deepEqual(six.routes.instant, { model: "gpt-6-sol", effort: "none" });
  assert.deepEqual(six.routes.pro, { model: "gpt-6-astra", reasoningMode: "pro" });
  assert.deepEqual(older.routes.pro, { model: "gpt-5.6-sol", reasoningMode: "pro" });
  assert.equal(chatLevel(six, "auto"), "medium");
  assert.deepEqual(chatFamilies(make("gpt-6.2-sol")), []);
  const [instant] = chatFamilies(make("chat-latest"));
  assert.deepEqual(instant.reasoningEfforts, ["instant"]);
  assert.deepEqual(instant.routes.instant, {model: "chat-latest"});
  const [withAlias] = chatFamilies(make("gpt-6-sol", "chat-latest"));
  assert.deepEqual(withAlias.routes.instant, { model: "chat-latest" });
  assert.deepEqual(withAlias.routes.medium, { model: "gpt-6-sol", effort: "medium" });
  const [restricted] = chatFamilies(modelCatalog({models:[{visibility:"list",slug:"gpt-5.6-sol",supported_reasoning_levels:["high"],supported_reasoning_modes:["standard"]}]}));
  assert.deepEqual(restricted.reasoningEfforts, ["high"]);
});

test("Chat Latest appears in the API-key picker only when the connection lists it", () => {
  assert.deepEqual(modelCatalog({ data: [{ id: "chat-latest" }] }), [
    { id: "chat-latest", name: "Chat Latest (Instant)", reasoningEfforts: [] },
  ]);
  assert.deepEqual(modelCatalog({ data: [{ id: "chat-unavailable" }] }), []);
});
import { normalizeSettings } from "../extension/core/config.js";

test("Chat and ten minutes are the defaults for new and pre-mode settings", () => {
  for (const prefs of [undefined, { historyTurns: 4 }, { interactionMode: "unknown", turnMinutes: "invalid" }]) {
    assert.equal(normalizeSettings(prefs).interactionMode, "chat");
    assert.equal(normalizeSettings(prefs).turnMinutes, 10);
  }
  assert.equal(normalizeSettings({ interactionMode: "work" }).interactionMode, "work");
  assert.equal(normalizeSettings({ turnMinutes: 0 }).turnMinutes, 1);
  assert.equal(normalizeSettings({ turnMinutes: 1000 }).turnMinutes, 60);
});

test("model catalog preserves server reasoning capabilities and hides unavailable models", () => {
  const result = modelCatalog({ models: [
    { slug: "future-model", display_name: "Future model", visibility: "list", default_reasoning_level: "ultra", supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }, { effort: "high" }, { effort: "ultra", description: "More time for this task." }, { effort: "invalid effort" }] },
    { slug: "gpt-6.1-sol", visibility: "list", supported_reasoning_levels: [] },
    { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: ["low"] },
  ] });
  assert.deepEqual(result, [
    { id: "future-model", name: "Future model", reasoningEfforts: ["low", "high", "ultra"], defaultEffort: "ultra", effortDescriptions: { ultra: "More time for this task." } },
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

test("GPT-6.2 API listings expose the documented efforts unless the catalog advertises its own", () => {
  const models = modelCatalog({ data: [{ id: "gpt-6.2-astra" }, { id: "gpt-6.2-sol-2026-11-19" }, { id: "gpt-6.2-sol", supported_reasoning_levels: ["high"] }] });
  assert.deepEqual(models.map(model => model.reasoningEfforts), [
    ["low", "medium", "high", "xhigh", "max"], ["low", "medium", "high", "xhigh", "max"], ["high"],
  ]);
});

test("Auto omits an effort override and unsupported choices are refused", () => {
  const model = { reasoningEfforts: ["low", "high"] };
  assert.equal(resolveEffort(undefined, "auto"), undefined);
  assert.equal(resolveEffort(model, "high"), "high");
  for (const value of ["max", "none", "bogus", 1, {}]) assert.throws(() => resolveEffort(model, value), /not available/);
  assert.throws(() => resolveEffort(undefined, "high"), /not available/);
  assert.equal(normalizeSettings({ reasoningEffort: "high" }).reasoningEffort, "high");
  assert.equal(normalizeSettings({ reasoningEffort: "invalid effort" }).reasoningEffort, "auto");
  assert.equal(normalizeSettings({ reasoningEffort: "ultra" }).reasoningEffort, "ultra");
});
