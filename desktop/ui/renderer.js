const api = window.launcher;
const $ = (id) => document.getElementById(id);
let currentState = null;
let entries = [];
let filter = 'all';
let settingsLoaded = false;
let actionRunning = false;
let themeSaving = false;
let toastTimer;

function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
}

function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function setView(view) {
  for (const id of ['overview', 'logs', 'settings']) $(id).hidden = id !== view;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  }
  $('topTitle').textContent = view === 'overview' ? '控制台概览' : view === 'logs' ? '运行日志' : '设置';
}

function badge(id, label, tone) {
  const element = $(id);
  element.textContent = label;
  element.className = 'badge' + (tone === 'good' ? '' : ' ' + tone);
}

function gatewayAddress(settings) {
  let host = settings.gatewayHost;
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  return (host.includes(':') ? `[${host}]` : host) + ':' + settings.gatewayPort;
}

function statusSummary(state) {
  const desktop = state.desktop.state;
  const gateway = state.gateway.state;
  if (state.busy || actionRunning) return ['正在处理', '请稍候，启动器正在执行操作。', 'warn', 'refresh', '重新检查'];
  if (desktop === 'error') return ['Desktop 状态检查失败', state.desktop.detail, 'bad', 'refresh', '重新检查'];
  if (gateway === 'conflict') return ['网关端口被占用', '请停止占用端口的程序，或在设置中更换网关端口。', 'bad', 'viewLogs', '查看日志'];
  if (gateway === 'error') return ['网关运行异常', state.gateway.detail, 'bad', 'viewLogs', '查看日志'];
  if (desktop === 'needsRestart') return ['需要重启 Codex Desktop', 'Desktop 正在运行，但未启用 CDP。请保存工作后确认重启。', 'warn', 'restartDesktop', '重启并启用 CDP'];
  if (desktop === 'stopped') return ['服务尚未启动', '启动全部会先启动 Codex Desktop，再启动网关。', 'warn', 'startAll', '启动全部'];
  if (gateway === 'starting') return ['正在启动网关', state.gateway.detail, 'warn', 'refresh', '重新检查'];
  if (gateway === 'stopped') return ['网关尚未启动', 'Codex Desktop 已就绪，可以启动网关。', 'warn', 'startGateway', '启动网关'];
  if ((gateway === 'running' || gateway === 'external') && !state.gateway.connected) {
    return ['等待 Desktop 桥接', '网关已运行；打开网页后会尝试重新连接 Desktop。', 'warn', 'openWeb', '打开聊天网页 ↗'];
  }
  return ['服务已就绪', 'Codex Desktop 与网关均正常运行，可以打开聊天网页。', 'good', 'openWeb', '打开聊天网页 ↗'];
}

function renderState(state) {
  currentState = state;
  if (!themeSaving && (state.theme === 'dark' || state.theme === 'light')) applyTheme(state.theme);
  const [title, detail, tone, action, primary] = statusSummary(state);
  $('heroTitle').textContent = title;
  $('heroDetail').textContent = detail;
  $('heroIcon').textContent = tone === 'good' ? '✓' : tone === 'warn' ? '!' : '×';
  $('heroIcon').className = 'hero-icon' + (tone === 'good' ? '' : ' ' + tone);
  $('heroPrimary').dataset.action = action;
  $('heroPrimary').textContent = primary;
  $('topStatus').textContent = state.busy || actionRunning ? '操作中' : tone === 'good' ? '已就绪' : '需要处理';
  $('checkedAt').textContent = state.checkedAt ? '检查于 ' + state.checkedAt : '尚未检查';

  const desktopLabels = {
    ready: ['已连接', '正在运行', 'good'],
    stopped: ['已停止', '未运行', 'warn'],
    needsRestart: ['需重启', '正在运行', 'warn'],
    starting: ['启动中', '正在启动', 'warn'],
    error: ['检查失败', '未知', 'bad'],
  };
  const [desktopBadge, desktopProcess, desktopTone] = desktopLabels[state.desktop.state];
  badge('desktopBadge', desktopBadge, desktopTone);
  $('desktopProcess').textContent = desktopProcess;
  $('desktopAddress').textContent = '127.0.0.1:' + state.settings.cdpPort;
  $('desktopOperation').textContent = state.desktop.detail;

  const gatewayLabels = {
    running: ['运行中', 'good'], external: ['已运行', 'good'],
    stopped: ['已停止', 'warn'], starting: ['启动中', 'warn'],
    conflict: ['端口占用', 'bad'], error: ['运行异常', 'bad'],
  };
  const [gatewayBadge, gatewayTone] = gatewayLabels[state.gateway.state];
  badge('gatewayBadge', gatewayBadge, gatewayTone);
  $('gatewayProcess').textContent = state.gateway.detail;
  $('gatewayAddress').textContent = gatewayAddress(state.settings);
  $('gatewayConnection').textContent = state.gateway.connected ? 'Desktop 已连接' :
    ['running', 'external'].includes(state.gateway.state) ? '等待 Desktop 连接' : '未连接';
  $('gatewayProtection').textContent = ['127.0.0.1', '::1', 'localhost'].includes(state.settings.gatewayHost)
    ? '仅本机访问' : state.hasToken ? '访问令牌已启用' : '未设置访问令牌';

  const disabled = state.busy || actionRunning;
  $('settingsForm').querySelector('button[type="submit"]').disabled = disabled;
  for (const button of document.querySelectorAll('[data-action]')) {
    const name = button.dataset.action;
    button.disabled = disabled ||
      (name === 'startDesktop' && state.desktop.state !== 'stopped') ||
      (name === 'restartDesktop' && !['ready', 'needsRestart'].includes(state.desktop.state)) ||
      (name === 'stopDesktop' && !['ready', 'needsRestart'].includes(state.desktop.state)) ||
      (name === 'startGateway' && (state.desktop.state !== 'ready' || state.gateway.managed ||
        !['stopped', 'error'].includes(state.gateway.state))) ||
      (name === 'stopGateway' && !state.gateway.managed) ||
      (name === 'openWeb' && !['running', 'external'].includes(state.gateway.state));
  }

  if (!settingsLoaded) {
    const settings = state.settings;
    $('gatewayHost').value = settings.gatewayHost;
    $('gatewayPort').value = settings.gatewayPort;
    $('workspace').value = settings.workspace;
    $('cdpPort').value = settings.cdpPort;
    document.querySelector('[name="startAllOnOpen"]').checked = settings.startAllOnOpen;
    document.querySelector('[name="startAtLogin"]').checked = settings.startAtLogin;
    settingsLoaded = true;
  }
  $('tokenHint').textContent = state.hasToken
    ? '令牌已加密保存；留空表示保持不变。' : '尚未设置令牌；可留空。对外监听时请留意访问范围。';
  document.querySelector('[name="startAtLogin"]').disabled = !state.canStartAtLogin;
}

