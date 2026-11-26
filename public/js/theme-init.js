const root = document.documentElement;
if (root.dataset.theme !== 'dark' && root.dataset.theme !== 'light') {
  let saved = null;
  try { saved = localStorage.getItem('codexDeckTheme'); } catch { /* 使用系统主题。 */ }
  root.dataset.theme = saved === 'dark' || saved === 'light' ? saved :
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
document.querySelector('meta[name="theme-color"]').content =
  root.dataset.theme === 'dark' ? '#191a1b' : '#f7f7f5';
