import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createQuestions, parseQuestionReply, questionRequests } from '../src/questions.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { createApi } from '../src/api.mjs';
import { sendJson } from '../src/http.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const otherThreadId = '00000000-0000-4000-8000-000000000002';
const replyText = (answers) => '<send_user_message_question_reply>\n' + JSON.stringify(answers) + '\n</send_user_message_question_reply>';
const questionId = (itemId, index = 0) => JSON.stringify(['request_user_input_async', itemId, index]);
const clone = (value) => structuredClone(value);
const hasStatus = (status) => (error) => error.status === status;

function blockingRequest(overrides = {}) {
  return {
    id: 17, method: 'item/tool/requestUserInput',
    params: { threadId, turnId: 'turn-blocking', itemId: 'tool-input', questions: [
      { id: 'scope', header: '范围', question: '先实现哪部分？', isOther: false,
        options: [{ label: '推荐范围', description: '优先完成最常用路径' }, { label: '完整范围' }] },
      { id: 'detail', header: '补充', question: '有什么额外要求？', isOther: true, isSecret: true,
        options: [{ label: '没有额外要求', description: '按现有习惯实现' }] },
    ], ...overrides },
  };
}

function asyncTurn() {
  return { id: 'turn-async', status: 'inProgress', items: [
    { id: 'first-question', type: 'agentMessage', text: '需要确认', questions: [
      { title: '希望先做什么？', options: ['先做问题交互', '先做其它功能'] },
      { title: '还有什么要求？', options: [] },
    ] },
  ] };
}

function fixture({ pending = [], turn = asyncTurn() } = {}) {
  const data = { pending, turn, calls: [], responses: [], respond: true, beforeRead: null, beforeRespond: null, readError: null };
  const bridge = {
    async pendingUserInputs(id) {
      data.calls.push({ method: 'pendingUserInputs', params: { threadId: id } });
      await data.beforeRead?.();
      return clone(data.pending);
    },
    async request(method, params) {
      data.calls.push({ method, params: clone(params) });
      if (method === 'thread/turns/list') {
        if (data.readError) throw data.readError;
        return { data: data.turn ? [clone(data.turn)] : [] };
      }
      if (method === 'thread/items/list') return data.itemPages ? clone(data.itemPages.get(params.cursor)) :
        { data: clone(data.turn?.items || []).reverse(), nextCursor: null };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      throw new Error('测试出现未预期的 Desktop 写入：' + method);
    },
    async respondToUserInput(...args) {
      data.responses.push(clone(args));
      await data.beforeRespond?.();
      return data.respond;
    },
  };
  return { data, bridge, questions: createQuestions(bridge) };
}

const parsedAnswer = { questionItemId: 'id', question: '问题', answer: '答案' };

// 长回合的题目可能在旧过程页中，答案在新页中；不能只看最近 100 条。
const pagedQuestions = fixture();
pagedQuestions.data.itemPages = new Map([
  [null, { data: [{ id: 'reply', type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text',
    text: replyText([{ questionItemId: questionId('first-question'), question: '希望先做什么？', answer: '先做问题交互' }]) }] }], nextCursor: 'older-questions' }],
  ['older-questions', { data: [...asyncTurn().items].reverse(), nextCursor: null }],
]);
const recoveredQuestions = await pagedQuestions.questions.list(threadId);
assert.equal(recoveredQuestions[0].questions.length, 2);
assert.equal(recoveredQuestions[0].questions[0].answer, '先做问题交互');
assert.equal(pagedQuestions.data.calls.some((call) => call.params?.itemsView === 'full'), false);
pagedQuestions.data.turn.status = 'completed';
pagedQuestions.data.calls = [];
assert.deepEqual(await pagedQuestions.questions.list(threadId), []);
assert.equal(pagedQuestions.data.calls.some((call) => call.method === 'thread/items/list'), false);
const cyclicQuestions = fixture();
cyclicQuestions.data.itemPages = new Map([
  [null, { data: [], nextCursor: 'a' }], ['a', { data: [], nextCursor: 'b' }], ['b', { data: [], nextCursor: 'a' }],
]);
await assert.rejects(cyclicQuestions.questions.list(threadId), /历史游标重复/);
assert.deepEqual(parseQuestionReply(replyText([parsedAnswer])), [parsedAnswer]);
assert.deepEqual(parseQuestionReply(' \n' + replyText(parsedAnswer) + '\n '), [parsedAnswer]);
for (const invalid of [null, '', '普通问题？', replyText([]), replyText({}), replyText([null]),
  replyText([{ ...parsedAnswer, answer: 1 }]), '<send_user_message_question_reply>{</send_user_message_question_reply>']) {
  assert.equal(parseQuestionReply(invalid), null);
}

