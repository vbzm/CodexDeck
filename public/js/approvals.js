import { elements, state, api, findThread, threadName, showNotice, clearNotice } from './core.js';
import { loadSelected, updateTurnStatuses } from './conversation.js';
import { renderThreadList, renderProjects } from './sidebar.js';

let renderedApprovals = '';
let sidebarMarkers = '';

function renderApprovals(list) {
  elements.approvalList.replaceChildren();
  const waiting = state.selectedThread?.status?.activeFlags?.includes('waitingOnApproval');
  const selectedCaptured = list.some((approval) => approval.threadId === state.selectedId);
  elements.approvalSection.hidden = !list.length && !waiting;
  if (waiting && !selectedCaptured) {
    const hint = document.createElement('p');
    hint.className = 'approval-hint';
    hint.textContent = '当前对话需要授权。请在 Codex Desktop 打开此对话并完成审批，网页会自动更新。';
    elements.approvalList.append(hint);
  }
  for (const approval of [...list].sort((a, b) =>
    Number(b.threadId === state.selectedId) - Number(a.threadId === state.selectedId))) {
    const card = document.createElement('article');
    card.className = 'approval-card' + (approval.threadId === state.selectedId ? ' is-current' : '');
    const header = document.createElement('div');
    header.className = 'approval-card-header';
    const title = document.createElement('h3');
    title.textContent = approval.method === 'item/commandExecution/requestApproval' ? '命令执行请求' : '需要审批的操作';
    const context = document.createElement('p');
    context.className = 'approval-card-context';
    const thread = findThread(approval.threadId);
    context.textContent = (approval.threadId === state.selectedId ? '当前对话' :
      thread ? threadName(thread) : '对话 ' + approval.threadId.slice(0, 8)) +
      (approval.cwd ? ' · ' + approval.cwd : '');
    header.append(title, context);
    card.append(header);
    if (approval.reason) {
      const reason = document.createElement('p');
      reason.className = 'approval-card-reason';
      reason.textContent = approval.reason;
      card.append(reason);
    }
    if (approval.command) {
      const label = document.createElement('span');
      label.className = 'approval-command-label';
      label.textContent = '将执行的命令';
      const command = document.createElement('pre');
      command.className = 'approval-command';
      command.textContent = approval.command;
      card.append(label, command);
    }
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    if (approval.method === 'item/commandExecution/requestApproval') {
      const choices = [
        ['accept', '允许一次', 'primary-button'],
        ['decline', '拒绝', 'subtle-button'],
        ['cancel', '取消回合', 'danger-button'],
      ];
      for (const [decision, label, style] of choices) {
        if (!approval.availableDecisions.includes(decision)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'approval-button ' + style;
        button.textContent = label;
        button.addEventListener('click', async () => {
          for (const child of actions.querySelectorAll('button')) child.disabled = true;
          card.setAttribute('aria-busy', 'true');
          try {
            await api('/api/approvals/' + approval.key + '/decision', {
              method: 'POST',
              body: JSON.stringify({ decision }),
            });
            await loadApprovals();
            await loadSelected();
          } catch (error) {
            showNotice(error.message);
            for (const child of actions.querySelectorAll('button')) child.disabled = false;
            card.removeAttribute('aria-busy');
          }
        });
        actions.append(button);
      }
    } else {
      const message = document.createElement('p');
      message.textContent = '此类审批暂请在 Codex Desktop 中处理。';
      actions.append(message);
    }
    card.append(actions);
    elements.approvalList.append(card);
  }
}

export async function loadApprovals() {
  try {
    const result = await api('/api/approvals');
    state.approvals = result.approvals || [];
    state.retryingTurns = new Map((result.retries || []).map((retry) => [retry.turnId, retry]));
    const waiting = Boolean(state.selectedThread?.status?.activeFlags?.includes('waitingOnApproval'));
    const approvalSignature = JSON.stringify([state.approvals, waiting, state.selectedId]);
    if (approvalSignature !== renderedApprovals) {
      renderApprovals(state.approvals);
      renderedApprovals = approvalSignature;
    }
    const markers = JSON.stringify([
      ...new Set(state.approvals.map((approval) => approval.threadId)),
      waiting ? state.selectedId : null,
    ]);
    if (markers !== sidebarMarkers) {
      renderThreadList();
      renderProjects();
      sidebarMarkers = markers;
    }
    updateTurnStatuses();
    clearNotice('approvals');
  } catch (error) {
    if (elements.authPanel.hidden) showNotice(error.message, 'approvals');
  }
}
