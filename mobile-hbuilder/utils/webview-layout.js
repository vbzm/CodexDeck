export function createWebviewSetupScript(statusBarHeight) {
  const height = Math.max(0, Number(statusBarHeight) || 0);
  const inset = `max(${height}px, env(safe-area-inset-top, 0px))`;

  return `(() => {
    const apply = () => {
      const app = document.querySelector('.app');
      const conversation = document.querySelector('.conversation');
      const sidebar = document.querySelector('.sidebar');
      const conversationHead = document.querySelector('.conversation-head');
      if (!app || !conversation || !sidebar) return;
      const viewport = document.querySelector('meta[name="viewport"]');
      if (viewport) viewport.content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
      app.style.paddingTop = ${JSON.stringify(inset)};
      conversation.style.height = ${JSON.stringify(`calc(100dvh - ${inset})`)};
      sidebar.style.paddingTop = ${JSON.stringify(inset)};
      if (conversationHead && window.innerWidth <= 700) {
        conversationHead.style.minHeight = '68px';
        conversationHead.style.paddingTop = '2px';
        conversationHead.style.paddingBottom = '2px';
      }
      window.__codexDeckAppReady = true;
      window.dispatchEvent(new Event('codexdeck-app-ready'));
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
  })();`;
}