const native = blockingRequest();
const normalized = questionRequests(threadId, [native, { ...native, method: 'item/commandExecution/requestApproval' },
  blockingRequest({ threadId: otherThreadId })], null);
assert.equal(normalized.length, 1);
assert.equal(normalized[0].kind, 'blocking');
assert.equal(normalized[0].requestId, 17);
assert.deepEqual(normalized[0].questions[0].options[1], { label: '完整范围', description: '' });
assert.equal(normalized[0].questions[1].isSecret, true);
assert.notEqual(normalized[0].key,
  questionRequests(threadId, [blockingRequest({ questions: [{ id: 'scope', question: '已更新的问题' }] })], null)[0].key);

const active = asyncTurn();
const initial = questionRequests(threadId, [], active)[0];
assert.equal(initial.kind, 'async');
assert.equal(initial.questions[0].id, questionId('first-question'));
assert.equal(initial.questions[1].id, questionId('first-question', 1));
assert.deepEqual(initial.questions[0].options[0], { label: '先做问题交互', description: '' });
active.items.push({ id: 'later-question', type: 'agentMessage', questions: [{ title: '后来追加的问题', options: ['可以'] }] });
assert.equal(questionRequests(threadId, [], active)[0].key, initial.key);
assert.equal(questionRequests(threadId, [], active)[0].questions.length, 3);
for (const status of ['completed', 'failed', 'interrupted']) {
  assert.deepEqual(questionRequests(threadId, [], { ...active, status }), []);
}

// 排队中的消息不能提前充当已答记录，只有服务端接受后的答案才恢复到题目。
const answeredText = replyText([{ questionItemId: initial.questions[0].id, question: '希望先做什么？', answer: '我的回答' }]);
const answeredTurn = asyncTurn();
answeredTurn.items.push({ id: 'reply', type: 'steeringUserMessage', status: 'pending', input: [{ type: 'text', text: answeredText }] });
assert.equal(questionRequests(threadId, [], answeredTurn)[0].questions[0].answer, undefined);
answeredTurn.items.at(-1).status = 'rejected';
assert.equal(questionRequests(threadId, [], answeredTurn)[0].questions[0].answer, undefined);
answeredTurn.items.at(-1).status = 'accepted';
assert.equal(questionRequests(threadId, [], answeredTurn)[0].questions[0].answer, '我的回答');
answeredTurn.items.at(-1).status = 'pending';
answeredTurn.items.at(-1).steerAcknowledged = true;
assert.equal(questionRequests(threadId, [], answeredTurn)[0].questions[0].answer, '我的回答');
answeredTurn.items.at(-1).steerAcknowledged = false;
answeredTurn.items.push({ id: 'confirmed', type: 'userMessage', content: [{ type: 'text', text: answeredText }] });
assert.equal(questionRequests(threadId, [], answeredTurn)[0].questions[0].answer, '我的回答');

