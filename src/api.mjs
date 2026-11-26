import fs from 'node:fs';
import path from 'node:path';
import { HttpError, sendJson, isAuthorized, checkOrigin, readBody, threadIdFromPath, limitedPageSize, messageText } from './http.mjs';
import { readLatestUsage } from './usage.mjs';
import { listDirectories } from './directories.mjs';
import { modelCatalog, turnOptions } from './models.mjs';
import { readTheme, writeTheme } from './theme.mjs';
import { createThreadState } from './thread-state.mjs';
import { createQuestions } from './questions.mjs';
import { readItemPage, readTurnPage } from './history.mjs';
import { createImages } from './images.mjs';

const permissionModes = {
  request: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  auto: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  full: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
};

function permissionOptions(mode, fallback = null) {
  if (mode === undefined && fallback === null) return null;
  const selected = mode === undefined ? fallback : mode;
  if (typeof selected !== 'string' || !Object.hasOwn(permissionModes, selected)) {
    throw new HttpError(400, '权限设置无效');
  }
  return permissionModes[selected];
}

export function createApi({ bridge, workspace, token, approvalRelay, threadState = createThreadState(bridge) }) {
  const questions = createQuestions(bridge);
  const images = createImages();
  const threadDirectories = new Map();
  async function prepareImages(value, threadId, cwd = value.thread?.cwd) {
    if (cwd) threadDirectories.set(threadId, cwd);
    cwd ||= threadDirectories.get(threadId);
    if (!cwd && images.needsCwd(value)) {
      // 只有相对图片路径才需额外读取目录，普通文本和绝对图片不拖慢首屏。
      try {
        const result = await bridge.request('thread/read', { threadId, includeTurns: false });
        cwd = result.thread?.cwd;
        if (cwd) threadDirectories.set(threadId, cwd);
      } catch { /* 元数据读取失败时仍显示聊天，其余图片保留失败提示。 */ }
    }
    return images.prepare(value, cwd);
  }
  async function setGoal(threadId, body, resume = true) {
    const objective = body.objective === undefined ? undefined : messageText(body.objective).trim();
    const status = body.status ?? (objective === undefined ? null : 'active');
    if (!['active', 'paused'].includes(status)) throw new HttpError(400, '目标状态只能设置为进行中或已暂停');
    if (objective === undefined) {
      const current = await threadState.read(threadId);
      if (current.goalError) throw new HttpError(503, current.goalError);
      if (!current.goal) throw new HttpError(409, '当前没有可更新的目标');
      if (status === 'paused' && current.goal.status !== 'active') throw new HttpError(409, '当前目标无需暂停');
      if (status === 'active' && !['paused', 'blocked', 'usageLimited'].includes(current.goal.status)) {
        throw new HttpError(409, '当前目标不能恢复，请编辑目标后重新设置');
      }
    }
    if (status === 'active') {
      const options = await turnOptions(body, bridge);
      const permission = permissionOptions(body.permissionMode);
      if (resume) await bridge.request('thread/resume', { threadId, excludeTurns: true });
      const settings = { ...options, ...(permission ? {
        approvalPolicy: permission.approvalPolicy, approvalsReviewer: permission.approvalsReviewer,
        sandboxPolicy: permission.sandboxPolicy,
      } : {}) };
      if (Object.keys(settings).length) await bridge.request('thread/settings/update', { threadId, ...settings });
    }
    const result = await bridge.request('thread/goal/set', { threadId, status,
      ...(objective === undefined ? {} : { objective }) });
    threadState.updateGoal(threadId, result.goal);
    return result;
  }

async function handleApi(request, response, url) {
  if (!isAuthorized(request, token)) throw new HttpError(401, '需要网关访问令牌');
  checkOrigin(request);
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/api/images') {
    await images.serve(response, url);
    return;
  }
  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { connected: bridge.connected, workspace, approvalCount: approvalRelay.count });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/theme') {
    sendJson(response, 200, { theme: await readTheme() });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/theme') {
    const body = await readBody(request);
    if (body.theme !== 'dark' && body.theme !== 'light') throw new HttpError(400, '主题只能是深色或浅色');
    await writeTheme(body.theme);
    sendJson(response, 200, { theme: body.theme });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/models') {
    sendJson(response, 200, await modelCatalog(bridge));
    return;
  }
  if (request.method === 'GET' && pathname === '/api/directories') {
    sendJson(response, 200, await listDirectories(url.searchParams.get('path')));
    return;
  }
  if (request.method === 'GET' && pathname === '/api/unread') {
    sendJson(response, 200, { ids: await bridge.unreadThreads() });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/projects') {
    sendJson(response, 200, { projects: await bridge.listProjects() });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/projects') {
    const body = await readBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : null;
    const root = typeof body.path === 'string' ? body.path.trim() : null;
    if (typeof name !== 'string' || !name || name.length > 100) throw new HttpError(400, '项目名称需为 1 到 100 字');
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new HttpError(400, '项目目录必须是绝对路径');
    let stat;
    try {
      stat = await fs.promises.stat(root);
    } catch {
      throw new HttpError(400, '项目目录不存在');
    }
    if (!stat.isDirectory()) throw new HttpError(400, '项目目录不是文件夹');
    const result = await bridge.createLocalProject(name, root);
    if (!result) throw new HttpError(409, 'Desktop 未信任该项目目录');
    const project = (await bridge.listProjects()).find((entry) => entry.id === result.projectId);
    if (!project) throw new HttpError(503, '项目已创建，但暂未出现在 Desktop 项目列表');
    sendJson(response, 201, { project });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/threads') {
    const params = {
      limit: limitedPageSize(url.searchParams.get('limit'), 50, 100),
      archived: url.searchParams.get('archived') === '1',
    };
    if (url.searchParams.has('cwd')) {
      const cwd = url.searchParams.get('cwd');
      if (!path.isAbsolute(cwd)) throw new HttpError(400, '工作目录必须是绝对路径');
      params.cwd = cwd;
    }
    if (url.searchParams.has('cursor')) params.cursor = url.searchParams.get('cursor');
    const result = await bridge.request('thread/list', params);
    sendJson(response, 200, { threads: result.data ?? [], nextCursor: result.nextCursor ?? null });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/threads') {
    const body = await readBody(request);
    const cwd = body.cwd || workspace;
    const goalRequested = body.goal !== undefined;
    const text = messageText(goalRequested ? body.goal : body.text);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new HttpError(400, '工作目录必须是绝对路径');
    let stat;
    try {
      stat = await fs.promises.stat(cwd);
    } catch {
      throw new HttpError(400, '工作目录不存在');
    }
    if (!stat.isDirectory()) throw new HttpError(400, '工作目录不是文件夹');
    const options = await turnOptions(body, bridge);
    const permission = permissionOptions(body.permissionMode, 'request');
    const result = await bridge.request('thread/start', {
      cwd, ...(options.model ? { model: options.model } : {}),
      approvalPolicy: permission.approvalPolicy,
      approvalsReviewer: permission.approvalsReviewer,
      sandbox: permission.sandbox,
    });
    try {
      if (goalRequested) {
        const goal = await setGoal(result.thread.id, { ...body, objective: text, status: 'active' }, false);
        sendJson(response, 201, { thread: result.thread, ...goal });
        return;
      }
      const started = await bridge.request('turn/start', {
        threadId: result.thread.id,
        input: [{ type: 'text', text }],
        ...options,
        approvalPolicy: permission.approvalPolicy,
        approvalsReviewer: permission.approvalsReviewer,
        sandboxPolicy: permission.sandboxPolicy,
      });
      sendJson(response, 201, await prepareImages({ thread: result.thread, turn: started.turn }, result.thread.id, cwd));
    } catch (error) {
      // 保留已创建聊天的 ID，网页可在同一聊天中重试首条消息。
      sendJson(response, 201, { thread: result.thread, turn: null, turnError: error.message });
    }
    return;
  }

  const itemsMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/items$/);
  if (request.method === 'GET' && itemsMatch) {
    const threadId = threadIdFromPath(itemsMatch[1]);
    sendJson(response, 200, await prepareImages(await readItemPage(bridge, {
      threadId, turnId: threadIdFromPath(itemsMatch[2]),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
    }), threadId));
    return;
  }
  const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)(?:\/(turns|interrupt|read|permissions|agent-activity|goal(?:\/clear)?|questions(?:\/answer)?))?$/);
  if (threadMatch) {
    const threadId = threadIdFromPath(threadMatch[1]);
    const action = threadMatch[2] || '';
    if (request.method === 'GET' && action === 'questions') {
      const requests = await questions.list(threadId);
      sendJson(response, 200, { requests: requests.map(({ requestId, ...entry }) => entry) });
      return;
    }
    if (request.method === 'POST' && action === 'questions/answer') {
      sendJson(response, 200, await questions.answer(threadId, await readBody(request)));
      return;
    }
    if (request.method === 'GET' && !action) {
      const [result, details] = await Promise.all([
        bridge.request('thread/read', { threadId, includeTurns: false }), threadState.read(threadId),
      ]);
      sendJson(response, 200, await prepareImages({ thread: result.thread, usage: await readLatestUsage(result.thread?.path), ...details }, threadId));
      return;
    }
    if (request.method === 'GET' && action === 'agent-activity') {
      const [result, activity] = await Promise.all([
        bridge.request('thread/read', { threadId, includeTurns: false }),
        readTurnPage(bridge, { threadId, limit: 1 }).then(
          (page) => ({ turn: page.data?.[0] ?? null, activityError: page.data?.[0]?.itemsError || null }),
          (error) => {
            // 子任务可能尚无首条消息；其它历史错误保留元数据，供页面单独提示。
            const unmaterialized = error.message?.includes('is not materialized yet; thread/turns/list is unavailable before first user message');
            return { turn: null, activityError: unmaterialized ? null : '读取子任务活动失败：' + error.message };
          },
        ),
      ]);
      sendJson(response, 200, await prepareImages({ thread: result.thread, ...activity }, threadId));
      return;
    }
    if (request.method === 'POST' && action === 'goal') {
      sendJson(response, 200, await setGoal(threadId, await readBody(request)));
      return;
    }
    if (request.method === 'POST' && action === 'goal/clear') {
      await readBody(request);
      const result = await bridge.request('thread/goal/clear', { threadId });
      threadState.clearGoal(threadId);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && action === 'permissions') {
      const current = await bridge.request('thread/resume', { threadId, excludeTurns: true });
      sendJson(response, 200, {
        approvalPolicy: current.approvalPolicy,
        approvalsReviewer: current.approvalsReviewer,
        sandbox: current.sandbox,
      });
      return;
    }
    if (request.method === 'GET' && action === 'turns') {
      const params = {
        threadId,
        // 先读摘要，再分页取回合内的过程，长回合也不一次搬运全部工具输出。
        limit: Math.min(limitedPageSize(url.searchParams.get('limit'), 5, 50), 5),
        ...(url.searchParams.get('itemsView') === 'summary' ? { itemsView: 'summary' } : {}),
      };
      if (url.searchParams.has('cursor')) params.cursor = url.searchParams.get('cursor');
      let result;
      try {
        result = await readTurnPage(bridge, params);
      } catch (error) {
        // Desktop 在首条消息前尚未物化聊天，此时历史应视为空。
        if (!error.message?.includes('is not materialized yet; thread/turns/list is unavailable before first user message')) throw error;
        sendJson(response, 200, { turns: [], nextCursor: null });
        return;
      }
      sendJson(response, 200, await prepareImages({ turns: result.data ?? [], nextCursor: result.nextCursor ?? null }, threadId));
      return;
    }
    if (request.method === 'POST' && action === 'turns') {
      const body = await readBody(request);
      const text = messageText(body.text);
      const options = await turnOptions(body, bridge);
      const permission = permissionOptions(body.permissionMode);
      const result = await bridge.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        ...options,
        ...(permission ? {
          approvalPolicy: permission.approvalPolicy,
          approvalsReviewer: permission.approvalsReviewer,
          sandboxPolicy: permission.sandboxPolicy,
        } : {}),
      });
      sendJson(response, 201, await prepareImages({ turn: result.turn }, threadId));
      return;
    }
    if (request.method === 'POST' && action === 'read') {
      await readBody(request);
      await bridge.markThreadRead(threadId);
      sendJson(response, 200, { read: true });
      return;
    }
    if (request.method === 'POST' && action === 'interrupt') {
      const body = await readBody(request);
      const current = await threadState.read(threadId);
      let pauseError = current.goalError;
      // 先暂停目标，再停止回合，防止目标调度器在回合中断后自动继续。
      let pausedGoal = null;
      if (current.goal?.status === 'active') {
        try { pausedGoal = await bridge.request('thread/goal/set', { threadId, status: 'paused' }); }
        catch (error) { pauseError = error.message; }
      }
      if (pausedGoal) threadState.updateGoal(threadId, pausedGoal.goal);
      let turnId = body.turnId;
      if (!turnId) {
        const page = await bridge.request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
        const latest = page.data?.[0];
        if (latest?.status !== 'inProgress') {
          if (pausedGoal) { sendJson(response, 200, { interrupted: false, goal: pausedGoal.goal }); return; }
          if (pauseError) throw new HttpError(503, '无法确认目标已暂停：' + pauseError);
          throw new HttpError(409, '当前没有正在运行的回合');
        }
        turnId = latest.id;
      }
      if (typeof turnId !== 'string') throw new HttpError(400, '回合 ID 无效');
      await bridge.request('turn/interrupt', { threadId, turnId });
      if (pauseError) throw new HttpError(503, '当前回合已停止，但暂停目标失败，目标可能继续推进：' + pauseError);
      sendJson(response, 200, { interrupted: true, turnId });
      return;
    }
  }

  if (request.method === 'GET' && pathname === '/api/approvals') {
    sendJson(response, 200, { approvals: approvalRelay.list(), retries: approvalRelay.listRetries() });
    return;
  }
  const approvalMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]+)\/decision$/i);
  if (request.method === 'POST' && approvalMatch) {
    const body = await readBody(request);
    await approvalRelay.decide(approvalMatch[1], body.decision);
    sendJson(response, 200, { answered: true });
    return;
  }
  throw new HttpError(404, '接口不存在');
}

  return handleApi;
}
