const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { app, utilityProcess } = require('electron');

const root = path.resolve(__dirname, '../..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function run() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = utilityProcess.fork(path.join(root, 'src/server.mjs'), [], {
    cwd: root,
    env: { ...process.env, CODEX_GATEWAY_HOST: '127.0.0.1',
      CODEX_GATEWAY_PORT: String(port), CODEX_CDP_PORT: '49397',
      CODEX_GATEWAY_WORKSPACE: root, CODEX_GATEWAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'CodexDeck Test Gateway',
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  try {
    let response;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { response = await fetch(origin + '/api/health'); if (response.ok) break; }
      catch { /* 等待网关监听。 */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(response?.ok, '网关未在 10 秒内监听：' + output);
    const health = await response.json();
    assert.equal(typeof health.connected, 'boolean');
    const models = await fetch(origin + '/api/models');
    assert.equal(models.status, 200, 'Desktop 桥接失败：' + await models.text());
    console.log(`Electron 子进程验证通过：网关端口 ${port}，Desktop 桥接可用`);
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