const blocking = fixture({ pending: [native], turn: null });
const blockingKey = (await blocking.questions.list(threadId))[0].key;
const validBody = { key: blockingKey, answers: { scope: '推荐范围', detail: '保留现有样式' } };
assert.deepEqual(await blocking.questions.answer(threadId, validBody), { answered: true });
assert.deepEqual(blocking.data.responses[0], [threadId, 17, 'turn-blocking', {
  answers: { scope: { answers: ['推荐范围'] }, detail: { answers: ['保留现有样式'] } },
}]);
for (const answers of [{ scope: '推荐范围' }, { scope: '非法选项', detail: '补充' },
  { scope: '', detail: '补充' }, { scope: 1, detail: '补充' }, { scope: '推荐范围', detail: 'a'.repeat(20001) },
  { scope: '推荐范围', detail: '补充', injected: '其它题目' }]) {
  await assert.rejects(blocking.questions.answer(threadId, { key: blockingKey, answers }), hasStatus(400));
}
await assert.rejects(blocking.questions.answer(threadId, { ...validBody, skipped: ['scope'] }), hasStatus(400));
for (const body of [{ key: 'bad', answers: {} }, { key: blockingKey, answers: [] },
  { key: blockingKey }, { ...validBody, skipped: [1] }]) {
  await assert.rejects(blocking.questions.answer(threadId, body), hasStatus(400));
}
assert.equal(blocking.data.responses.length, 1);
await assert.rejects(blocking.questions.answer(otherThreadId, validBody), hasStatus(409));
blocking.data.pending = [];
await assert.rejects(blocking.questions.answer(threadId, validBody), hasStatus(409));
blocking.data.pending = [native];
blocking.data.respond = false;
await assert.rejects(blocking.questions.answer(threadId, validBody), hasStatus(409));
blocking.data.respond = true;
await blocking.questions.answer(threadId, validBody);

const unmaterialized = fixture({ turn: null });
unmaterialized.data.readError = new Error('thread is not materialized yet; thread/turns/list is unavailable before first user message');
assert.deepEqual(await unmaterialized.questions.list(threadId), []);
unmaterialized.data.readError = new Error('其它读取错误');
await assert.rejects(unmaterialized.questions.list(threadId), /其它读取错误/);

// 回答沿用正在进行的回合；若服务端拒绝旧回合，不能偷偷启动新回合。
const asynchronous = fixture();
const asyncRequest = (await asynchronous.questions.list(threadId))[0];
const firstId = asyncRequest.questions[0].id;
const secondId = asyncRequest.questions[1].id;
await asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: { [firstId]: '  自定义回答  ' }, skipped: [secondId] });
const steered = asynchronous.data.calls.find((call) => call.method === 'turn/steer');
assert.equal(steered.params.threadId, threadId);
assert.equal(steered.params.expectedTurnId, 'turn-async');
assert.deepEqual(parseQuestionReply(steered.params.input[0].text), [
  { questionItemId: firstId, question: '希望先做什么？', answer: '自定义回答' },
]);
assert.equal(asynchronous.data.calls.some((call) => call.method === 'turn/start'), false);
assert.equal(asynchronous.data.responses.length, 0);
const writesBeforeSkip = asynchronous.data.calls.filter((call) => call.method === 'turn/steer').length;
await asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: {}, skipped: [firstId, secondId] });
assert.equal(asynchronous.data.calls.filter((call) => call.method === 'turn/steer').length, writesBeforeSkip);
await assert.rejects(asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: {} }), hasStatus(400));
await assert.rejects(asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: {}, skipped: ['foreign'] }), hasStatus(400));
await assert.rejects(asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: { [firstId]: '回答' }, skipped: [firstId] }), hasStatus(400));
asynchronous.data.turn.status = 'completed';
await assert.rejects(asynchronous.questions.answer(threadId, { key: asyncRequest.key, answers: { [firstId]: '回答' } }), hasStatus(409));
assert.equal(asynchronous.data.calls.some((call) => call.method === 'turn/start'), false);

let releaseRead;
const concurrent = fixture({ pending: [native], turn: null });
concurrent.data.beforeRead = () => new Promise((resolve) => { releaseRead = resolve; });
const firstSubmit = concurrent.questions.answer(threadId, validBody);
await assert.rejects(concurrent.questions.answer(threadId, validBody), hasStatus(409));
releaseRead();
await firstSubmit;
assert.equal(concurrent.data.responses.length, 1);

