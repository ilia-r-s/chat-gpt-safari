// Install a local visibility check on the last authorized viewport snapshot.
// It returns only the match and never clicks or changes a page.
export function configureGallerySearch(url) {
  const refs = globalThis.__safariChatRefs;
  if (!refs || refs.url !== url || location.href !== url) throw new Error("The page changed. Read it again.");
  function exposed(element, rect) {
    const left = Math.max(0, rect.left), right = Math.min(globalThis.__safariChatPageRight ?? innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top || !refs.visible(element)) return false;
    return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  }
  function revealControls(scope, element) {
    const edge = Math.min(innerWidth, globalThis.__safariChatPageRight ?? innerWidth);
    const initial = element.getBoundingClientRect();
    if (initial.width <= edge && (initial.left < 0 || initial.right > edge)) {
      element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    const rect = element.getBoundingClientRect();
    const area = scope === document.scrollingElement ? { top: 0, bottom: innerHeight } : scope.getBoundingClientRect();
    const top = Math.max(0, area.top), bottom = Math.min(innerHeight, area.bottom);
    const margin = Math.min(32, (bottom - top) / 8);
    if (rect.height > bottom - top - 2 * margin) return;
    // A sliver entering the viewport is enough to discover the carousel.
    // Bring the full controls into reach before returning to the model.
    const dy = Math.max(0, rect.bottom - bottom + margin) + Math.min(0, rect.top - top - margin);
    if (dy) scope.scrollBy({ top: dy, behavior: "instant" });
  }
  refs.probe = scope => {
    for (const list of Array.from(scope.querySelectorAll("[role=tablist]")).slice(0, 40)) {
      if (!refs.visible(list)) continue;
      const result = refs.galleryFor(list);
      if (result?.tabs.some(tab => exposed(tab.element, tab.element.getBoundingClientRect()))) {
        revealControls(scope, list);
        return result.label + " navigation";
      }
    }
    const candidates = scope.querySelectorAll('[aria-roledescription~="carousel" i],[class*="carousel" i],[class*="gallery" i],[id*="carousel" i],[id*="gallery" i],[role="region"],[role="group"]');
    for (const element of Array.from(candidates).slice(0, 400)) {
      if (!refs.visible(element)) continue;
      const name = element.getAttribute("aria-label") || "";
      const marked = /carousel|gallery|slideshow/i.test([element.id, element.className, name, element.getAttribute("aria-roledescription")].join(" "));
      const style = getComputedStyle(element);
      if ((marked || style.scrollSnapType !== "none") && /^(auto|scroll)$/.test(style.overflowX) && refs.scrollDirections(element).includes("left") && exposed(element, element.getBoundingClientRect())) return name.slice(0, 100) || "Horizontal gallery";
      if (marked && !element.querySelector("[role=tablist]")) {
        for (const control of Array.from(element.querySelectorAll("button,[role=button]")).slice(0, 40)) {
          if (/previous|next|slide (?:left|right)/i.test(control.getAttribute("aria-label") || control.textContent) && exposed(control, control.getBoundingClientRect())) {
            revealControls(scope, control);
            return name.slice(0, 100) || "Carousel controls";
          }
        }
      }
    }
    return null;
  };
  return true;
}
