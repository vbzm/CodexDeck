import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray,
  utilityProcess, UtilityProcess, IpcMainInvokeEvent } from 'electron';
import { defaultSettings, gatewayOrigin, LauncherSettings, validateSettings } from './config';
import { checkGatewayBridge, probeGateway, readDesktopStatus, runDesktopScript } from './services';
import { loadConfiguration, saveConfiguration } from './store';

type DesktopState = 'ready' | 'stopped' | 'needsRestart' | 'starting' | 'error';
type GatewayState = 'running' | 'external' | 'stopped' | 'starting' | 'conflict' | 'error';
type LogSource = 'launcher' | 'desktop' | 'gateway';
type LogLevel = 'info' | 'warn' | 'error';
type Theme = 'light' | 'dark';

interface LogEntry {
  time: string;
  source: LogSource;
  level: LogLevel;
  message: string;
}

interface Snapshot {
  desktop: { state: DesktopState; detail: string };
  gateway: { state: GatewayState; detail: string; connected: boolean; managed: boolean };
  busy: boolean;
  checkedAt: string;
  settings: LauncherSettings;
  hasToken: boolean;
  canStartAtLogin: boolean;
  theme: Theme | null;
}

interface SettingsInput {
  settings: unknown;
  tokenMode?: 'keep' | 'set' | 'clear';
  token?: unknown;
}

app.setName('CodexDeck');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let busy = false;
let refreshing = false;
let stoppingGateway = false;
let gateway: UtilityProcess | null = null;
let gatewayReady = false;
let gatewayStartedAt = 0;
let restartAttempts = 0;
let restartTimer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let configFile = '';
let themeFile = '';
let themeTimer: NodeJS.Timeout | null = null;
let desktopScript = '';
let gatewayRoot = '';
let configuration = { settings: defaultSettings(process.cwd()), token: '' };
const logs: LogEntry[] = [];
const snapshot: Snapshot = {
  desktop: { state: 'stopped', detail: '正在检查 Codex Desktop' },
  gateway: { state: 'stopped', detail: '正在检查网关', connected: false, managed: false },
  busy: false,
  checkedAt: '',
  settings: configuration.settings,
  hasToken: false,
  canStartAtLogin: false,
  theme: null,
};

async function readSavedTheme(): Promise<Theme | null> {
  try {
    const value = (await fs.readFile(themeFile, 'utf8')).trim();
    return value === 'dark' || value === 'light' ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function setTheme(value: unknown): Promise<Theme> {
  if (value !== 'dark' && value !== 'light') throw new Error('主题只能是深色或浅色');
  await fs.mkdir(path.dirname(themeFile), { recursive: true });
  const temporary = themeFile + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, value, 'utf8');
  try {
    await fs.rename(temporary, themeFile);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  snapshot.theme = value;
  publish();
  return value;
}

async function syncThemeFromFile(): Promise<void> {
  try {
    const theme = await readSavedTheme();
    if (theme !== snapshot.theme) {
      snapshot.theme = theme;
      publish();
    }
  } catch (error) {
    log('launcher', '读取主题失败：' + (error as Error).message, 'error');
  }
}

function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function assetPath(light: boolean): string {
  return path.join(app.getAppPath(), 'public', 'assets',
    light ? 'codex-logo-light.png' : 'codex-logo-dark.png');
}

function publish(): Snapshot {
  snapshot.busy = busy;
  snapshot.settings = { ...configuration.settings };
  snapshot.hasToken = Boolean(configuration.token);
  snapshot.canStartAtLogin = app.isPackaged && !isPortable();
  if (window && !window.isDestroyed()) window.webContents.send('launcher:state', snapshot);
  updateTrayMenu();
  return snapshot;
}

function localDay(): string {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function log(source: LogSource, message: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), source, level, message,
  };
  logs.unshift(entry);
  if (logs.length > 500) logs.length = 500;
  if (window && !window.isDestroyed()) window.webContents.send('launcher:log', entry);
  const file = path.join(app.getPath('userData'), 'logs', localDay() + '.jsonl');
  void fs.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8'))
    .catch((error: Error) => console.error('日志保存失败：' + error.message));
}

async function loadTodayLogs(): Promise<void> {
  const file = path.join(app.getPath('userData'), 'logs', localDay() + '.jsonl');
  try {
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').slice(-200);
    for (const line of lines) {
      try { logs.unshift(JSON.parse(line) as LogEntry); } catch { /* 单条损坏不影响启动。 */ }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('读取日志失败：' + (error as Error).message);
    }
  }
}

function trayImage() {
  const image = nativeImage.createFromPath(assetPath(nativeTheme.shouldUseDarkColors));
  return image.resize({ width: 20, height: 20 });
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  window.focus();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const gatewayActive = ['running', 'external'].includes(snapshot.gateway.state);
  tray.setToolTip('CodexDeck · ' + (gatewayActive ? '网关运行中' : '网关未运行'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: showWindow },
    { label: '启动全部', enabled: !busy, click: () => { void runOperation(startAll).catch(() => showWindow()); } },
    { label: '打开聊天网页', enabled: gatewayActive, click: () => {
      void openWeb().catch((error: Error) => { log('launcher', error.message, 'error'); showWindow(); });
    } },
    { type: 'separator' },
    { label: '停止网关', enabled: snapshot.gateway.managed && !busy,
      click: () => { void runOperation(stopGateway).catch(() => showWindow()); } },
    { type: 'separator' },
    { label: '退出 CodexDeck', click: () => app.quit() },
  ]));
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 820,
    height: 580,
    minWidth: 560,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    title: 'CodexDeck',
    icon: assetPath(false),
    backgroundColor: snapshot.theme === 'dark' ? '#191a1b' : '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window?.hide(); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) showWindow(); });
  void window.loadFile(path.join(app.getAppPath(), 'desktop', 'ui', 'index.html'),
    { query: snapshot.theme ? { theme: snapshot.theme } : {} });
}

