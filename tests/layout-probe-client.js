(() => {
  const input = document.getElementById('messageInput');
  if (!input || window.innerWidth > 700) return;
  const samples = [];
  let sending = false;
  let timer = 0;
  let count = 0;
  const mode = (value) => ['adjustPan', 'adjustResize', 'nothing'].indexOf(value) + 1;
  const number = (value) => { const n = parseFloat(value); return Number.isFinite(n) ? n : -1; };
  const flush = async () => {
    timer = 0;
    if (sending || !samples.length) return;
    sending = true;
    const batch = samples.splice(0, 32);
    const token = sessionStorage.getItem('gatewayToken');
    try {
      await fetch('/api/layout-probe', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ samples: batch }), keepalive: true });
    } catch { /* 诊断传输失败不干扰聊天。 */ }
    finally {
      sending = false;
      if (samples.length) timer = setTimeout(flush, 100);
    }
  };
  const sample = (event) => {
    if (++count > 600) return;
    const viewport = window.visualViewport;
    const messages = document.getElementById('messages');
    const record = { time: Math.round(performance.now()), event, app: !!window.__codexDeckAppReady,
      focused: document.activeElement === input, innerHeight, innerWidth, scrollY,
      documentHeight: document.documentElement.scrollHeight, visualHeight: viewport?.height,
      visualTop: viewport?.offsetTop, visualPageTop: viewport?.pageTop, visualScale: viewport?.scale,
      messagesScroll: messages.scrollTop, messagesHeight: messages.clientHeight,
      messagesContentHeight: messages.scrollHeight };
    // 仅采集几何坐标和键盘模式，不读取输入值、消息文字、聊天标题或地址。
    for (const [name, selector] of [['app', '.app'], ['header', '.conversation-head'],
      ['input', '#messageInput'], ['composer', '.composer'], ['messages', '#messages']]) {
      const rect = document.querySelector(selector).getBoundingClientRect();
      record[name + 'Top'] = rect.top;
      record[name + 'Bottom'] = rect.bottom;
    }
    try {
      const view = window.plus?.webview?.currentWebview();
      const style = view?.getStyle();
      const parent = view?.parent()?.getStyle();
      record.nativeMode = mode(style?.softinputMode);
      record.parentMode = mode(parent?.softinputMode);
      record.nativeTop = number(style?.top);
      record.nativeHeight = number(style?.height);
      record.parentTop = number(parent?.top);
      record.parentHeight = number(parent?.height);
    } catch { /* 普通浏览器没有原生窗口。 */ }
    samples.push(record);
    if (!timer) timer = setTimeout(flush, 100);
  };
  for (const event of ['focus', 'blur']) input.addEventListener(event, () => {
    sample(event);
    for (const delay of [100, 300, 600, 1000, 1600]) setTimeout(() => sample('settle'), delay);
  });
  window.addEventListener('resize', () => sample('windowResize'));
  // 在页面的滚动恢复处理前记录，避免只看到归零后的坐标而漏掉系统自动上滚。
  window.addEventListener('scroll', () => sample('windowScroll'), true);
  window.visualViewport?.addEventListener('resize', () => sample('visualResize'));
  window.visualViewport?.addEventListener('scroll', () => sample('visualScroll'));
  window.addEventListener('codexdeck-app-ready', () => sample('appReady'));
  document.addEventListener('plusready', () => sample('plusReady'));
  sample('init');
})();
