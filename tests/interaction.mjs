import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readTheme, writeTheme } from '../src/theme.mjs';
import { createApprovalRelay } from '../src/approvals.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codexdeck-theme-'));
const file = path.join(directory, 'theme.txt');
try {
  assert.equal(await readTheme(file), null);
  await writeTheme('dark', file);
  assert.equal(await readTheme(file), 'dark');
  await writeTheme('light', file);
  assert.equal(await readTheme(file), 'light');
  await assert.rejects(writeTheme('invalid', file), /主题只能/);
  assert.equal(await readTheme(file), 'light');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

const listeners = new Set();
const view = {
  addEventListener(_type, callback) { listeners.add(callback); },
  removeEventListener(_type, callback) { listeners.delete(callback); },
  dispatch(data) { for (const callback of listeners) callback({ data }); },
};
// 消息桥接不应依赖侧边栏是否已经挂载。
const context = vm.createContext({ window: view, document: { querySelector: () => null } });
const desktop = new DesktopBridge();
desktop.evaluate = async (expression) => vm.runInContext(expression, context);
await desktop.drainEvents();
view.dispatch({ type: 'mcp-notification', method: 'error',
  params: { threadId: 'thread', turnId: 'turn', willRetry: true,
    error: { message: '正在重连' } } });
view.dispatch({ type: 'mcp-request', request: { id: 1,
  method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } } });
const drained = await desktop.drainEvents();
assert.deepEqual(Array.from(drained.statuses, (item) => item.method), ['error']);
assert.deepEqual(Array.from(drained.approvals, (item) => item.id), [1]);
view.dispatch({ type: 'mcp-notification', notification: { method: 'thread/goal/updated', params: { threadId: 'thread', goal: { status: 'paused' } } } });
view.dispatch({ type: 'mcp-notification', message: { method: 'thread/goal/cleared', params: { threadId: 'thread' } } });
view.dispatch({ type: 'mcp-notification', method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'contextCompaction' } } });
view.dispatch({ type: 'mcp-notification', hostId: 'remote', method: 'thread/goal/updated', params: { threadId: 'thread' } });
assert.deepEqual(Array.from((await desktop.drainEvents()).statuses, (item) => item.method),
  ['thread/goal/updated', 'thread/goal/cleared', 'item/started']);

// 新会话元数据短暂为空时可重读；真实错误和写操作必须直接失败，不能重复发送。
const originalTimeout = globalThis.setTimeout;
const retryDelays = [];
const rolloutPath = 'C:/Users/test/.codex/sessions/2026/11/10/rollout-new.jsonl';
const emptyRolloutMessage = 'failed to read thread: thread-store internal error: failed to read session metadata ' +
  rolloutPath + ': rollout at ' + rolloutPath + ' is empty';
