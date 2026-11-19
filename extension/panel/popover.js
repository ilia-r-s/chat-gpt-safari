// Position a native popover without covering its trigger in a narrow chat window.
export function anchorPopover(menu, trigger, width) {
  function position() {
    const rect = trigger.getBoundingClientRect(), margin = 8;
    const above = rect.top - margin * 2, below = innerHeight - rect.bottom - margin * 2;
    const size = `min(${width}px, 100vw - ${margin * 2}px)`;
    menu.style.width = size;
    menu.style.left = `clamp(${margin}px, ${rect.left}px, 100vw - ${size} - ${margin}px)`;
    menu.style.top = below > above ? `${rect.bottom + margin}px` : "auto";
    menu.style.bottom = below > above ? "auto" : `${innerHeight - rect.top + margin}px`;
    menu.style.maxHeight = `${Math.max(0, above, below)}px`;
  }
  menu.addEventListener("beforetoggle", event => { if (event.newState === "open") position(); });
  menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
  window.addEventListener("resize", () => { if (menu.matches(":popover-open")) position(); });
  return () => { if (menu.matches(":popover-open")) menu.hidePopover(); };
}
