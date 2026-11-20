import { chatFamilies, chatLevel, EFFORT_LABELS } from "../core/models.js";
import { anchorPopover } from "./popover.js";

const $ = id => document.getElementById(id);

export function setupModelPicker(onChange) {
  const trigger = $("model-trigger"), menu = $("model-popover"), slider = $("effort");
  const close = anchorPopover(menu, trigger, 280, "center");
  let models = [], selected, preferred, levels = [], effort = "auto";
  const labels = new Map(Object.entries({ ...EFFORT_LABELS, low: "Light", instant: "Instant", pro: "Pro" }));
  const label = value => labels.get(value) || (value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]/g, " ") : "");

  function showList(list, focus = false) {
    $("model-view").hidden = !list;
    $("effort-view").hidden = list;
    $("back-to-effort").hidden = !selected || (mode !== "chat" && levels.length < 2);
    if (focus) (list ? $("model-list").querySelector('[aria-pressed="true"]') || $("model-list").firstElementChild : $("select-model"))?.focus();
  }
  function row(id, name, detail) {
    const button = document.createElement("button");
    button.type = "button"; button.dataset.model = id;
    button.setAttribute("aria-pressed", String(preferred === id));
    const title = document.createElement("span"); title.textContent = name; button.append(title);
    if (detail) { const hint = document.createElement("small"); hint.textContent = detail; button.append(hint); }
    button.onclick = () => {
      const next = id ? models.find(m => m.id === id) : defaultModel();
      onChange(id, mode === "chat" ? chatLevel(next, effort) : next?.reasoningEfforts.includes(effort) ? effort : "auto");
      if (next?.reasoningEfforts.length) showList(false, true);
      else { close(); trigger.focus(); }
    };
    return button;
  }
  let mode = "chat";
  function defaultModel() {
    return models[0];
  }
  function render(choices, currentMode, modelID, preferredEffort) {
    mode = currentMode;
    const chat = mode === "chat";
    models = chat ? chatFamilies(choices) : choices;
    preferred = modelID || "";
    if (chat && !models.some(model => model.id === preferred)) preferred = models.find(model => model.reasoningEfforts.some(level => level !== "pro"))?.id || "";
    selected = preferred ? models.find(m => m.id === preferred) : chat ? undefined : defaultModel();
    levels = chat ? selected?.reasoningEfforts || [] : ["auto", ...(selected?.reasoningEfforts || [])];
    effort = chat ? chatLevel(selected, preferredEffort) : levels.includes(preferredEffort) ? preferredEffort : "auto";
    const name = selected?.name || (chat && choices.length && !models.length ? "No Chat models" : "Choose model");
    $("model-name").textContent = name;
    $("effort-name").textContent = effort && (chat || levels.length > 1) ? (effort === "auto" ? "Default" : label(effort)) : "";
    trigger.title = selected ? name + " · " + label(effort) : chat && choices.length && !models.length ? "This connection lists no supported Chat models. Work has its own model list." : name;
    $("select-model").firstChild.textContent = name + " ";
    $("effort-value").value = chat || levels.length > 1 ? label(effort) : "Model";
    $("effort-control").hidden = !selected || (!chat && levels.length < 2);
    slider.hidden = levels.length < 2;
    const choicesRow = $("chat-levels");
    choicesRow.hidden = !chat;
    choicesRow.replaceChildren(...(chat ? levels.map(level => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label(level);
      button.setAttribute("aria-pressed", String(level === effort));
      button.onclick = () => { onChange(preferred, level); close(); trigger.focus(); };
      return button;
    }) : []));
    $("reset-effort").hidden = chat || effort === "auto";
    let hint = effort === "auto" ? selected?.defaultEffort ? "The account catalog lists " + label(selected.defaultEffort) + " as the default." : "Model default uses the provider’s default effort." : selected?.effortDescriptions?.[effort];
    if (chat && selected && !selected.routes.instant) hint = "Instant is unavailable for this model on this connection.";
    $("effort-hint").hidden = !hint; $("effort-hint").textContent = hint || "";
    slider.max = String(Math.max(0, levels.length - 1)); slider.value = String(Math.max(0, levels.indexOf(effort)));
    slider.setAttribute("aria-valuetext", label(effort) || "");
    slider.style.setProperty("--fill", (100 * Number(slider.value) / Math.max(1, levels.length - 1)) + "%");
    const gaps = levels.length - 1;
    // Dots align to the native thumb's travel, inset by half its width.
    const dots = levels.map((_, i) => {
      const fraction = i / Math.max(1, gaps);
      return "radial-gradient(circle at calc(" + fraction * 100 + "% + " + (16 - 32 * fraction) + "px) 50%, #888 1.7px, transparent 2px)";
    });
    slider.style.setProperty("--dots", dots.join(","));
    const entries = [];
    if (!chat && models.length) entries.push(row("", "Default", "Use " + defaultModel().name));
    if (chat && !models.length && choices.length) {
      const empty = document.createElement("p"); empty.className = "muted";
      empty.textContent = "This connection has no available Chat family. Switch to Work to use its models.";
      entries.push(empty);
    }
    for (const model of models) entries.push(row(model.id, model.name));
    $("model-list").replaceChildren(...entries);
  }
  menu.addEventListener("beforetoggle", event => {
    if (event.newState === "open") showList(!selected || (mode !== "chat" && levels.length < 2));
  });
  $("select-model").onclick = () => showList(true, true);
  $("back-to-effort").onclick = () => showList(false, true);
  $("reset-effort").onclick = () => { onChange(preferred, "auto"); slider.focus(); };
  // Preview immediately during a drag and persist the final step on change.
  slider.oninput = () => {
    const value = levels[Number(slider.value)];
    $("effort-value").value = label(value);
    slider.setAttribute("aria-valuetext", label(value));
    slider.style.setProperty("--fill", (100 * Number(slider.value) / Math.max(1, levels.length - 1)) + "%");
  };
  slider.onchange = () => onChange(preferred, levels[Number(slider.value)]);
  return { render, close, get model() { return selected?.id; }, get effort() { return effort; } };
}
