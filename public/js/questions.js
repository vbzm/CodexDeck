import { state, api, isDraft } from './core.js';

const requestsByThread = new Map();
const records = new Map();
const flights = new Map();
const epochs = new Map();
const loadErrors = new Map();
let renderedThread = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function recordKey(threadId, request) {
  return JSON.stringify([threadId, request.key]);
}

function answerOf(question) {
  return typeof question.answer === 'string' ? question.answer : '';
}

function reconcile(request, threadId) {
  const key = recordKey(threadId, request);
  let record = records.get(key);
  if (!record) {
    record = { key, threadId, request, questions: [], drafts: new Map(), completed: new Set(), index: 0, busy: false, error: '', card: node('article', 'question-card') };
    records.set(key, record);
  }
  const signature = JSON.stringify(request);
  const changed = record.signature !== signature;
  const selectedId = record.questions[record.index]?.id;
  for (const question of request.questions) {
    if (answerOf(question).trim()) record.completed.add(question.id);
    if (!record.drafts.has(question.id)) record.drafts.set(question.id, { value: '', confirmed: false, dirty: false, skipped: false });
  }
  record.request = request;
  record.signature = signature;
  // 回合会继续带回旧题；记住已经确认完成的题目，避免旧快照或新题将它们重新带出。
  record.questions = request.questions.filter((question) => !record.completed.has(question.id));
  const selectedIndex = record.questions.findIndex((question) => question.id === selectedId);
  record.index = selectedIndex >= 0 ? selectedIndex : 0;
  if (!record.questions.length) return record;
  if (!record.card.childNodes.length || record.renderedId !== record.questions[record.index].id ||
      (changed && !record.busy && !record.card.contains(document.activeElement))) renderCard(record);
  else updateActions(record);
  return record;
}

function draftFor(record, question = record.questions[record.index]) {
  return record.drafts.get(question.id);
}

function hasAnswer(draft) {
  return draft.confirmed && Boolean(draft.value.trim());
}

function readyToSend(record) {
  const drafts = record.questions.map((question) => draftFor(record, question));
  if (record.request.kind === 'blocking') return drafts.every(hasAnswer);
  return drafts.some((draft) => draft.dirty && (hasAnswer(draft) || draft.skipped));
}

function updateActions(record) {
  if (!record.actions || !record.questions.length) return;
  const { questions, index, busy } = record;
  const last = index === questions.length - 1;
  record.next.textContent = busy ? '正在发送…' : !last ? '下一题' : '发送回答';
  record.next.disabled = busy || (last ? !readyToSend(record) : !hasAnswer(draftFor(record)));
  record.previous.disabled = busy || index === 0;
  record.previous.hidden = questions.length === 1;
  if (record.skip) record.skip.disabled = busy;
  record.card.setAttribute('aria-busy', String(busy));
  for (const control of record.card.querySelectorAll('.question-options button, .question-answer-input')) control.disabled = busy;
  record.errorNode.textContent = record.error;
  record.errorNode.hidden = !record.error;
  const question = questions[index];
  if (record.progressNode) record.progressNode.textContent = (index + 1) + ' / ' + questions.length;
  const draft = draftFor(record, question);
  if (!draft.dirty) {
    const options = Array.isArray(question.options) ? question.options : [];
    for (const choice of record.card.querySelectorAll('.question-option')) choice.setAttribute('aria-checked', String(draft.confirmed && choice.dataset.answer === draft.value));
    const input = record.card.querySelector('.question-answer-input');
    const customValue = options.some((option) => option.label === draft.value) ? '' : draft.value;
    if (input && input.value !== customValue) input.value = customValue;
    record.card.querySelector('.question-custom')?.classList.toggle('is-selected', Boolean(customValue));
  }
}

function navigate(record, index) {
  if (record.busy || index < 0 || index >= record.questions.length) return;
  record.index = index;
  record.error = '';
  renderCard(record);
  record.card.querySelector('.question-text')?.focus({ preventScroll: true });
}

function choose(record, question, option) {
  if (record.busy) return;
  const draft = draftFor(record, question);
  Object.assign(draft, { value: option.label, confirmed: true, dirty: true, skipped: false });
  record.error = '';
  for (const button of record.card.querySelectorAll('.question-option')) button.setAttribute('aria-checked', String(button.dataset.answer === option.label));
  const input = record.card.querySelector('.question-answer-input');
  if (input) input.value = '';
  record.card.querySelector('.question-custom')?.classList.remove('is-selected');
  updateActions(record);
}

