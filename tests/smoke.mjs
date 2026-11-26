import assert from 'node:assert/strict';

const baseUrl = 'http://127.0.0.1:' + (process.env.CODEX_GATEWAY_PORT || 8787);
const token = process.env.CODEX_GATEWAY_TOKEN;

async function get(path) {
  const response = await fetch(baseUrl + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  assert.equal(response.status, 200, path + ' 返回 ' + response.status);
  return response;
}

const staticPaths = ['/', '/style.css', '/css/base.css', '/css/sidebar.css', '/css/conversation.css',
  '/css/composer.css', '/css/dialogs.css', '/css/responsive.css', '/js/app.js', '/js/core.js', '/js/sidebar.js',
  '/js/conversation.js', '/js/activity.js', '/js/settings.js', '/js/project-dialog.js',
  '/js/approvals.js', '/js/goals.js', '/js/agents.js', '/js/images.js', '/js/theme-init.js', '/vendor/markdown-it.min.js',
  '/assets/codex-logo-dark.png', '/assets/codex-logo-light.png'];
for (const path of staticPaths) {
  await get(path);
}

const health = await (await get('/api/health')).json();
assert.equal(health.connected, true, '网关未连接到 Codex Desktop');
const projects = await (await get('/api/projects')).json();
assert.ok(Array.isArray(projects.projects), '项目列表无效');
const models = await (await get('/api/models')).json();
assert.ok(models.models.length > 0, '模型目录为空');
const unread = await (await get('/api/unread')).json();
assert.ok(Array.isArray(unread.ids), '未读状态无效');
const drives = await (await get('/api/directories')).json();
assert.ok(Array.isArray(drives.entries), '电脑目录列表无效');
const threads = await (await get('/api/threads?limit=1')).json();
assert.ok(Array.isArray(threads.threads), '聊天列表无效');
if (threads.threads[0]) {
  const id = threads.threads[0].id;
  const metadata = await (await get('/api/threads/' + id)).json();
  assert.equal(metadata.thread.id, id, '聊天详情 ID 不一致');
  assert.equal(typeof metadata.goalSupported, 'boolean', '目标能力状态无效');
  assert.ok(Array.isArray(metadata.compactions), '上下文压缩状态无效');
  const history = await (await get('/api/threads/' + id + '/turns?limit=1')).json();
  assert.ok(Array.isArray(history.turns), '回合列表无效');
}
console.log(JSON.stringify({ connected: health.connected, projects: projects.projects.length,
  sampledThreads: threads.threads.length, models: models.models.length,
  drives: drives.entries.length, staticFiles: staticPaths.length }, null, 2));
