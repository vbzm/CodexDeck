const TEXT_LIMIT = 100000;
const ROW_LIMIT = 800;
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/;
const prefixes = { '+': 'added', '-': 'removed', ' ': 'context' };
const renderedDiffs = new WeakMap();

function* diffRows(diff, kind) {
  if (!diff) return;
  const lines = diff.slice(0, TEXT_LIMIT).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const fullFileType = kind === 'add' || kind === 'create' ? 'added' : kind === 'delete' ? 'removed' : null;
  let oldLine = 0;
  let newLine = 0;
  let oldEnd = 0;
  let newEnd = 0;

  for (const [index, line] of lines.entries()) {
    // Desktop 的新建和删除记录是原文件内容，每一行都算变更，行首的加减号属于代码。
    if (fullFileType) {
      yield { type: fullFileType, text: line, old: fullFileType === 'removed' ? index + 1 : '',
        new: fullFileType === 'added' ? index + 1 : '' };
      continue;
    }
    const header = hunkHeader.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldEnd = oldLine + Number(header[2] ?? 1);
      newEnd = newLine + Number(header[4] ?? 1);
      yield { type: 'hunk', text: line };
      continue;
    }

    const inHunk = oldLine < oldEnd || newLine < newEnd;
    const type = prefixes[line[0]];
    // 块外的 --- 和 +++ 是文件头。块内以相同符号开头的代码仍需计入变更。
    if (!type || (!inHunk && (type === 'context' || /^(?:---|\+\+\+)(?:\s|$)/.test(line)))) {
      yield { type: 'note', text: line };
      continue;
    }
    yield { type, text: line.slice(1),
      old: type !== 'added' && oldLine < oldEnd ? oldLine++ : '',
      new: type !== 'removed' && newLine < newEnd ? newLine++ : '' };
  }
}

export function renderFileChangeTitle(change) {
  const title = document.createElement('span');
  title.className = 'activity-title file-change-title';
  const name = document.createElement('span');
  name.className = 'file-change-name';
  const filename = (change.path || '').split(/[\\/]/).at(-1) || '文件';
  const kind = change.kind?.type;
  const verb = kind === 'delete' ? '删除了' : kind === 'add' || kind === 'create' ? '创建了' : '编辑了';
  name.textContent = verb + ' ' + filename;
  name.title = change.path || name.textContent;
  title.append(name);

  const { diff: content } = change;
  const diff = typeof content === 'string' ? content : '';
  const counts = { added: 0, removed: 0 };
  for (const row of diffRows(diff, kind)) {
    if (Object.hasOwn(counts, row.type)) counts[row.type]++;
  }
  const partial = diff.length > TEXT_LIMIT;
  if (counts.added || counts.removed || partial) {
    const stats = document.createElement('span');
    stats.className = 'file-change-counts';
    stats.title = (partial ? '部分统计 · ' : '') + '新增 ' + counts.added + ' 行，删除 ' + counts.removed + ' 行';
    for (const [type, mark] of [['added', '+'], ['removed', '-']]) {
      const count = document.createElement('span');
      count.dataset.kind = type;
      count.textContent = mark + counts[type];
      stats.append(count);
    }
    if (partial) stats.append('部分');
    title.append(stats);
  }
  return title;
}

export function renderFileDiff(change, previous) {
  const path = change.path || '';
  const kind = change.kind?.type;
  const { diff: content } = change;
  const diff = typeof content === 'string' ? content : '';
  const old = renderedDiffs.get(previous);
  if (old && old.path === path && old.kind === kind && old.diff === diff) {
    // 对话轮询会替换活动分组。复用已展开的差异，并在新分组挂载后恢复阅读位置。
    const scroll = previous.querySelector('.file-diff-scroll');
    if (scroll?.scrollTop) {
      const top = scroll.scrollTop;
      requestAnimationFrame(() => { if (scroll.isConnected) scroll.scrollTop = top; });
    }
    return previous;
  }

  const figure = document.createElement('figure');
  figure.className = 'file-diff';
  const caption = document.createElement('figcaption');
  caption.className = 'file-diff-path';
  caption.textContent = path || '文件差异';
  figure.append(caption);
  renderedDiffs.set(figure, { path, kind, diff });

  if (diff) {
    const scroll = document.createElement('div');
    scroll.className = 'file-diff-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', path ? '文件差异 · ' + path : '文件差异');
    const table = document.createElement('table');
    table.className = 'file-diff-table';
    const heading = table.createTHead().insertRow();
    for (const label of ['旧行', '新行', '变更内容']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      heading.append(cell);
    }
    const body = table.createTBody();
    let rendered = 0;
    let truncated = diff.length > TEXT_LIMIT;
    for (const line of diffRows(diff, kind)) {
      if (rendered === ROW_LIMIT) {
        truncated = true;
        break;
      }
      rendered++;
      const row = body.insertRow();
      row.dataset.kind = line.type;
      if (line.type !== 'hunk' && line.type !== 'note') {
        for (const number of [line.old, line.new]) {
          const gutter = row.insertCell();
          gutter.className = 'file-diff-number';
          gutter.textContent = number;
        }
      }
      const cell = row.insertCell();
      if (row.cells.length === 1) cell.colSpan = 3;
      else {
        cell.className = 'file-diff-code';
        if (line.type !== 'context') {
          const sign = document.createElement('span');
          sign.className = 'file-diff-sign';
          sign.textContent = line.type === 'added' ? '+' : '-';
          cell.append(sign);
        }
      }
      const code = document.createElement('code');
      code.textContent = line.text;
      cell.append(code);
    }
    scroll.append(table);
    figure.append(scroll);
    if (!truncated) return figure;
  }
  const notice = document.createElement('p');
  notice.className = 'file-diff-notice';
  notice.textContent = diff ? '差异过长，当前显示部分内容。完整差异可在 Codex Desktop 中查看。' : '没有差异内容。';
  figure.append(notice);
  return figure;
}
