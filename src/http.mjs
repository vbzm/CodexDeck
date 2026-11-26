import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export function isAuthorized(request, token) {
  if (!token) return true;
  const header = request.headers.authorization || '';
  const submitted = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(token);
  const actual = Buffer.from(submitted);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkHost(request, localHost, token) {
  if (!localHost || token) return;
  let hostname;
  try {
    hostname = new URL('http://' + request.headers.host).hostname;
  } catch {
    throw new HttpError(403, '访问地址无效');
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new HttpError(403, '本机模式只接受本机地址');
  }
}

export function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, '请求来源无效');
  }
  if (parsed.host !== request.headers.host) throw new HttpError(403, '请求来源与网关地址不符');
}

export async function readBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, '请使用 JSON 请求');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON 内容无效');
  }
}

export function threadIdFromPath(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, '聊天 ID 无效');
  }
  return value;
}

export function limitedPageSize(value, fallback, maximum) {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new HttpError(400, '分页数量无效');
  return parsed;
}

export function messageText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) {
    throw new HttpError(400, '请输入 1 到 20000 字的消息');
  }
  return value;
}