function attachGatewayOutput(child: UtilityProcess): void {
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'error']] as const) {
    if (!stream) continue;
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) log('gateway', line.trim(), level);
    });
    stream.on('end', () => { if (pending.trim()) log('gateway', pending.trim(), level); });
  }
}

function scheduleRecovery(): void {
  if (quitting || restartTimer) return;
  if (restartAttempts >= 3) {
    snapshot.gateway = { state: 'error', detail: '网关连续退出，已停止自动重试',
      connected: false, managed: false };
    log('gateway', snapshot.gateway.detail, 'error');
    publish();
    return;
  }
  if (busy) {
    restartTimer = setTimeout(() => { restartTimer = null; scheduleRecovery(); }, 1000);
    return;
  }
  const delay = [2000, 5000, 10000][restartAttempts++];
  log('gateway', `网关意外退出，将在 ${delay / 1000} 秒后重试`, 'warn');
  snapshot.gateway = { state: 'starting', detail: `网关将在 ${delay / 1000} 秒后自动重试`,
    connected: false, managed: true };
  publish();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (busy) { scheduleRecovery(); return; }
    void runOperation(async () => { await startGateway(true); }).catch(() => scheduleRecovery());
  }, delay);
}

async function refreshStatus(): Promise<Snapshot> {
  if (refreshing || busy || quitting) return snapshot;
  refreshing = true;
  const previousDesktop = snapshot.desktop.state;
  const previousGateway = snapshot.gateway.state;
  const previousConnection = snapshot.gateway.connected;
  try {
    const desktop = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
    snapshot.desktop = desktop.cdpReady
      ? { state: 'ready', detail: 'Desktop 已运行，CDP 可连接' }
      : desktop.running
        ? { state: 'needsRestart', detail: 'Desktop 已运行，但未启用 CDP' }
        : { state: 'stopped', detail: 'Desktop 未运行' };
  } catch (error) {
    snapshot.desktop = { state: 'error', detail: (error as Error).message };
  }
  try {
    const probe = await probeGateway(configuration.settings, configuration.token);
    if (probe.kind === 'codexdeck') {
      if (!gateway) {
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        restartAttempts = 0;
      }
      snapshot.gateway = {
        state: gateway?.pid ? 'running' : 'external',
        detail: gateway?.pid ? '由启动器管理' : '已有网关运行；由其他进程管理',
        connected: probe.connected,
        managed: Boolean(gateway?.pid),
      };
    } else if (probe.kind === 'occupied') {
      snapshot.gateway = { state: 'conflict', detail: '端口被其他服务占用', connected: false,
        managed: Boolean(gateway?.pid || restartTimer) };
    } else {
      snapshot.gateway = gateway?.pid
        ? { state: 'error', detail: '网关进程未响应', connected: false, managed: true }
        : restartTimer
          ? { state: 'starting', detail: '网关等待自动重试', connected: false, managed: true }
          : restartAttempts >= 3
            ? { state: 'error', detail: '网关连续退出，已停止自动重试', connected: false, managed: false }
            : { state: 'stopped', detail: '网关未运行', connected: false, managed: false };
    }
  } catch (error) {
    snapshot.gateway = { state: 'error', detail: (error as Error).message, connected: false,
      managed: Boolean(gateway?.pid || restartTimer) };
  }
  snapshot.checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (previousDesktop !== snapshot.desktop.state && previousDesktop !== 'starting') {
    log('desktop', snapshot.desktop.detail,
      snapshot.desktop.state === 'ready' ? 'info' : 'warn');
  }
  if (previousGateway !== snapshot.gateway.state && previousGateway !== 'starting') {
    log('gateway', snapshot.gateway.detail,
      ['running', 'external'].includes(snapshot.gateway.state) ? 'info' : 'warn');
  } else if (previousConnection !== snapshot.gateway.connected &&
      ['running', 'external'].includes(snapshot.gateway.state)) {
    log('gateway', snapshot.gateway.connected ? 'Desktop 桥接已恢复' : 'Desktop 桥接已断开',
      snapshot.gateway.connected ? 'info' : 'warn');
  }
  refreshing = false;
  return publish();
}

