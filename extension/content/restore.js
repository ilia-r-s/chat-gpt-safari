// Runs only on permitted pages while a dock is open. The background decides
// whether this tab owns a dock. No page content enters the message.
(() => {
  function restore() { browser.runtime.sendMessage({ type: "dock.restore" }).catch(() => {}); }
  if (document.documentElement) restore();
  else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) { observer.disconnect(); restore(); }
    });
    observer.observe(document, { childList: true });
  }
})();
