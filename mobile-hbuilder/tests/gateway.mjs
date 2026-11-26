import assert from 'node:assert/strict';
import { normalizeGatewayUrl, isGatewayHealthResponse } from '../utils/gateway.js';

assert.equal(normalizeGatewayUrl(' https://deck.example.com/ '), 'https://deck.example.com/');
assert.equal(normalizeGatewayUrl('http://192.168.1.20:8787'), 'http://192.168.1.20:8787/');
assert.equal(normalizeGatewayUrl('http://100.101.102.103:8787/'), 'http://100.101.102.103:8787/');
assert.equal(normalizeGatewayUrl('http://[::1]:8787/'), 'http://[::1]:8787/');
const originalUrl = globalThis.URL;
try {
  globalThis.URL = undefined;
  assert.equal(normalizeGatewayUrl('http://203.0.113.7:19888/'), 'http://203.0.113.7:19888/');
  assert.equal(normalizeGatewayUrl('https://deck.example.com'), 'https://deck.example.com/');
  for (const value of ['https://deck.example.com/path', 'https://user@deck.example.com',
    'http://deck.example.com:70000/', 'http://deck..example.com/']) {
    assert.equal(normalizeGatewayUrl(value), null);
  }
} finally {
  globalThis.URL = originalUrl;
}
for (const value of ['ftp://deck.example.com', 'https://user:secret@deck.example.com',
  'https://deck.example.com/subpath', 'https://deck.example.com/?token=secret', 'not a url']) {
  assert.equal(normalizeGatewayUrl(value), null);
}
assert.equal(isGatewayHealthResponse(200, { connected: false, workspace: 'D:\\Code' }), true);
assert.equal(isGatewayHealthResponse(401, { error: '需要网关访问令牌' }), true);
assert.equal(isGatewayHealthResponse(200, '<html>not gateway</html>'), false);
assert.equal(isGatewayHealthResponse(404, { error: '页面不存在' }), false);

console.log('HBuilderX 网关地址与健康检查验证通过');
