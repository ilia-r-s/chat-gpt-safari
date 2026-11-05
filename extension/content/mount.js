(() => {
  if (globalThis.__safariChatMount) return;
  globalThis.__safariChatMount = true;
  let host;
  let frame;
  browser.runtime.onMessage.addListener(message => {
    if (message.type === "panel.close") {
      host?.remove(); host = null; frame = null;
      return Promise.resolve({ ok: true });
    }
    if (message.type !== "panel.show") return;
    if (!host?.isConnected) {
      host = document.createElement("div");
      host.id = "safari-chat-host";
      host.style.cssText = "all:initial!important;position:fixed!important;inset:0 0 0 auto!important;width:min(440px,100vw)!important;height:100dvh!important;z-index:2147483647!important;display:block!important;color-scheme:light dark!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      frame = document.createElement("iframe");
      frame.title = "Safari Chat";
      frame.src = message.url;
      frame.style.cssText = "display:block;width:100%;height:100%;border:0;border-left:1px solid #8884;box-shadow:-8px 0 35px #0001;background:#faf9f6;";
      shadow.append(frame);
      document.documentElement.append(host);
    }
    frame.focus();
    return Promise.resolve({ ok: true });
  });
})();