async function startDesktop(): Promise<void> {
  const status = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
  if (status.cdpReady) return;
  if (status.running) throw new Error('Desktop 已运行但未启用 CDP，请使用“重启并启用 CDP”');
  snapshot.desktop = { state: 'starting', detail: '正在启动 Codex Desktop' };
  publish();
  log('desktop', '正在启动 Codex Desktop 并启用本机 CDP');
  await runDesktopScript(desktopScript, configuration.settings.cdpPort, 'Start');
  const ready = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
  if (!ready.cdpReady) throw new Error('Desktop 已启动，但 CDP 尚未就绪');
  snapshot.desktop = { state: 'ready', detail: 'Desktop 已运行，CDP 可连接' };
  log('desktop', 'Codex Desktop 与 CDP 已就绪');
  publish();
}

async function confirmDesktopAction(action: 'restart' | 'stop'): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: action === 'restart' ? '重启 Codex Desktop' : '停止 Codex Desktop',
    message: '请先在 Codex Desktop 中保存工作。',
    detail: action === 'restart'
      ? 'Desktop 退出后会以本机 CDP 模式重新启动。如 Desktop 弹出退出确认，请在其中选择退出。'
      : '退出可能中断当前操作。如 Desktop 弹出退出确认，请在其中选择退出。',
    buttons: ['取消', action === 'restart' ? '确认重启' : '确认停止'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function restartDesktop(): Promise<void> {
  if (!await confirmDesktopAction('restart')) return;
  snapshot.desktop = { state: 'starting', detail: '正在正常退出 Desktop' };
  publish();
  log('desktop', '正在正常退出 Codex Desktop');
  await runDesktopScript(desktopScript, configuration.settings.cdpPort, 'Close');
  await startDesktop();
}

async function stopDesktop(): Promise<void> {
  if (!await confirmDesktopAction('stop')) return;
  log('desktop', '正在正常退出 Codex Desktop');
  await runDesktopScript(desktopScript, configuration.settings.cdpPort, 'Close');
  snapshot.desktop = { state: 'stopped', detail: 'Desktop 未运行' };
  log('desktop', 'Codex Desktop 已退出');
  publish();
}

async function startGateway(recovery = false): Promise<void> {
  if (!recovery) {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartAttempts = 0;
  }
  if (gateway?.pid) {
    if (['error', 'conflict'].includes(snapshot.gateway.state)) {
      throw new Error('网关进程仍在运行，请先停止网关后重试');
    }
    return;
  }
  const desktop = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
  if (!desktop.cdpReady) throw new Error('请先启动带 CDP 的 Codex Desktop');
  const existing = await probeGateway(configuration.settings, configuration.token);
  if (existing.kind === 'codexdeck') {
    snapshot.gateway = { state: 'external', detail: '已有网关运行；由其他进程管理',
      connected: existing.connected, managed: false };
    log('gateway', '检测到已有网关，已连接但不会接管或停止它', 'warn');
    publish();
    return;
  }
  if (existing.kind === 'occupied') throw new Error('网关端口已被其他程序占用，请更换端口');
  snapshot.gateway = { state: 'starting', detail: '正在启动网关', connected: false, managed: true };
  publish();
  const settings = configuration.settings;
  const child = utilityProcess.fork(path.join(gatewayRoot, 'src', 'server.mjs'), [], {
    cwd: gatewayRoot,
    env: {
      ...process.env,
      CODEX_GATEWAY_HOST: settings.gatewayHost,
      CODEX_GATEWAY_PORT: String(settings.gatewayPort),
      CODEX_CDP_PORT: String(settings.cdpPort),
      CODEX_GATEWAY_WORKSPACE: settings.workspace,
      CODEX_GATEWAY_TOKEN: configuration.token,
      CODEX_GATEWAY_THEME_FILE: themeFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'CodexDeck Gateway',
  });
  gateway = child;
  gatewayReady = false;
  attachGatewayOutput(child);
  child.on('message', (message) => {
    if (gateway === child && message?.type === 'show-launcher') showWindow();
  });
  child.on('exit', (code) => {
    if (gateway !== child) return;
    gateway = null;
    const wasReady = gatewayReady;
    if (wasReady && Date.now() - gatewayStartedAt > 5 * 60 * 1000) restartAttempts = 0;
    gatewayReady = false;
    snapshot.gateway = { state: 'stopped', detail: '网关进程已退出', connected: false,
      managed: false };
    log('gateway', `网关进程已退出（代码 ${code}）`, stoppingGateway ? 'info' : 'error');
    publish();
    if (!stoppingGateway && wasReady) scheduleRecovery();
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (gateway !== child) break;
    const probe = await probeGateway(settings, configuration.token);
    if (gateway !== child) break;
    if (probe.kind === 'codexdeck') { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    if (gateway === child) await stopGateway(false);
    throw new Error('网关未在 10 秒内启动，请查看运行日志');
  }
  gatewayReady = true;
  gatewayStartedAt = Date.now();
  const connected = await checkGatewayBridge(settings, configuration.token);
  snapshot.gateway = { state: 'running', detail: '由启动器管理', connected, managed: true };
  log('gateway', connected ? '网关已启动，Desktop 桥接已连接' :
    '网关已启动，但 Desktop 桥接尚未连接', connected ? 'info' : 'warn');
  publish();
}

async function stopGateway(resetRecovery = true): Promise<void> {
  // 进程退出后可能仍有待执行的重试，停止操作必须一并取消。
  const pendingRecovery = Boolean(restartTimer);
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!gateway) {
    if (pendingRecovery) {
      if (resetRecovery) restartAttempts = 0;
      snapshot.gateway = { state: 'stopped', detail: '网关未运行', connected: false, managed: false };
      log('gateway', '已取消网关自动重试');
      publish();
    }
    return;
  }
  stoppingGateway = true;
  const child = gateway;
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (!child.kill()) { clearTimeout(timeout); resolve(); }
    });
    if (gateway === child && child.pid) throw new Error('网关未能停止，请查看运行日志');
    gateway = null;
    gatewayReady = false;
    if (resetRecovery) restartAttempts = 0;
    snapshot.gateway = { state: 'stopped', detail: '网关未运行', connected: false, managed: false };
    publish();
  } finally {
    stoppingGateway = false;
  }
}

