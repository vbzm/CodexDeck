import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopBridge } from './desktop-bridge.mjs';
import { createApprovalRelay } from './approvals.mjs';
import { createApi } from './api.mjs';
import { checkHost, HttpError, sendJson } from './http.mjs';
import { readTheme } from './theme.mjs';
import { createThreadState } from './thread-state.mjs';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.join(directory, 'public');
const host = process.env.CODEX_GATEWAY_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_GATEWAY_PORT || 8787);
const cdpPort = Number(process.env.CODEX_CDP_PORT || 49397);
const workspace = path.resolve(process.env.CODEX_GATEWAY_WORKSPACE || directory);
const token = process.env.CODEX_GATEWAY_TOKEN || '';
const localHost = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('网关端口无效');
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error('CDP 端口无效');

const bridge = new DesktopBridge(cdpPort);
// 仅通过启动器和其网关子进程之间的 IPC 唤起控制台，不向 HTTP 客户端开放窗口操作。
bridge.onOpenLauncher = () => process.parentPort?.postMessage({ type: 'show-launcher' });
const threadState = createThreadState(bridge);
const approvalRelay = createApprovalRelay(bridge, threadState);
const handleApi = createApi({ bridge, workspace, token, approvalRelay, threadState });

async function serveFile(response, file, type, base = publicDirectory, transform = null) {
  const body = await fs.promises.readFile(path.join(base, file));
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https: http:; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(transform ? transform(body.toString('utf8')) : body);
}

const scripts = new Set(['app.js', 'core.js', 'sidebar.js', 'conversation.js', 'activity.js', 'file-diff.js', 'images.js',
  'settings.js', 'approvals.js', 'project-dialog.js', 'theme-init.js', 'goals.js', 'agents.js', 'questions.js']);
const styles = new Set(['base.css', 'sidebar.css', 'conversation.css', 'composer.css',
  'dialogs.css', 'responsive.css', 'questions.css']);
const server = http.createServer(async (request, response) => {
  try {
    checkHost(request, localHost, token);
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      const theme = await readTheme();
      await serveFile(response, 'index.html', 'text/html; charset=utf-8', publicDirectory,
        (html) => theme ? html.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme="${theme}">`) : html);
    } else if (request.method === 'GET' && url.pathname === '/style.css') {
      await serveFile(response, 'style.css', 'text/css; charset=utf-8');
    } else if (request.method === 'GET' && url.pathname.startsWith('/css/') &&
        styles.has(url.pathname.slice(5))) {
      await serveFile(response, url.pathname.slice(1), 'text/css; charset=utf-8');
    } else if (request.method === 'GET' && url.pathname.startsWith('/js/') &&
        scripts.has(url.pathname.slice(4))) {
      await serveFile(response, url.pathname.slice(1), 'text/javascript; charset=utf-8');
    } else if (request.method === 'GET' && url.pathname === '/vendor/markdown-it.min.js') {
      await serveFile(response, 'dist/markdown-it.min.js', 'text/javascript; charset=utf-8',
        path.join(directory, 'node_modules', 'markdown-it'));
    } else if (request.method === 'GET' && ['codex-logo-dark.png', 'codex-logo-light.png']
      .includes(url.pathname.slice('/assets/'.length)) && url.pathname.startsWith('/assets/')) {
      await serveFile(response, url.pathname.slice(1), 'image/png');
    } else if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
    } else if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
    } else {
      throw new HttpError(404, '页面不存在');
    }
  } catch (error) {
    const status = error.status || 503;
    if (!response.headersSent) sendJson(response, status, { error: error.message || '请求失败' });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log('Codex 网关已启动：http://' + host + ':' + port);
  console.log('默认工作目录：' + workspace);
  if (!localHost && !token) console.warn('网关未设置访问令牌，监听地址可被其他设备访问');
});

process.on('SIGINT', () => {
  bridge.close();
  server.close();
});