function renderLogs() {
  const recent = $('recentEvents');
  const full = $('logList');
  recent.replaceChildren();
  full.replaceChildren();
  for (const entry of entries.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'event ' + (entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : '');
    const time = document.createElement('time'); time.textContent = entry.time.slice(0, 5);
    const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true');
    const message = document.createElement('span'); message.textContent = entry.message;
    row.append(time, dot, message); recent.append(row);
  }
  if (!recent.childElementCount) recent.textContent = '暂无事件';
  for (const entry of entries.filter((item) => filter === 'all' || item.source === filter)) {
    const row = document.createElement('div');
    row.className = 'log-row ' + (entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : '');
    const time = document.createElement('time'); time.textContent = entry.time;
    const source = document.createElement('b');
    source.textContent = entry.source === 'gateway' ? '网关' : entry.source === 'desktop' ? 'Desktop' : '启动器';
    const message = document.createElement('span'); message.textContent = entry.message;
    row.append(time, source, message); full.append(row);
  }
  if (!full.childElementCount) full.textContent = '暂无日志';
}

async function runAction(action) {
  if (action === 'viewLogs') { setView('logs'); return; }
  if (!api[action]) return;
  actionRunning = true;
  if (currentState) renderState(currentState);
  try {
    const result = await api[action]();
    if (result?.desktop && result?.gateway) renderState(result);
  } catch (error) {
    toast(errorText(error));
  } finally {
    actionRunning = false;
    if (currentState) renderState(currentState);
  }
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => { void runAction(button.dataset.action); });
});
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) =>
      item.classList.toggle('active', item === button));
    renderLogs();
  });
});
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  $('themeButton').setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题');
}

$('themeButton').addEventListener('click', async () => {
  if (themeSaving) return;
  themeSaving = true;
  const previous = document.documentElement.dataset.theme;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { await api.setTheme(theme); }
  catch (error) { applyTheme(previous); toast('主题同步失败：' + errorText(error)); }
  finally { themeSaving = false; }
});
$('copyLogs').addEventListener('click', async () => {
  const text = entries.filter((entry) => filter === 'all' || entry.source === filter)
    .map((entry) => `${entry.time} [${entry.source}] ${entry.message}`).join('\n');
  try { await navigator.clipboard.writeText(text); toast('可见日志已复制'); }
  catch { toast('复制失败，请检查系统剪贴板权限'); }
});
$('clearToken').addEventListener('change', () => {
  $('gatewayToken').disabled = $('clearToken').checked;
  if ($('clearToken').checked) $('gatewayToken').value = '';
});
$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (actionRunning || currentState?.busy) return;
  if (!$('settingsForm').reportValidity()) return;
  const input = {
    settings: {
      gatewayHost: $('gatewayHost').value.trim(),
      gatewayPort: Number($('gatewayPort').value),
      cdpPort: Number($('cdpPort').value),
      workspace: $('workspace').value.trim(),
      startAllOnOpen: document.querySelector('[name="startAllOnOpen"]').checked,
      startAtLogin: document.querySelector('[name="startAtLogin"]').checked,
    },
    tokenMode: $('clearToken').checked ? 'clear' : $('gatewayToken').value ? 'set' : 'keep',
    token: $('gatewayToken').value,
  };
  actionRunning = true;
  if (currentState) renderState(currentState);
  try {
    const result = await api.saveSettings(input);
    $('gatewayToken').value = '';
    $('clearToken').checked = false;
    $('gatewayToken').disabled = false;
    renderState(result);
    toast('设置已保存');
  } catch (error) {
    toast(errorText(error));
  } finally {
    actionRunning = false;
    if (currentState) renderState(currentState);
  }
});

applyTheme(document.documentElement.dataset.theme);
async function initialize() {
  try {
    entries = await api.logs();
    renderLogs();
    api.onLog((entry) => { entries.unshift(entry); entries = entries.slice(0, 500); renderLogs(); });
    api.onState(renderState);
    renderState(await api.snapshot());
  } catch (error) {
    toast('控制台初始化失败：' + errorText(error));
  }
}
void initialize();