async function startAll(): Promise<void> {
  const desktop = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
  if (!desktop.cdpReady && desktop.running) {
    await restartDesktop();
    const after = await readDesktopStatus(desktopScript, configuration.settings.cdpPort);
    if (!after.cdpReady) return;
  } else if (!desktop.cdpReady) {
    await startDesktop();
  }
  await startGateway();
}

async function openWeb(): Promise<void> {
  const probe = await probeGateway(configuration.settings, configuration.token);
  if (probe.kind !== 'codexdeck') throw new Error('网关尚未运行');
  await shell.openExternal(gatewayOrigin(configuration.settings));
}

async function saveSettings(input: SettingsInput): Promise<void> {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效');
  const settings = validateSettings(input.settings, app.getPath('documents'));
  const token = input.tokenMode === 'clear' ? '' : input.tokenMode === 'set'
    ? String(input.token ?? '') : configuration.token;
  if (settings.startAtLogin && (isPortable() || !app.isPackaged) &&
      !configuration.settings.startAtLogin) {
    throw new Error('随 Windows 登录启动仅支持安装版');
  }
  const stat = await fs.stat(settings.workspace).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('默认工作目录不存在');
  const previous = configuration;
  const gatewayChanged = settings.gatewayHost !== previous.settings.gatewayHost ||
    settings.gatewayPort !== previous.settings.gatewayPort ||
    settings.cdpPort !== previous.settings.cdpPort ||
    settings.workspace !== previous.settings.workspace || token !== previous.token;
  await saveConfiguration(configFile, { settings, token });
  configuration = { settings, token };
  if (snapshot.canStartAtLogin && settings.startAtLogin !== previous.settings.startAtLogin) {
    app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ['--hidden'] });
  }
  log('launcher', '设置已保存');
  if (gatewayChanged && gateway) {
    log('gateway', '配置已改变，正在重启由启动器管理的网关');
    await stopGateway();
    const desktop = await readDesktopStatus(desktopScript, settings.cdpPort);
    if (desktop.cdpReady) await startGateway();
    else log('desktop', 'CDP 配置已改变，请重启 Desktop 后再启动网关', 'warn');
  }
  publish();
}

