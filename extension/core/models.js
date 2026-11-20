export const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const EFFORT_LABELS = Object.freeze({ auto: "Model default", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });

// Public model docs checked 2026-11-19. Explicit catalog capabilities take
// precedence; do not infer support for unknown variants from a family prefix.
const documented = Object.fromEntries([
  [["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-astra"], ["low", "medium", "high", "xhigh", "max"]],
  [["gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol"], ["none", "low", "medium", "high", "xhigh", "max"]],
  [["gpt-5.5", "gpt-5.4", "gpt-5.2"], ["none", "low", "medium", "high", "xhigh"]],
  [["gpt-5.1"], ["none", "low", "medium", "high"]],
  [["gpt-5"], ["minimal", "low", "medium", "high"]],
  [["o3"], ["low", "medium", "high"]],
].flatMap(([names, efforts]) => names.map(name => [name, efforts])));

// Keep server-advertised levels across reloads. Inference separately checks
// membership against the selected model's current catalog entry.
export function normalizeEffort(value) { return typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : "auto"; }

export function modelCatalog(data) {
  const plan = Array.isArray(data?.models);
  const entries = plan ? data.models : Array.isArray(data?.data) ? data.data : [];
  return entries.filter(model => model && (plan ? model.visibility === "list"
    : typeof model.id === "string" && (model.id === "chat-latest" || /^(gpt-|o[134])/.test(model.id) && !/audio|realtime|transcribe|image|tts|search|instruct/.test(model.id))))
    .slice(0, 500).flatMap(model => {
      const id = plan ? model.slug : model.id;
      if (typeof id !== "string" || !id || id.length > 120) return [];
      const name = typeof model.display_name === "string" && model.display_name ? model.display_name.slice(0, 160) : id === "chat-latest" ? "Chat Latest (Instant)" : id;
      const supported = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map(level => typeof level === "string" ? level : level?.effort)
        : documented[id.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? [];
      const advertised = [...new Set(supported.map(normalizeEffort))].filter(value => value !== "auto");
      const reasoningEfforts = [...EFFORTS.filter(value => advertised.includes(value)), ...advertised.filter(value => !EFFORTS.includes(value))];
      const descriptions = Object.fromEntries((Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .filter(level => reasoningEfforts.includes(level?.effort) && typeof level.description === "string")
        .map(level => [level.effort, level.description.slice(0, 360)]));
      const modes = model.supported_reasoning_modes;
      return [{ id, name, reasoningEfforts,
        ...(reasoningEfforts.includes(model.default_reasoning_level) && { defaultEffort: model.default_reasoning_level }),
        ...(Object.keys(descriptions).length && { effortDescriptions: descriptions }),
        ...(Array.isArray(modes) && { allowsPro: modes.some(mode => (mode?.mode ?? mode) === "pro") }) }];
    });
}

// Product families are a presentation of explicit Responses routes. Never place
// an unrelated Work model under a Chat label when an account lacks a route.
export function chatFamilies(catalog) {
  const find = (...names) => names.map(name => catalog.find(m => m.id === name) ||
    catalog.find(m => m.id.replace(/-\d{4}-\d{2}-\d{2}$/, "") === name)).find(Boolean);
  function family(id, name, standard, pro, dedicated, instant) {
    const routes = {};
    if (instant) routes.instant = { model: instant.id };
    else if (standard?.reasoningEfforts.includes("none")) routes.instant = { model: standard.id, effort: "none" };
    for (const effort of ["medium", "high", "xhigh"]) {
      if (standard?.reasoningEfforts.includes(effort)) routes[effort] = { model: standard.id, effort };
    }
    if (dedicated) routes.pro = { model: dedicated.id };
    else if (pro && pro.allowsPro !== false) routes.pro = { model: pro.id, reasoningMode: "pro" };
    const reasoningEfforts = Object.keys(routes);
    return reasoningEfforts.length ? [{ id, name, routes, reasoningEfforts, defaultEffort: standard?.defaultEffort === "none" ? "instant" : standard?.defaultEffort }] : [];
  }
  const sol = find("gpt-6-sol"), astra = find("gpt-6-astra"), latest = find("chat-latest");
  const older = find("gpt-5.6-sol", "gpt-5.6");
  const pro = find("gpt-6-pro", "gpt-6-astra-pro");
  const standalone = !sol && !astra && !pro && latest;
  return [
    ...family(standalone ? latest.id : "gpt-6", standalone ? "Chat Latest" : "GPT-6", sol, astra, pro, latest),
    ...family("gpt-5.6-sol", "GPT-5.6 Sol", older, older, find("gpt-5.6-sol-pro", "gpt-5.6-pro")),
  ];
}

export function chatLevel(family, preference) {
  if (family && Object.hasOwn(family.routes, preference)) return preference;
  if (family?.routes[family.defaultEffort]) return family.defaultEffort;
  return family?.routes.medium ? "medium" : family?.reasoningEfforts[0];
}

export function resolveEffort(model, value = "auto") {
  if (value === "auto") return undefined;
  if (!model?.reasoningEfforts?.includes(value)) {
    throw new Error("This reasoning effort is not available for the selected model. Choose Model default or reload the model list.");
  }
  return value;
}