// 使用内存模块模拟 Desktop RPC 属性投影，不需要读取真实聊天或向 Desktop 发消息。
const servicesUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const state = { status: 'ready', requests: [], opens: [], reads: [], replies: [], disposals: 0, failRead: false, failReply: false };
  export const host = { appServerManagers: { async open(hostId) {
    state.opens.push(hostId);
    return { status: state.status, manager: {
      getConversation(threadId) { state.reads.push(threadId); return { get requests() {
        return state.failRead ? Promise.reject(new Error('读取待答问题失败')) : Promise.resolve(structuredClone(state.requests));
      } }; },
      async replyWithUserInputResponse(...args) {
        if (state.failReply) throw new Error('提交原生答案失败');
        state.replies.push(args);
      },
      [Symbol.dispose]() { state.disposals++; },
    } };
  } } };
`);
const { state: nativeState } = await import(servicesUrl);
const nativeBridge = new DesktopBridge();
nativeBridge.evaluate = (expression) => new Function('document', 'return ' + expression)({
  querySelector: () => ({ href: servicesUrl }),
});
nativeState.requests = [native, { id: 19, method: 'item/fileChange/requestApproval', params: { threadId } }];
assert.deepEqual(await nativeBridge.pendingUserInputs(threadId), [native]);
assert.deepEqual(nativeState.opens, ['local']);
assert.deepEqual(nativeState.reads, [threadId]);
assert.equal(nativeState.disposals, 1);
const nativeResponse = { answers: { scope: { answers: ['推荐范围'] }, detail: { answers: ['补充'] } } };
assert.equal(await nativeBridge.respondToUserInput(threadId, 17, 'turn-blocking', nativeResponse), true);
assert.deepEqual(nativeState.replies, [[threadId, 17, nativeResponse]]);
assert.equal(await nativeBridge.respondToUserInput(threadId, 17, 'old-turn', nativeResponse), false);
assert.equal(await nativeBridge.respondToUserInput(threadId, 999, 'turn-blocking', nativeResponse), false);
assert.equal(nativeState.replies.length, 1);
nativeState.failRead = true;
await assert.rejects(nativeBridge.pendingUserInputs(threadId), /读取待答问题失败/);
nativeState.failRead = false;
nativeState.failReply = true;
await assert.rejects(nativeBridge.respondToUserInput(threadId, 17, 'turn-blocking', nativeResponse), /提交原生答案失败/);
nativeState.failReply = false;
assert.equal(nativeState.disposals, nativeState.opens.length);
nativeState.status = 'unavailable';
await assert.rejects(nativeBridge.pendingUserInputs(threadId), /提问服务暂不可用/);
assert.equal(nativeState.replies.length, 1);

const apiFixture = fixture({ pending: [native], turn: null });
const handleApi = createApi({ bridge: apiFixture.bridge, workspace: process.cwd(), token: 'test-token', approvalRelay: { count: 0 } });
const server = http.createServer(async (request, response) => {
  try { await handleApi(request, response, new URL(request.url, 'http://localhost')); }
  catch (error) { sendJson(response, error.status || 503, { error: error.message }); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
async function callApi(suffix, { method = 'GET', body, headers = {}, authorized = true } = {}) {
  const response = await fetch(base + '/api/threads/' + suffix, { method,
    headers: { ...(authorized ? { authorization: 'Bearer test-token' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
try {
  assert.equal((await callApi(threadId + '/questions', { authorized: false })).status, 401);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: validBody, authorized: false })).status, 401);
  assert.equal(apiFixture.data.calls.length, 0);
  const listed = await callApi(threadId + '/questions');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.requests[0].kind, 'blocking');
  assert.equal(Object.hasOwn(listed.body.requests[0], 'requestId'), false);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: validBody })).status, 200);
  assert.equal((await callApi(otherThreadId + '/questions/answer', { method: 'POST', body: validBody })).status, 409);
  assert.equal((await callApi('invalid/questions')).status, 400);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: validBody,
    headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await callApi(threadId + '/questions/answer', { method: 'POST', body: validBody,
    headers: { origin: 'http://other-site.invalid' } })).status, 403);
  assert.equal(apiFixture.data.responses.length, 1);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('提问解析、同步与异步回答、原生请求恢复、防重复与接口校验通过');
