const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultSettings, gatewayOrigin, isLocalHost, validateSettings } = require('../dist/config.js');

const workspace = 'C:\\Projects\\CodexDeck';

test('启动器默认只监听本机且不自动更改 Desktop', () => {
  const settings = defaultSettings(workspace);
  assert.equal(settings.gatewayHost, '127.0.0.1');
  assert.equal(settings.gatewayPort, 8787);
  assert.equal(settings.cdpPort, 49397);
  assert.equal(settings.startAllOnOpen, false);
  assert.equal(settings.startAtLogin, false);
});

test('配置校验拒绝非法端口和相对目录', () => {
  const settings = defaultSettings(workspace);
  assert.throws(() => validateSettings({ ...settings, gatewayPort: 0 }, workspace), /网关端口/);
  assert.throws(() => validateSettings({ ...settings, cdpPort: 65536 }, workspace), /CDP 端口/);
  assert.throws(() => validateSettings({ ...settings, workspace: 'relative' }, workspace), /绝对路径/);
  assert.throws(() => validateSettings({ ...settings, gatewayHost: 'bad host' }, workspace), /监听地址/);
});

test('访问地址正确处理 IPv6 和全网卡监听', () => {
  const settings = defaultSettings(workspace);
  assert.equal(gatewayOrigin({ ...settings, gatewayHost: '::1' }), 'http://[::1]:8787');
  assert.equal(gatewayOrigin({ ...settings, gatewayHost: '0.0.0.0' }), 'http://127.0.0.1:8787');
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('0.0.0.0'), false);
});
