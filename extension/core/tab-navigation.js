export async function readyTab(api, tabId, signal, committed = () => true, timeoutMessage = "The page is still loading. Read this same tab again after it finishes.") {
  signal.throwIfAborted();
  const tab = await api.tabs.get(tabId);
  signal.throwIfAborted();
  const ready = value => value.status !== "loading" && committed(value);
  if (ready(tab)) return tab;
  return new Promise((resolve, reject) => {
    let done = false, poll;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(poll);
      api.tabs.onUpdated?.removeListener(updated); api.tabs.onRemoved?.removeListener(removed); signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve(value);
    };
    const updated = (id, change, value) => { if (id === tabId && change.status !== "loading" && value && ready(value)) finish(null, value); };
    const removed = id => { if (id === tabId) finish(new Error("The tab was closed while loading.")); };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), 10000);
    api.tabs.onUpdated?.addListener(updated); api.tabs.onRemoved?.addListener(removed); signal.addEventListener("abort", aborted, { once: true });
    // A website permission change can reveal a URL without a navigation event.
    const check = async () => {
      try {
        const value = await api.tabs.get(tabId);
        if (done) return;
        if (ready(value)) finish(null, value);
        else poll = setTimeout(check, 250);
      } catch (error) { finish(error); }
    };
    if (signal.aborted) aborted(); else check();
  });
}

export async function watchNavigation(api, tabId, previousURL, signal, dispatch, navigationRequested) {
  signal.throwIfAborted();
  if (!api.tabs.onUpdated) return dispatch();
  // Collect tab events before dispatch. A fast redirect can already have
  // returned to the original URL by the time Safari acknowledges the action.
  let started = false, finished = false, wake, timer;
  const updated = (id, change) => {
    if (id !== tabId || (!change.status && !change.url)) return;
    started = true;
    if (change.status) finished = change.status === "complete";
    wake?.();
  };
  api.tabs.onUpdated.addListener(updated);
  try {
    let result, lostDocument;
    try { result = await dispatch(); }
    catch (error) {
      if (navigationRequested || !/context was destroyed|frame (?:was )?removed|document (?:was )?unloaded|page did not confirm/i.test(error.message)) throw error;
      lostDocument = error;
    }
    // Link default actions run after the click handler returns. Give Safari a
    // short opportunity to report navigation even when injection succeeded.
    if (!started && !navigationRequested) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 300); });
    signal.throwIfAborted();
    if (started || navigationRequested) await readyTab(api, tabId, signal, tab => finished || tab.url !== previousURL);
    if (lostDocument) {
      if (!started) throw lostDocument;
      return { navigationObserved: true, message: "The tab navigated during the click. Read the new page to verify the result before taking another action." };
    }
    return result;
  } finally { clearTimeout(timer); api.tabs.onUpdated.removeListener(updated); }
}