globalThis.setTimeout = (callback, delay) => {
  retryDelays.push(delay);
  queueMicrotask(callback);
  return 0;
};
try {
  for (const method of ['thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'thread/goal/get']) {
    retryDelays.length = 0;
    const reader = new DesktopBridge();
    const expressions = [];
    const params = { threadId: 'new-thread', includeTurns: false };
    const ready = { thread: { id: params.threadId } };
    reader.evaluate = async (expression) => {
      expressions.push(expression);
      if (expressions.length < 3) throw new Error(emptyRolloutMessage);
      return ready;
    };
    assert.equal(await reader.request(method, params), ready, method + ' 应在元数据就绪后返回结果');
    assert.equal(expressions.length, 3);
    assert.deepEqual(retryDelays, [150, 300]);
    assert.ok(expressions[0].endsWith(')(' + JSON.stringify({ method, params }) + ')'));
    assert.ok(expressions.every((expression) => expression === expressions[0]), '重试必须保留原始请求');
  }

  for (const message of [
    'failed to read session metadata ' + rolloutPath + ': Permission denied (os error 5)',
    'failed to read session metadata ' + rolloutPath + ': rollout at ' + rolloutPath + ' has invalid session metadata',
    'rollout at ' + rolloutPath + ' is empty',
    'failed to read session metadata: another resource is empty',
    '桌面连接已断开',
  ]) {
    retryDelays.length = 0;
    const reader = new DesktopBridge();
    const failure = new Error(message);
    let attempts = 0;
    reader.evaluate = async () => { attempts++; throw failure; };
    await assert.rejects(reader.request('thread/read', { threadId: 'thread' }), (error) => error === failure);
    assert.equal(attempts, 1, '非临时空文件错误应立即失败');
    assert.deepEqual(retryDelays, []);
  }

  retryDelays.length = 0;
  const unavailable = new DesktopBridge();
  const persistentFailure = Object.assign(new Error(emptyRolloutMessage), { code: -32603 });
  let unavailableAttempts = 0;
  unavailable.evaluate = async () => { unavailableAttempts++; throw persistentFailure; };
  await assert.rejects(unavailable.request('thread/read', { threadId: 'empty-thread' }),
    (error) => error === persistentFailure && error.code === -32603);
  assert.equal(unavailableAttempts, 5, '持久空文件只能重试四次，随后保留原错');
  assert.deepEqual(retryDelays, [150, 300, 600, 1200]);

  for (const method of ['turn/start', 'thread/start', 'turn/interrupt', 'thread/goal/set', 'thread/goal/clear']) {
    retryDelays.length = 0;
    const writer = new DesktopBridge();
    const failure = new Error(emptyRolloutMessage);
    let attempts = 0;
    writer.evaluate = async () => { attempts++; throw failure; };
    await assert.rejects(writer.request(method, { threadId: 'thread' }), (error) => error === failure);
    assert.equal(attempts, 1, method + ' 不得自动重复执行');
    assert.deepEqual(retryDelays, []);
  }
} finally {
  globalThis.setTimeout = originalTimeout;
}

// 项目已迁入专用目录服务，不能用旧 get-global-state 请求或启动快照代替实时读取。
const projectStateUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const state = {
    projects: {
      first: { id: 'first', name: '项目一', rootPaths: ['D:/first', 'D:/shared'], createdAt: 1, updatedAt: 2 },
      second: { id: 'second', name: '项目二' },
      third: { id: 'third', name: '项目三', rootPaths: [] },
    },
    order: ['second', 'first'],
    calls: [],
  };
  export const incompleteHost = { projectCatalog: { readLocalProjects() { throw new Error('误用了不完整的项目服务'); } } };
  export const desktopHost = {
    projectCatalog: { async readLocalProjects() { state.calls.push('local-projects'); return state.projects; } },
    projectPresentation: { async readOrder() { state.calls.push('project-order'); return state.order; } },
  };
  export async function legacyRequest(method, { params: p, select: s, signal: a, source: o, responsePriority: r } = {}) {
    throw new Error('误用了旧状态请求');
  }
`);
const projectStateModule = await import(projectStateUrl);
const projectBridge = new DesktopBridge();
let projectStateLink = { href: projectStateUrl };
projectBridge.evaluate = async (expression) => new Function('document', 'return ' + expression)({
  querySelector: (selector) => selector === 'link[href*="/assets/app-shared-"][href$=".js"]' ? projectStateLink : null,
});
const projects = await projectBridge.listProjects();
assert.deepEqual(projectStateModule.state.calls.sort(), ['local-projects', 'project-order']);
assert.deepEqual(projects[0], { id: 'first', name: '项目一', roots: [{ path: 'D:/first' }, { path: 'D:/shared' }],
  position: 1, createdAt: 1, updatedAt: 2 });
assert.deepEqual(projects.map(project => [project.id, project.position, project.roots.length]),
  [['first', 1, 2], ['second', 0, 0], ['third', 2, 0]]);
projectStateModule.state.projects.first.name = '项目已重命名';
projectStateModule.state.order = ['first'];
assert.equal((await projectBridge.listProjects())[0].name, '项目已重命名');
assert.equal((await projectBridge.listProjects())[0].position, 0);
projectStateModule.state.projects = undefined;
projectStateModule.state.order = undefined;
assert.deepEqual(await projectBridge.listProjects(), []);
projectStateLink = { href: 'data:text/javascript,export const unrelated = {};' };
await assert.rejects(projectBridge.listProjects(), /Desktop 状态接口已变化/);
projectStateLink = null;
await assert.rejects(projectBridge.listProjects(), /Desktop 状态模块未加载/);

// 新版不再预载 app-initial，直接使用共享模块中的未读会话并在请求结束时释放。
const readStateUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const state = { ids: { local: ['first', 'second'], remote: ['remote'] }, writes: [],
    opens: 0, disposals: 0, status: 'ready', writeStatus: 'ok', events: [], failWrite: false };
  export const asyncRpc = {
    readWhenReady() { throw new Error('误用了通用 RPC 对象'); },
    isReady: () => true,
    forHost: () => Promise.resolve({}),
  };
  export const desktopHost = { threadReadState: {
    async open(onChange) {
      state.opens++;
      const ids = structuredClone(state.ids);
      for (const event of state.events) onChange(event);
      return {
        status: state.status, unreadThreadIdsByHostId: ids,
        session: { async set(change) {
          await Promise.resolve();
          if (state.failWrite) throw new Error('保存请求断开');
          state.writes.push(change);
          if (state.writeStatus === 'ok') state.ids.local = state.ids.local.filter(id => id !== change.threadId);
          return { status: state.writeStatus };
        } },
        [Symbol.dispose]() { state.disposals++; },
      };
    },
  } };
`);
const readStateModule = await import(readStateUrl);
const readStateBridge = new DesktopBridge();
let readStateLink = { href: readStateUrl };
readStateBridge.evaluate = async (expression) => new Function('document', 'return ' + expression)({
  querySelector: (selector) => selector === 'link[href*="/assets/app-shared-"][href$=".js"]' ? readStateLink : null,
});
assert.deepEqual(await readStateBridge.unreadThreads(), ['first', 'second']);
assert.deepEqual(readStateModule.state.writes, []);
await readStateBridge.markThreadRead('first');
assert.deepEqual(readStateModule.state.writes, [{ hostId: 'local', threadId: 'first', hasUnreadTurn: false }]);
assert.deepEqual(await readStateBridge.unreadThreads(), ['second']);
assert.deepEqual(readStateModule.state.ids.remote, ['remote']);
delete readStateModule.state.ids.local;
assert.deepEqual(await readStateBridge.unreadThreads(), []);
readStateModule.state.events = [
  { type: 'changed', hostId: 'local', threadId: 'arrived', hasUnreadTurn: true },
  { type: 'changed', hostId: 'remote', threadId: 'remote-new', hasUnreadTurn: true },
];
assert.deepEqual(await readStateBridge.unreadThreads(), ['arrived']);
readStateModule.state.events = [{ type: 'retired', reason: 'identity' }];
await assert.rejects(readStateBridge.unreadThreads(), /状态已失效/);
readStateModule.state.events = [];
readStateModule.state.status = 'unavailable';
await assert.rejects(readStateBridge.unreadThreads(), /状态暂不可用/);
readStateModule.state.status = 'ready';
readStateModule.state.writeStatus = 'retired';
await assert.rejects(readStateBridge.markThreadRead('second'), /保存失败/);
readStateModule.state.failWrite = true;
await assert.rejects(readStateBridge.markThreadRead('second'), /保存请求断开/);
assert.equal(readStateModule.state.disposals, readStateModule.state.opens);
readStateLink = { href: 'data:text/javascript,export const unrelated = {};' };
await assert.rejects(readStateBridge.unreadThreads(), /Desktop 未读状态接口已变化/);
readStateLink = null;
await assert.rejects(readStateBridge.unreadThreads(), /Desktop 状态模块未加载/);

const projectCreationUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const created = [];
  export const host = { projects: { async createLocal(project) { created.push(project); return { projectId: 'created' }; } } };
`);
const projectCreationModule = await import(projectCreationUrl);
const projectCreationBridge = new DesktopBridge();
projectCreationBridge.evaluate = async (expression) => {
  if (expression.includes('rendererTrustProjectFolder')) return true;
  return new Function('document', 'return ' + expression)({
    querySelector: (selector) => selector === 'link[href*="/assets/app-shared-"][href$=".js"]' ? { href: projectCreationUrl } : null,
  });
};
assert.deepEqual(await projectCreationBridge.createLocalProject('新项目', 'D:/new'), { projectId: 'created' });
assert.deepEqual(projectCreationModule.created, [{ appearance: null, initializeDefaultWorkspaceGitRepository: false,
  name: '新项目', setActive: false, sources: ['D:/new'] }]);

// 新版没有 app-shared 链接；从实际入口导出的 Rspack 缓存复用已加载服务，不执行其它模块。
const bundledServicesUrl = 'data:text/javascript,' + encodeURIComponent(`
  import { desktopHost as projects } from ${JSON.stringify(projectStateUrl)};
  import { desktopHost as unread } from ${JSON.stringify(readStateUrl)};
  import { host as creation } from ${JSON.stringify(projectCreationUrl)};
  export const __webpack_require__ = Object.assign(() => { throw new Error('不应执行模块工厂'); }, {
    m: { unused() { throw new Error('不应加载其它功能'); } },
    c: {
      empty: { exports: undefined },
      unrelated: { exports: { get pending() { throw new Error('导出尚未初始化'); } } },
      services: { exports: { appServices: { ...projects, ...unread, ...creation } } },
    },
  });
