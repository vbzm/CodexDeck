const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { defaultSettings } = require('../dist/config.js');
const { probeGateway, checkGatewayBridge, readDesktopStatus, runDesktopScript } = require('../dist/services.js');

const desktopScript = path.resolve(__dirname, '../../scripts/start-desktop-cdp.ps1');

async function withServer(handler, action) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    await action({ ...defaultSettings('C:\\Projects\\CodexDeck'), gatewayPort: port });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('识别已有 CodexDeck 网关并检查 Desktop 桥接', async () => {
  await withServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/api/health'
      ? JSON.stringify({ connected: true, workspace: 'C:\\', approvalCount: 0 })
      : JSON.stringify({ models: [] }));
  }, async (settings) => {
    assert.deepEqual(await probeGateway(settings, ''), { kind: 'codexdeck', connected: true });
    assert.equal(await checkGatewayBridge(settings, ''), true);
  });
});

test('端口上是其他服务时不接管', async () => {
  await withServer((_request, response) => response.end('not CodexDeck'), async (settings) => {
    assert.deepEqual(await probeGateway(settings, ''), { kind: 'occupied' });
  });
});

test('空闲端口可用于启动网关', async () => {
  let settings;
  await withServer((_request, response) => response.end(), async (value) => { settings = value; });
  assert.deepEqual(await probeGateway(settings, ''), { kind: 'free' });
});

test('Desktop 状态探测只读且错误信息简洁', async () => {
  const status = await readDesktopStatus(desktopScript, 49397);
  assert.equal(typeof status.running, 'boolean');
  assert.equal(typeof status.cdpReady, 'boolean');
  await assert.rejects(runDesktopScript(desktopScript, 0, 'Status'),
    (error) => error.message === 'CDP 端口无效。');
});
