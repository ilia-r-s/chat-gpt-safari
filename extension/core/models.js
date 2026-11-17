export const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const EFFORT_LABELS = Object.freeze({ auto: "Auto", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });

// Public model docs checked 2026-11-17. Explicit catalog capabilities take
// precedence; do not infer support for unknown variants from a family prefix.
const documented = Object.fromEntries([
  [["gpt-6.1-sol", "gpt-6-astra"], ["low", "medium", "high", "xhigh", "max"]],
  [["gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol"], ["none", "low", "medium", "high", "xhigh", "max"]],
  [["gpt-5.5", "gpt-5.4", "gpt-5.2"], ["none", "low", "medium", "high", "xhigh"]],
  [["gpt-5.1"], ["none", "low", "medium", "high"]],
  [["gpt-5"], ["minimal", "low", "medium", "high"]],
  [["o3"], ["low", "medium", "high"]],
].flatMap(([names, efforts]) => names.map(name => [name, efforts])));

export function normalizeEffort(value) { return EFFORTS.includes(value) ? value : "auto"; }

export function modelCatalog(data) {
  const plan = Array.isArray(data?.models);
  const entries = plan ? data.models : Array.isArray(data?.data) ? data.data : [];
  return entries.filter(model => model && (plan ? model.visibility === "list"
    : typeof model.id === "string" && /^(gpt-|o[134])/.test(model.id) && !/audio|realtime|transcribe|image|tts|search|instruct/.test(model.id)))
    .slice(0, 500).flatMap(model => {
      const id = plan ? model.slug : model.id;
      if (typeof id !== "string" || !id || id.length > 120) return [];
      const name = typeof model.display_name === "string" && model.display_name ? model.display_name.slice(0, 160) : id;
      const supported = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map(level => typeof level === "string" ? level : level?.effort)
        : documented[id.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? [];
      return [{ id, name, reasoningEfforts: EFFORTS.filter(effort => supported.includes(effort)) }];
    });
}

export function resolveEffort(model, value = "auto") {
  if (value === "auto") return undefined;
  if (!EFFORTS.includes(value) || !model?.reasoningEfforts?.includes(value)) {
    throw new Error("This reasoning effort is not available for the selected model. Choose Auto or refresh the model list.");
  }
  return value;
}