async function submit(record) {
  if (record.busy || state.selectedId !== record.threadId || !readyToSend(record)) return;
  const { request, threadId, questions } = record;
  const answers = Object.create(null);
  const skipped = [];
  for (const question of questions) {
    const draft = draftFor(record, question);
    if (hasAnswer(draft)) answers[question.id] = draft.value.trim();
    if (draft.skipped) skipped.push(question.id);
  }
  record.busy = true;
  record.error = '';
  epochs.set(threadId, (epochs.get(threadId) || 0) + 1);
  updateActions(record);
  let sent = false;
  try {
    await api('/api/threads/' + encodeURIComponent(threadId) + '/questions/answer', {
      method: 'POST', body: JSON.stringify({ key: request.key, answers, skipped }),
    });
    sent = true;
    for (const question of questions) {
      const draft = draftFor(record, question);
      if (Object.hasOwn(answers, question.id) || skipped.includes(question.id)) {
        record.completed.add(question.id);
        draft.dirty = false;
      }
    }
    if (request.kind === 'blocking') {
      requestsByThread.set(threadId, (requestsByThread.get(threadId) || []).filter((entry) => entry.key !== request.key));
    }
    if (state.selectedId === threadId) {
      renderQuestions();
      window.dispatchEvent(new CustomEvent('codexdeck-questions-answered', { detail: { threadId } }));
      await loadQuestions();
    }
  } catch (error) {
    record.error = '回答未发送：' + error.message + '。输入已保留，请重试。';
  } finally {
    record.busy = false;
    if (state.selectedId === threadId) {
      if (sent && record.card.isConnected && record.questions.length) renderCard(record);
      else updateActions(record);
    }
  }
}

function renderCard(record) {
  const { request } = record;
  const question = record.questions[record.index];
  const draft = draftFor(record, question);
  const card = record.card;
  card.replaceChildren();
  card.dataset.requestKey = request.key;
  record.renderedId = question.id;
  const header = node('div', 'question-heading');
  const heading = node('div', 'question-heading-copy');
  heading.append(node('strong', '', question.header || 'Codex 有个问题'), node('span', 'question-kind', request.kind === 'blocking' ? '回答后继续' : '助手仍在工作，可以随时回答'));
  const progress = node('span', 'question-progress', (record.index + 1) + ' / ' + record.questions.length);
  record.progressNode = progress;
  header.append(heading, progress);
  const text = node('h2', 'question-text', question.question);
  text.tabIndex = -1;
  card.append(header, text);
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length) {
    const choices = node('div', 'question-options');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', question.question);
    options.forEach((option, index) => {
      const button = node('button', 'question-option');
      button.type = 'button';
      button.dataset.answer = option.label;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(draft.confirmed && draft.value === option.label));
      const copy = node('span', 'question-option-copy');
      const title = node('span', 'question-option-title');
      const recommended = /\s*[（(](?:Recommended|推荐)[)）]\s*$/i.test(option.label);
      title.append(node('span', '', recommended ? option.label.replace(/\s*[（(](?:Recommended|推荐)[)）]\s*$/i, '') : option.label));
      if (recommended) title.append(node('span', 'question-recommended', '推荐'));
      copy.append(title);
      if (option.description) copy.append(node('span', 'question-option-description', option.description));
      button.append(node('span', 'question-option-number', String(index + 1)), copy);
      button.addEventListener('click', () => choose(record, question, option));
      choices.append(button);
    });
    choices.addEventListener('keydown', (event) => {
      const buttons = [...choices.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else if (/^[1-9]$/.test(event.key) && buttons[Number(event.key) - 1]) {
        event.preventDefault();
        buttons[Number(event.key) - 1].click();
      }
    });
    card.append(choices);
  }
  if (request.kind === 'async' || question.isOther || !options.length) {
    const custom = node('label', 'question-custom');
    const customValue = options.some((option) => option.label === draft.value) ? '' : draft.value;
    custom.classList.toggle('is-selected', Boolean(customValue));
    custom.append(node('span', 'question-custom-label', options.length ? '或者填写自己的回答' : '你的回答'));
    const input = node(question.isSecret ? 'input' : 'textarea', 'question-answer-input');
    if (question.isSecret) { input.type = 'password'; input.autocomplete = 'off'; }
    else input.rows = 2;
    input.value = customValue;
    input.placeholder = options.length ? '写下你的想法…' : '在这里回答…';
    input.setAttribute('aria-label', options.length ? '填写自己的回答' : '你的回答');
    input.addEventListener('input', () => {
      Object.assign(draft, { value: input.value, confirmed: Boolean(input.value.trim()), dirty: true, skipped: false });
      custom.classList.toggle('is-selected', Boolean(input.value.trim()));
      for (const choice of card.querySelectorAll('.question-option')) choice.setAttribute('aria-checked', 'false');
      record.error = '';
      updateActions(record);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        record.next.click();
      }
    });
    custom.append(input);
    card.append(custom);
  }
  record.errorNode = node('p', 'question-error', record.error);
  record.errorNode.setAttribute('role', 'alert');
  const actions = node('div', 'question-actions');
  record.actions = actions;
  record.previous = node('button', 'subtle-button question-previous', '上一题');
  record.previous.type = 'button';
  record.previous.hidden = record.questions.length === 1;
  record.previous.addEventListener('click', () => navigate(record, record.index - 1));
  actions.append(record.previous);
  if (request.kind === 'async') {
    record.skip = node('button', 'subtle-button question-skip', '跳过');
    record.skip.type = 'button';
    record.skip.addEventListener('click', () => {
      if (record.busy) return;
      Object.assign(draft, { value: '', confirmed: false, dirty: true, skipped: true });
      if (record.index < record.questions.length - 1) navigate(record, record.index + 1);
      else void submit(record);
    });
    actions.append(record.skip);
  } else record.skip = null;
  record.next = node('button', 'primary-button question-next');
  record.next.type = 'button';
  record.next.addEventListener('click', () => {
    if (record.index < record.questions.length - 1) navigate(record, record.index + 1);
    else void submit(record);
  });
  actions.append(record.next);
  card.append(record.errorNode, actions);
  updateActions(record);
}

