import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http.mjs';

const require = createRequire(import.meta.url);
// 发布包也包含这一份浏览器构建，避免依赖打包时未复制的 Markdown 源码。
const MarkdownIt = require('../node_modules/markdown-it/dist/markdown-it.min.js');
const markdown = new MarkdownIt({ html: false });
const validateLink = markdown.validateLink;
markdown.validateLink = (source) => validateLink(source) || /^file:\/\//i.test(source);
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);
const containerKeys = ['thread', 'turn', 'turns', 'items', 'data', 'item', 'content'];
const imageTypes = new Set(['imageView', 'ImageView', 'localImage', 'local_image']);

function localPath(source, cwd, encoded = false) {
  if (typeof source !== 'string' || !source || source.length > 8192 || source.includes('\0')) return null;
  let value = source;
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = fileURLToPath(url);
    } else if (encoded) value = decodeURIComponent(value);
  } catch { return null; }
  // 浏览器可展示的本机路径不包括网络共享、设备路径和其它 URL 协议。
  if (/^[\\/]{2}/.test(value) || /^(?![a-z]:[\\/])[a-z][a-z\d+.-]*:/i.test(value)) return null;
  if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  if (!extensions.has(path.extname(value).toLowerCase())) return null;
  if (!path.isAbsolute(value) && !cwd) return null;
  const resolved = path.resolve(cwd || '.', value);
  return /^[\\/]{2}/.test(resolved) ? null : resolved;
}

function markdownSources(text) {
  if (typeof text !== 'string' || !text.includes('![')) return [];
  const sources = [];
  const visit = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'image') sources.push(token.attrGet('src'));
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(text, {}));
  return sources;
}

function messageSources(item) {
  if (item.type === 'agentMessage') return markdownSources(item.text);
  if (item.type === 'userMessage') return [item.text, ...(item.content || []).map((part) => part.text)]
    .flatMap(markdownSources);
  return [];
}

function imageContentType(body) {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6))) return 'image/gif';
  if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (body.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  if (body.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(body.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

export function createImages() {
  const secret = randomBytes(32);
  const signature = (file) => createHmac('sha256', secret).update(file).digest('hex');
  const imageUrl = (source, cwd, encoded = false) => {
    const file = localPath(source, cwd, encoded);
    if (!file) return null;
    return '/api/images?' + new URLSearchParams({ path: file, signature: signature(file) });
  };

  function prepare(value, cwd) {
    if (Array.isArray(value)) return value.map((entry) => prepare(entry, cwd));
    if (!value || typeof value !== 'object') return value;
    const root = value.thread?.cwd || cwd;
    const result = { ...value };
    if (imageTypes.has(value.type)) {
      const url = imageUrl(value.path, root);
      if (url) result.imageUrl = url;
    }
    const sources = messageSources(value);
    if (sources.length) {
      const imageSources = Object.create(null);
      for (const source of sources) {
        const url = imageUrl(source, root, true);
        if (url) imageSources[source] = url;
      }
      if (Object.keys(imageSources).length) result.imageSources = imageSources;
    }
    for (const key of containerKeys) {
      if (value[key] && typeof value[key] === 'object') result[key] = prepare(value[key], root);
    }
    return result;
  }

  function needsCwd(value) {
    if (Array.isArray(value)) return value.some(needsCwd);
    if (!value || typeof value !== 'object') return false;
    const sources = messageSources(value).map((source) => [source, true]);
    if (imageTypes.has(value.type)) sources.push([value.path, false]);
    if (sources.some(([source, encoded]) => !localPath(source, null, encoded) && localPath(source, process.cwd(), encoded))) return true;
    return containerKeys.some((key) => value[key] && typeof value[key] === 'object' && needsCwd(value[key]));
  }

  async function serve(response, url) {
    const file = url.searchParams.get('path');
    const submitted = url.searchParams.get('signature') || '';
    if (!file || !/^[a-f\d]{64}$/.test(submitted) ||
        !timingSafeEqual(Buffer.from(submitted, 'hex'), Buffer.from(signature(file), 'hex'))) {
      throw new HttpError(403, '图片地址无效，请刷新对话后重试');
    }
    if (localPath(file) !== file) throw new HttpError(400, '图片路径无效');
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new HttpError(404, '图片不存在');
      if (stat.size > 32 * 1024 * 1024) throw new HttpError(413, '图片超过 32MB，无法预览');
      // 按已检查的大小读取，避免图片正在写入时无限增大内存占用。
      const buffer = Buffer.alloc(stat.size);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const body = buffer.subarray(0, length);
      const type = imageContentType(body);
      if (!type) throw new HttpError(415, '文件不是可预览的图片');
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(body);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '图片已被移动或删除');
      if (error.code === 'EACCES' || error.code === 'EPERM') throw new HttpError(403, '没有权限读取图片');
      throw error;
    } finally { await handle?.close(); }
  }

  return { prepare, needsCwd, serve };
}