async function runOperation(action: () => Promise<void>): Promise<Snapshot> {
  if (busy) throw new Error('已有操作正在执行，请稍候');
  busy = true;
  publish();
  try {
    await action();
  } catch (error) {
    log('launcher', (error as Error).message, 'error');
    throw error;
  } finally {
    busy = false;
    while (refreshing) await new Promise((resolve) => setTimeout(resolve, 50));
    await refreshStatus();
  }
  return snapshot;
}

function registerIpc(): void {
  const uiUrl = pathToFileURL(path.join(app.getAppPath(), 'desktop', 'ui', 'index.html')).href;
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender.getURL().split('?')[0] !== uiUrl) throw new Error('无权操作启动器');
      return action(...args);
    });
  };
  handle('launcher:snapshot', () => snapshot);
  handle('launcher:logs', () => logs);
  handle('launcher:refresh', () => refreshStatus());
  handle('launcher:start-all', () => runOperation(startAll));
  handle('launcher:start-desktop', () => runOperation(startDesktop));
  handle('launcher:restart-desktop', () => runOperation(restartDesktop));
  handle('launcher:stop-desktop', () => runOperation(stopDesktop));
  handle('launcher:start-gateway', () => runOperation(() => startGateway()));
  handle('launcher:stop-gateway', () => runOperation(stopGateway));
  handle('launcher:open-web', () => openWeb());
  handle('launcher:save-settings', (input) => runOperation(() => saveSettings(input as SettingsInput)));
  handle('launcher:set-theme', (theme) => setTheme(theme));
}

if (singleInstance) {
  app.on('second-instance', (_event, commandLine) => {
    if (!commandLine.includes('--hidden')) showWindow();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (monitorTimer) clearInterval(monitorTimer);
    if (themeTimer) clearInterval(themeTimer);
    if (restartTimer) clearTimeout(restartTimer);
    void stopGateway().catch((error: Error) => log('launcher', error.message, 'error'))
      .finally(() => app.quit());
  });
  app.on('window-all-closed', () => { /* 窗口关闭后继续托盘常驻。 */ });
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.codexdeck.desktop');
    configFile = path.join(app.getPath('userData'), 'settings.json');
    themeFile = path.join(app.getPath('userData'), 'theme.txt');
    snapshot.theme = await readSavedTheme();
    gatewayRoot = app.isPackaged ? path.join(process.resourcesPath, 'gateway') : app.getAppPath();
    desktopScript = path.join(gatewayRoot, 'scripts', 'start-desktop-cdp.ps1');
    await loadTodayLogs();
    try {
      configuration = await loadConfiguration(configFile, app.getPath('documents'));
    } catch (error) {
      configuration = { settings: defaultSettings(app.getPath('documents')), token: '' };
      log('launcher', '读取配置失败，已使用默认设置：' + (error as Error).message, 'error');
    }
    if (app.isPackaged && !isPortable() && configuration.settings.startAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    }
    registerIpc();
    createWindow();
    tray = new Tray(trayImage());
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
    nativeTheme.on('updated', () => tray?.setImage(trayImage()));
    publish();
    log('launcher', '启动器已启动，正在检查本机服务');
    await refreshStatus();
    monitorTimer = setInterval(() => { void refreshStatus(); }, 5000);
    themeTimer = setInterval(() => { void syncThemeFromFile(); }, 1000);
    if (configuration.settings.startAllOnOpen) {
      void runOperation(startAll).catch(() => undefined);
    }
  }).catch((error: Error) => {
    dialog.showErrorBox('CodexDeck 启动失败', error.message);
    app.quit();
  });
}
