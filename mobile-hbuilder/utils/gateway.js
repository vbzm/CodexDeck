export const GATEWAY_URL_KEY = 'codexdeck.gatewayUrl';

export function normalizeGatewayUrl(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  // App 服务环境可能没有 URL 全局对象；网页的 /api/ 请求要求填写站点根地址。
  const match = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?\/?$/i.exec(address);
  if (!match) return null;
  const host = match[2];
  if (host.startsWith('[')) {
    if (!host.includes(':')) return null;
  } else if (host.length > 253 || host.split('.').some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return null;
  }
  const port = match[3];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return match[1].toLowerCase() + '://' + host.toLowerCase() +
    (port ? ':' + port : '') + '/';
}

export function isGatewayHealthResponse(statusCode, data) {
  return (statusCode === 200 && data && typeof data.connected === 'boolean' &&
      typeof data.workspace === 'string') ||
    (statusCode === 401 && data && data.error === '需要网关访问令牌');
}