`);
const bundledBridge = new DesktopBridge();
bundledBridge.evaluate = async (expression) => {
  if (expression.includes('rendererTrustProjectFolder')) return true;
  return new Function('document', 'return ' + expression)({
    querySelector: () => null,
    scripts: [
      { type: '', src: 'data:text/javascript,throw new Error("不应导入普通脚本")' },
      { type: 'module', src: 'data:text/javascript,export const unrelated = {};' },
      { type: 'module', src: bundledServicesUrl },
    ],
  });
};
projectStateModule.state.projects = { bundled: { id: 'bundled', name: '新版项目', rootPaths: ['D:/bundled'] } };
projectStateModule.state.order = ['bundled'];
readStateModule.state.ids.local = ['bundled-unread'];
readStateModule.state.failWrite = false;
readStateModule.state.writeStatus = 'ok';
assert.deepEqual((await bundledBridge.listProjects()).map((project) => [project.id, project.position]), [['bundled', 0]]);
assert.deepEqual(await bundledBridge.unreadThreads(), ['bundled-unread']);
await bundledBridge.markThreadRead('bundled-unread');
assert.deepEqual(await bundledBridge.unreadThreads(), []);
assert.equal(readStateModule.state.disposals, readStateModule.state.opens);
assert.deepEqual(await bundledBridge.createLocalProject('新版项目', 'D:/bundled'), { projectId: 'created' });
assert.equal(projectCreationModule.created.at(-1).sources[0], 'D:/bundled');

const originalInterval = globalThis.setInterval;
let tick;
let nextEvents = { approvals: [], statuses: [{ method: 'error',
  params: { threadId: 'thread', turnId: 'turn', willRetry: true } }] };
const bridge = { generation: 1, drainEvents: async () => nextEvents };
globalThis.setInterval = (callback) => { tick = callback; return 1; };
try {
  const forwarded = [];
  let disconnected = false;
  const relay = createApprovalRelay(bridge, { onStatus: (event) => forwarded.push(event), onDisconnect: () => { disconnected = true; } });
  await new Promise(setImmediate);
  assert.deepEqual(relay.listRetries().map((item) => item.turnId), ['turn']);
  assert.equal(forwarded.length, 1);
  nextEvents = { approvals: [], statuses: [{ method: 'item/started', params: { turnId: 'turn' } }] };
  await tick();
  assert.deepEqual(relay.listRetries(), []);
  nextEvents = { approvals: [], statuses: [{ method: 'error',
    params: { threadId: 'thread', turnId: 'turn', willRetry: true } }] };
  await tick();
  bridge.onDisconnect();
  assert.equal(disconnected, true);
  assert.deepEqual(relay.listRetries(), []);
} finally {
  globalThis.setInterval = originalInterval;
}

globalThis.document = { getElementById: () => ({}) };
globalThis.sessionStorage = { getItem: () => null };
globalThis.window = { markdownit: () => ({ renderer: { rules: {} } }) };
const { elapsedText } = await import('../public/js/conversation.js');
assert.equal(elapsedText(100, 100000), '已处理 00分00秒');
assert.equal(elapsedText(100, 161000), '已处理 01分01秒');
assert.equal(elapsedText(100, 3701000), '已处理 1小时00分01秒');
console.log('主题共享、会话读取重试、项目列表、未读状态、重连状态与处理时长校验通过');
