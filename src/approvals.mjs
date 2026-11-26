import { randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';

export function createApprovalRelay(bridge, { onStatus, onDisconnect } = {}) {
  const approvals = new Map();
  const identities = new Map();
  const retries = new Map();
  bridge.onDisconnect = () => {
    // 页面重建后，旧请求 ID 可能被复用；旧审批必须由桌面重新确认。
    approvals.clear();
    identities.clear();
    retries.clear();
    onDisconnect?.();
  };

  function add(event) {
    const params = event.params || {};
    if (!params.threadId || event.id === undefined || !event.method) return;
    const identity = [bridge.generation, event.hostId, event.id, params.threadId,
      params.turnId, params.itemId, params.approvalId].join(':');
    if (identities.has(identity)) return;
    const key = randomUUID();
    approvals.set(key, { key, identity, generation: bridge.generation, hostId: event.hostId,
      id: event.id, method: event.method, params, receivedAt: Date.now() });
    identities.set(identity, key);
  }

  let polling = false;
  function updateRetry(event) {
    const params = event.params || {};
    if (!params.turnId) return;
    if (event.method === 'error' && params.willRetry === true) {
      retries.set(params.turnId, { threadId: params.threadId, turnId: params.turnId,
        message: params.error?.message || null, receivedAt: Date.now() });
    } else {
      retries.delete(params.turnId);
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const events = await bridge.drainEvents();
      for (const event of events.approvals) add(event);
      for (const event of events.statuses) {
        updateRetry(event);
        onStatus?.(event);
      }
    } catch {
      // Desktop 关闭或重启后，下次轮询自动重连。
    } finally {
      polling = false;
    }
  }
  setInterval(poll, 1000);
  void poll();

  function list() {
    return [...approvals.values()].map((approval) => ({
      key: approval.key,
      method: approval.method,
      threadId: approval.params.threadId,
      turnId: approval.params.turnId,
      command: approval.params.command ?? null,
      cwd: approval.params.cwd ?? null,
      reason: approval.params.reason ?? null,
      kind: approval.params.kind ?? null,
      availableDecisions: approval.params.availableDecisions ?? [],
      receivedAt: approval.receivedAt,
    }));
  }

  function listRetries() {
    return [...retries.values()];
  }

  async function decide(key, decision) {
    const approval = approvals.get(key);
    if (!approval) throw new HttpError(404, '审批请求已不存在');
    if (approval.generation !== bridge.generation) throw new HttpError(409, '桌面连接已变化，请重新检查审批');
    if (approval.method !== 'item/commandExecution/requestApproval') {
      throw new HttpError(409, '当前仅支持命令审批，请在桌面处理此请求');
    }
    if (!['accept', 'decline', 'cancel'].includes(decision) ||
        !approval.params.availableDecisions?.includes(decision)) {
      throw new HttpError(400, '此审批不支持该决定');
    }
    const status = await bridge.request('thread/read', {
      threadId: approval.params.threadId,
      includeTurns: false,
    });
    if (!status.thread?.status?.activeFlags?.includes('waitingOnApproval')) {
      approvals.delete(key);
      identities.delete(approval.identity);
      throw new HttpError(409, '该聊天已不再等待审批');
    }
    await bridge.respondToApproval(approval, decision);
    approvals.delete(key);
    identities.delete(approval.identity);
  }

  return { list, listRetries, decide, get count() { return approvals.size; } };
}
