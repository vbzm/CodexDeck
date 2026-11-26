import { DesktopBridge } from '../src/desktop-bridge.mjs';

const threadId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(threadId || '')) {
  throw new Error('请传入临时测试聊天的 ID');
}

const baseUrl = 'http://127.0.0.1:8787';
const bridge = new DesktopBridge();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let turnId = null;
let completed = false;

async function gateway(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '网关请求失败');
  return result;
}

const before = await bridge.request('thread/resume', { threadId, excludeTurns: true });
if (before.thread?.status?.type !== 'idle') {
  bridge.close();
  throw new Error('临时聊天并非空闲状态');
}
const alreadyConfigured = before.approvalPolicy === 'on-request' && before.sandbox?.type === 'readOnly';
const canOverride = before.approvalPolicy === 'never' && before.sandbox?.type === 'dangerFullAccess';
if (!alreadyConfigured && !canOverride) {
  bridge.close();
  throw new Error('临时聊天的原始设置与预期不符，已取消测试');
}

try {
  if (!alreadyConfigured) {
    await bridge.request('thread/settings/update', {
      threadId,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' },
    });
  }
  const started = await gateway('/api/threads/' + threadId + '/turns', {
    method: 'POST',
    body: JSON.stringify({
      text: '临时测试网关审批。只运行 PowerShell 的 Get-Date -Format o，并指定 sandbox_permissions 为 require_escalated 请求审批。不要读写文件或运行其他命令。获批后只回复 GATEWAY_APPROVAL_OK。',
    }),
  });
  turnId = started.turn?.id;
  if (!turnId) throw new Error('网关未返回回合 ID');

  let approval = null;
  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await gateway('/api/approvals');
    approval = result.approvals.find((item) => item.threadId === threadId && item.turnId === turnId);
    if (approval) break;
    await pause(1000);
  }
  if (!approval) throw new Error('网关未捕获到本回合审批');
  if (approval.method !== 'item/commandExecution/requestApproval' ||
      !/^"[^"]*pwsh[.]exe" -Command 'Get-Date -Format o'$/i.test(approval.command || '') ||
      !approval.availableDecisions.includes('accept')) {
    throw new Error('审批内容与预期不符，已拒绝自动批准');
  }
  await gateway('/api/approvals/' + approval.key + '/decision', {
    method: 'POST',
    body: JSON.stringify({ decision: 'accept' }),
  });

  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await gateway('/api/threads/' + threadId + '/turns?limit=1');
    const turn = result.turns[0];
    if (turn?.id === turnId && turn.status === 'completed') {
      const success = turn.items?.some((item) =>
        item.type === 'agentMessage' && item.text === 'GATEWAY_APPROVAL_OK');
      if (!success) throw new Error('审批后的回合未返回预期结果');
      completed = true;
      break;
    }
    await pause(1000);
  }
  if (!completed) throw new Error('审批后的回合未在预期时间内结束');
  console.log(JSON.stringify({ approved: true, completed, threadId, turnId }));
} finally {
  if (turnId && !completed) {
    try {
      await bridge.request('turn/interrupt', { threadId, turnId });
    } catch {
      // 已结束的回合无需再中断。
    }
  }
  if (!alreadyConfigured) {
    await bridge.request('thread/settings/update', {
      threadId,
      approvalPolicy: before.approvalPolicy,
      approvalsReviewer: before.approvalsReviewer,
      sandboxPolicy: before.sandbox,
    });
  }
  bridge.close();
}
