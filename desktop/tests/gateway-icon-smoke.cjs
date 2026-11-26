const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { once } = require('node:events');
const { app, BrowserWindow, protocol, utilityProcess } = require('electron');

const root = path.resolve(__dirname, '../..');
app.setName('CodexDeck Gateway Icon Test');
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if (await check()) return; } catch { /* 等待页面和子进程就绪。 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function run() {
  // 使用独立的测试 Desktop 页面，避免消费正在工作的网关消息。
  protocol.handle('app', () => new Response(`<!doctype html><html><head><style>
    body { margin: 0; } nav { display: flex; flex-direction: column; gap: 8px; width: 52px; height: 300px; align-items: center; }
    .native { width: 36px; height: 36px; border: 0; border-radius: 12px; color: #888; background: transparent; }
    .native:hover { background: #ddd; color: #222; }
  </style></head><body><nav data-app-navigation-rail="true"><div style="flex:1"></div>
    <div><button class="native" type="button" data-variant="ghost" aria-haspopup="menu"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg></button></div>
  </nav></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const desktop = new BrowserWindow({ show: false, width: 400, height: 400 });
  const launcher = new BrowserWindow({ show: false, width: 560, height: 400, title: 'CodexDeck · 联动验证' });
  let child;
  try {
    await desktop.loadURL('app://-/index.html');
    await launcher.loadURL('data:text/html,<title>CodexDeck</title><body>CodexDeck</body>');
    let cdpPort;
    await waitFor(() => {
      cdpPort = Number(fs.readFileSync(path.join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      return cdpPort > 0;
    }, '测试 Desktop 的 CDP 端口未就绪');
    const portProbe = net.createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    portProbe.close();
    await once(portProbe, 'close');
    child = utilityProcess.fork(path.join(root, 'src/server.mjs'), [], {
      cwd: root,
      env: { ...process.env, CODEX_GATEWAY_HOST: '127.0.0.1', CODEX_GATEWAY_PORT: String(port),
        CODEX_CDP_PORT: String(cdpPort), CODEX_GATEWAY_TOKEN: '', CODEX_GATEWAY_WORKSPACE: root },
      stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'CodexDeck Icon Test Gateway',
    });
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    // 执行实际编译产物中的窗口恢复函数和 IPC 接收逻辑。
    const main = fs.readFileSync(path.join(root, 'desktop/dist/main.js'), 'utf8');
    const showWindow = main.match(/function showWindow\(\) \{[\s\S]*?\n\}/)?.[0];
    const messageHandler = main.match(/child\.on\('message', \(message\) => \{[\s\S]*?\n    \}\);/)?.[0];
    assert.ok(showWindow && messageHandler, '未找到启动器的窗口联动实现');
    const context = vm.createContext({ window: launcher, gateway: child, child });
    vm.runInContext(showWindow + '\n' + messageHandler, context);
    let received = 0;
    let raised = 0;
    const moveTop = launcher.moveTop.bind(launcher);
    launcher.moveTop = () => { raised++; moveTop(); };
    child.on('message', (message) => { if (message?.type === 'show-launcher') received++; });
    await waitFor(() => desktop.webContents.executeJavaScript(
      "document.getElementById('codexdeck-gateway-icon')?.tagName === 'BUTTON'"), '网关按钮未挂载：' + output);
    const click = () => desktop.webContents.executeJavaScript("document.getElementById('codexdeck-gateway-icon').click()");
    await click();
    // Windows 可拦截后台自动化的焦点抢占，验证实际显示和前置操作，不强制抢占输入焦点。
    await waitFor(() => launcher.isVisible() && raised === 1 && received === 1,
      '点击未显示并前置隐藏的控制台：' + output);
    assert.equal(launcher.isAlwaysOnTop(), false, '唤起控制台不应永久置顶');
    launcher.minimize();
    await waitFor(() => launcher.isMinimized(), '控制台未进入最小化状态');
    await click();
    await waitFor(() => !launcher.isMinimized() && launcher.isVisible() && raised === 2 && received === 2,
      '点击未恢复并前置最小化的控制台');
    launcher.hide();
    context.gateway = null;
    await click();
    await waitFor(() => received === 3, '点击事件未到达启动器');
    assert.equal(launcher.isVisible(), false, '已不受管理的子进程不能唤起控制台');
    console.log('窗口联动验证通过：按钮点击 → CDP → 网关 IPC → 控制台显示、最小化恢复与前置；不永久置顶');
  } finally {
    if (child) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    desktop.destroy();
    launcher.destroy();
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
