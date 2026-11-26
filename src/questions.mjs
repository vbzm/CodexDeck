import { createHash } from 'node:crypto';
import { HttpError } from './http.mjs';
import { readItemPage } from './history.mjs';

const REPLY_START = '<send_user_message_question_reply>';
const REPLY_END = '</send_user_message_question_reply>';

export function parseQuestionReply(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value.startsWith(REPLY_START) || !value.endsWith(REPLY_END)) return null;
  try {
    const parsed = JSON.parse(value.slice(REPLY_START.length, -REPLY_END.length));
    const answers = Array.isArray(parsed) ? parsed : [parsed];
    return answers.length && answers.every((answer) => answer &&
      typeof answer.questionItemId === 'string' && typeof answer.question === 'string' &&
      typeof answer.answer === 'string') ? answers : null;
  } catch { return null; }
}

function replyText(item) {
  return (item.type === 'steeringUserMessage' ? item.input : item.content || [])
    ?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || '';
}

function requestKey(kind, turnId, identity, questions) {
  // 连同题目内容校验，避免 Desktop 重连后复用请求编号时答到另一道题。
  return createHash('sha256').update(JSON.stringify([kind, turnId, identity, questions])).digest('hex');
}

export function questionRequests(threadId, pending, turn) {
  const requests = [];
  for (const request of pending || []) {
    if (request.method !== 'item/tool/requestUserInput' || request.params?.threadId !== threadId) continue;
    const questions = (request.params.questions || []).map((question) => ({
      id: question.id, header: question.header || '', question: question.question,
      options: (question.options || []).map((option) => ({ label: option.label, description: option.description || '' })),
      isOther: question.isOther === true, isSecret: question.isSecret === true,
    }));
    if (!questions.length) continue;
    requests.push({ key: requestKey('blocking', request.params.turnId, request.id, questions),
      kind: 'blocking', threadId, turnId: request.params.turnId, questions,
      requestId: request.id });
  }
  if (turn?.status !== 'inProgress') return requests;
  const questions = (turn.items || []).flatMap((item) => item.type === 'agentMessage' ?
    (item.questions || []).map((question, index) => ({
      id: JSON.stringify(['request_user_input_async', item.id, index]),
      question: question.title, options: (question.options || []).map((label) => ({ label, description: '' })),
      isOther: true,
    })) : []);
  if (!questions.length) return requests;
  const answers = new Map();
  for (const item of turn.items || []) {
    if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' &&
        (item.status === 'accepted' || item.steerAcknowledged === true))) continue;
    for (const answer of parseQuestionReply(replyText(item)) || []) answers.set(answer.questionItemId, answer.answer);
  }
  // 同一回合可能继续追加问题，面板标识保持稳定，避免丢掉已填写的草稿。
  const key = requestKey('async', turn.id, null, []);
  for (const question of questions) if (answers.has(question.id)) question.answer = answers.get(question.id);
  requests.push({ key, kind: 'async', threadId, turnId: turn.id, questions });
  return requests;
}

export function createQuestions(bridge) {
  const submitting = new Set();

  async function list(threadId) {
    const [pending, page] = await Promise.all([
      bridge.pendingUserInputs(threadId),
      bridge.request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' }).catch((error) => {
        if (error.message?.includes('is not materialized yet; thread/turns/list is unavailable before first user message')) return { data: [] };
        throw error;
      }),
    ]);
    const latest = page.data?.[0];
    if (latest?.status !== 'inProgress') return questionRequests(threadId, pending, latest);
    // 问题可能早于最近的一页过程；逐页收集题目和答案，不保留工具的大输出。
    const turn = { ...latest, items: [] };
    const seen = new Set();
    let cursor;
    do {
      const result = await readItemPage(bridge, { threadId, turnId: turn.id, ...(cursor ? { cursor } : {}) });
      turn.items.unshift(...result.items.filter((item) => item.type === 'userMessage' ||
        item.type === 'steeringUserMessage' || (item.type === 'agentMessage' && item.questions?.length)));
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new HttpError(503, '读取问题的历史游标重复，请重试');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return questionRequests(threadId, pending, turn);
  }

  async function answer(threadId, body) {
    if (typeof body.key !== 'string' || !/^[a-f0-9]{64}$/.test(body.key) ||
        !body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers) ||
        (body.skipped !== undefined && (!Array.isArray(body.skipped) || body.skipped.some((id) => typeof id !== 'string')))) {
      throw new HttpError(400, '问题答案格式无效');
    }
    const lock = threadId + ':' + body.key;
    if (submitting.has(lock)) throw new HttpError(409, '正在提交答案，请稍候');
    submitting.add(lock);
    try {
      const request = (await list(threadId)).find((entry) => entry.key === body.key);
      if (!request) throw new HttpError(409, '问题已回答或已失效，请刷新对话');
      const byId = new Map(request.questions.map((question) => [question.id, question]));
      const skipped = new Set(body.skipped || []);
      for (const id of skipped) if (!byId.has(id) || request.kind !== 'async') throw new HttpError(400, '不能跳过此问题');
      const answers = [];
      for (const [id, value] of Object.entries(body.answers)) {
        const question = byId.get(id);
        if (!question || typeof value !== 'string' || value.length > 20000 || !value.trim() || skipped.has(id)) {
          throw new HttpError(400, '问题答案无效，请检查填写内容');
        }
        const text = value.trim();
        if (question.options.length && !question.isOther && !question.options.some((option) => option.label === text)) {
          throw new HttpError(400, '请选择此问题提供的选项');
        }
        answers.push({ questionItemId: id, question: question.question, answer: text });
      }
      if (request.kind === 'blocking') {
        if (answers.length !== request.questions.length) throw new HttpError(400, '请先回答所有问题');
        const result = { answers: Object.fromEntries(answers.map((entry) => [entry.questionItemId, { answers: [entry.answer] }])) };
        const answered = await bridge.respondToUserInput(threadId, request.requestId, request.turnId, result);
        if (!answered) throw new HttpError(409, '问题已在 Desktop 中处理，请刷新对话');
      } else if (answers.length) {
        // 沿用 Desktop 的结构化回复，回答关联到原题，Desktop 也能恢复已答状态。
        const text = REPLY_START + '\n' + JSON.stringify(answers) + '\n' + REPLY_END;
        await bridge.request('turn/steer', { threadId, expectedTurnId: request.turnId,
          input: [{ type: 'text', text }] });
      } else if (!skipped.size) throw new HttpError(400, '请填写答案或跳过问题');
      return { answered: true };
    } finally {
      submitting.delete(lock);
    }
  }

  return { list, answer };
}
