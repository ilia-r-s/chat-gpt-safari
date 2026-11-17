const $ = id => document.getElementById(id);

export async function readTextFiles(files, limit) {
  if (files.length > 6) throw new Error("Choose up to six files.");
  for (const file of files) {
    if (file.size > 200000) throw new Error(`${file.name}: choose a file smaller than 200 KB.`);
    if (!/^text\//.test(file.type) && !/\.(txt|md|csv|json|log|js|ts|py|html|css|xml|ya?ml)$/i.test(file.name)) throw new Error("Choose text, Markdown, code or data files. Images and PDFs are not supported yet.");
  }
  const result = [];
  for (const file of files) {
    const text = await file.text();
    if (/[\u0000\uFFFD]/.test(text)) throw new Error(`${file.name}: use a UTF-8 text file.`);
    result.push({ kind: "file", key: `file:${file.name}`, title: file.name, text: text.slice(0, limit), truncated: text.length > limit });
  }
  return result;
}

export function setupAttachments({ state, add, readPage, listTabs, report }) {
  const menu = $("add-menu"), trigger = $("add-button");
  const closeMenu = () => { if (menu.matches(":popover-open")) menu.hidePopover(); };
  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.left - 12, innerWidth - Math.min(410, innerWidth - 24) - 12))}px`;
    menu.style.bottom = `${Math.max(12, innerHeight - rect.top + 8)}px`;
    menu.style.maxHeight = `${Math.max(140, Math.min(460, rect.top - 20))}px`;
  };
  menu.addEventListener("beforetoggle", event => { if (event.newState === "open") positionMenu(); });
  menu.addEventListener("toggle", () => { trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))); });
  window.addEventListener("resize", () => { if (menu.matches(":popover-open")) positionMenu(); });
  const run = callback => async () => {
    const owner = state().owner;
    closeMenu();
    try { await callback(); } catch (error) { if (owner === state().owner && !state().blocked) report(error.message); }
  };
  async function attachFiles(files) {
    const before = state();
    if (before.blocked || !files.length) return;
    let contexts;
    try { contexts = await readTextFiles(files, before.pageChars); }
    catch (error) { if (before.owner !== state().owner || state().blocked) return; throw error; }
    const now = state();
    if (before.owner !== now.owner || now.blocked) return;
    const keys = new Set([...now.contexts, ...contexts].map(context => context.key));
    if (keys.size > 6) throw new Error("You can attach up to six sources per message. Remove a source before adding more.");
    for (const context of contexts) add(context);
  }
  $("attach-file").onclick = run(() => $("file-input").click());
  $("file-input").onchange = run(async () => {
    const files = [...$("file-input").files]; $("file-input").value = "";
    await attachFiles(files);
  });
  document.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (!state().blocked) document.body.dataset.fileDrag = "true";
  });
  document.addEventListener("dragleave", event => { if (!event.relatedTarget) delete document.body.dataset.fileDrag; });
  document.addEventListener("drop", event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); delete document.body.dataset.fileDrag;
    attachFiles([...event.dataTransfer.files]).catch(error => report(error.message));
  });
  $("prompt").addEventListener("paste", event => {
    if (!event.clipboardData?.files.length) return;
    event.preventDefault(); attachFiles([...event.clipboardData.files]).catch(error => report(error.message));
  });

  let tabs = [], selected = new Set(), owner, loading = false, revision = 0;
  const updateSelection = () => {
    $("add-selected-tabs").textContent = selected.size ? `Add ${selected.size} ${selected.size === 1 ? "tab" : "tabs"}` : "Add tabs";
    $("add-selected-tabs").disabled = loading || selected.size === 0 || state().blocked;
  };
  function renderTabs() {
    $("tabs-list").replaceChildren();
    const query = $("tabs-search").value.toLowerCase().trim();
    const matches = tabs.filter(tab => `${tab.title} ${tab.url}`.toLowerCase().includes(query));
    for (const tab of matches) {
      const label = document.createElement("label"); label.className = "tab-choice";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = selected.has(tab.id); check.disabled = loading;
      const text = document.createElement("span"); text.textContent = tab.title || "Untitled tab";
      const url = document.createElement("small"); url.textContent = tab.url; text.append(url);
      check.onchange = () => {
        if (check.checked) selected.add(tab.id); else selected.delete(tab.id);
        if (selected.size + state().contexts.length > 6) {
          selected.delete(tab.id); check.checked = false;
          $("tabs-status").textContent = "Up to six sources fit in a message. Remove a source to make room.";
        } else $("tabs-status").textContent = "Only the tabs you select will be read.";
        updateSelection();
      };
      label.append(check, text); $("tabs-list").append(label);
    }
    if (!matches.length) $("tabs-list").textContent = tabs.length ? "No matching tabs." : "No accessible tabs. Open Safari Chat on a website first.";
    updateSelection();
  }
  const openTabs = run(async () => {
    const before = state(); if (before.blocked) return;
    const request = ++revision;
    const available = await listTabs();
    if (request !== revision || before.owner !== state().owner || state().blocked) return;
    tabs = available; selected = new Set(); owner = before.owner; loading = false;
    $("tabs-search").value = ""; $("tabs-status").textContent = "Only the tabs you select will be read.";
    renderTabs(); $("tabs-dialog").showModal(); $("tabs-search").focus();
  });
  $("attach-tabs").onclick = openTabs; $("menu-tabs").onclick = openTabs;
  $("menu-page").onclick = run(() => readPage());
  $("tabs-search").oninput = renderTabs;
  $("add-selected-tabs").onclick = async () => {
    if (loading || owner !== state().owner || state().blocked) return;
    const request = revision, batchOwner = owner;
    loading = true; renderTabs(); $("tabs-status").textContent = "Adding selected tabs…";
    try {
      for (const id of [...selected]) {
        if (request !== revision || batchOwner !== state().owner || state().blocked) return;
        await readPage(id);
        if (request !== revision || batchOwner !== state().owner) return;
        selected.delete(id);
      }
      $("tabs-dialog").close();
    } catch (error) { if (request === revision) $("tabs-status").textContent = error.message; }
    finally { if (request === revision) { loading = false; renderTabs(); } }
  };
  return { closeMenu, reset() {
    revision++; closeMenu(); tabs = []; selected.clear(); owner = null; loading = false;
    $("tabs-dialog").close(); $("tabs-list").replaceChildren(); $("tabs-search").value = ""; $("tabs-status").textContent = "";
    delete document.body.dataset.fileDrag;
  } };
}