export function resetQuestionPanel() {
  const section = document.getElementById('questionSection');
  if (!section) return;
  section.hidden = true;
  section.replaceChildren();
  renderedThread = null;
}

export function renderQuestions() {
  const section = document.getElementById('questionSection');
  if (!section) return;
  const id = state.selectedId;
  if (!id || isDraft(id)) { resetQuestionPanel(); return; }
  if (state.selectedThread?.id === id && state.selectedThread.status?.type !== 'active') {
    requestsByThread.delete(id);
    resetQuestionPanel();
    return;
  }
  if (renderedThread !== id) {
    section.replaceChildren();
    renderedThread = id;
  }
  const requests = requestsByThread.get(id) || [];
  const cards = requests.filter((request) => request.questions?.length).map((request) => reconcile(request, id))
    .filter((record) => record.questions.length).map((record) => record.card);
  for (const child of [...section.children]) if (!cards.includes(child)) child.remove();
  cards.forEach((card, index) => { if (section.children[index] !== card) section.insertBefore(card, section.children[index] || null); });
  section.hidden = !cards.length;
  const expected = state.selectedThread?.status?.activeFlags?.includes('waitingOnUserInput') ||
    [...state.turns.values()].some((turn) => turn.status === 'inProgress' && turn.items?.some((item) => item.type === 'agentMessage' && item.questions?.length));
  if (!cards.length && expected && loadErrors.has(id)) {
    const error = node('p', 'question-error', '问题暂时无法同步：' + loadErrors.get(id));
    error.setAttribute('role', 'alert');
    const retry = node('button', 'subtle-button', '重试读取问题');
    retry.type = 'button';
    retry.addEventListener('click', () => void loadQuestions());
    section.replaceChildren(error, retry);
    section.hidden = false;
  }
}

export async function loadQuestions({ force = false } = {}) {
  const id = state.selectedId;
  renderQuestions();
  if (!id || isDraft(id)) return;
  const turns = state.turns;
  const epoch = epochs.get(id) || 0;
  const existing = flights.get(id);
  if (!force && existing?.turns === turns && existing.epoch === epoch) return existing.promise;
  existing?.controller.abort();
  const controller = new AbortController();
  const flight = { turns, epoch, controller };
  const timeout = setTimeout(() => controller.abort(), 30000);
  flight.promise = (async () => {
    try {
      const result = await api('/api/threads/' + encodeURIComponent(id) + '/questions', { signal: controller.signal });
      // A→B→A 时旧读取也可能命中相同 ID，必须同时检查该次选择的历史容器。
      if (flights.get(id) !== flight || state.selectedId !== id || state.turns !== turns || (epochs.get(id) || 0) !== epoch) return;
      const requests = Array.isArray(result.requests) ? result.requests.filter((request) => request.threadId === id && Array.isArray(request.questions)) : [];
      loadErrors.delete(id);
      requestsByThread.set(id, requests);
      const keys = new Set(requests.map((request) => recordKey(id, request)));
      for (const [key, record] of records) if (record.threadId === id) {
        if (!keys.has(key) && !record.busy) records.delete(key);
        else if (record.error.startsWith('问题同步失败：')) record.error = '';
      }
      renderQuestions();
    } catch (error) {
      if (flights.get(id) !== flight || state.selectedId !== id || state.turns !== turns) return;
      const message = error.name === 'AbortError' ? '读取问题超时，请重试' : error.message;
      loadErrors.set(id, message);
      for (const record of records.values()) if (record.threadId === id && record.card.isConnected) {
        record.error = '问题同步失败：' + message + '，正在等待重试。';
        updateActions(record);
      }
      renderQuestions();
    } finally {
      clearTimeout(timeout);
      if (flights.get(id) === flight) flights.delete(id);
    }
  })();
  flights.set(id, flight);
  return flight.promise;
}
