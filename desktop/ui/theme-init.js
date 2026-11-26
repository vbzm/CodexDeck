const requested = new URLSearchParams(location.search).get('theme');
let saved = null;
try { saved = localStorage.getItem('theme'); } catch { /* 使用默认主题。 */ }
document.documentElement.dataset.theme = requested === 'dark' || requested === 'light' ? requested :
  (saved === 'dark' ? 'dark' : 'light');
