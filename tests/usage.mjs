import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLatestUsage } from '../src/usage.mjs';

const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codexdeck-usage-'));
const expected = { lastInputTokens: 123, lastTotalTokens: 456, totalTokens: 789, modelContextWindow: 10000 };
const tokenLine = (value = expected, extra = {}) => JSON.stringify({ payload: { type: 'token_count', info: {
  last_token_usage: { input_tokens: value.lastInputTokens, total_tokens: value.lastTotalTokens },
  total_token_usage: { total_tokens: value.totalTokens }, model_context_window: value.modelContextWindow,
}, ...extra } });
const originalOpen = fs.promises.open;
let reads = 0;
let bytes = 0;
let closes = 0;
let opens = 0;
let failedReadPath = null;
fs.promises.open = async (...args) => {
  const file = await originalOpen(...args);
  opens++;
  const read = file.read.bind(file);
  const close = file.close.bind(file);
  file.read = async (...readArgs) => {
    reads++;
    if (args[0] === failedReadPath) throw new Error('模拟读取失败');
    const result = await read(...readArgs);
    bytes += result.bytesRead;
    return result;
  };
  file.close = async () => { closes++; return close(); };
  return file;
};
async function check(name, content, value = expected) {
  const filename = path.join(directory, name + '.jsonl');
  await fs.promises.writeFile(filename, content, 'utf8');
  assert.deepEqual(await readLatestUsage(filename), value, name);
  return filename;
}

try {
  assert.equal(await readLatestUsage(null), null);
  assert.equal(await readLatestUsage(path.join(directory, 'missing')), null);
  await check('empty', '', null);
  await check('first-line-without-newline', tokenLine());
  await check('latest-record', tokenLine({ ...expected, totalTokens: 1 }) + '\r\n' + tokenLine() + '\r\n');
  await check('partial-last-record', tokenLine() + '\n' + '{"payload":{"type":"token_count","info":');
  await check('false-marker', tokenLine() + '\n' + JSON.stringify({ text: '"token_count"' }) + '\n');
  await check('long-unrelated-tail', tokenLine() + '\n' + JSON.stringify({ text: '旧过程'.repeat(80000) }) + '\n');
  await check('long-token-record', tokenLine(expected, { detail: '中文说明'.repeat(40000) }) + '\n');
  await check('missing-token-record', JSON.stringify({ text: '无用量记录'.repeat(30000) }) + '\n', null);

  // 让一个中文字符横跨尾部 64 KiB 分块边界，完整行仍须正常解析。
  const prefix = tokenLine(expected, { detail: '中' });
  const boundary = Buffer.from(prefix).indexOf(Buffer.from('中')) + 1;
  const endingSize = 65536 - (Buffer.byteLength(prefix) - boundary);
  const ending = '\n' + JSON.stringify({ text: 'a'.repeat(endingSize - 12) });
  assert.equal(Buffer.byteLength(prefix + ending) - 65536, boundary);
  await check('utf8-boundary', prefix + ending);

  const before = { reads, bytes, closes };
  const filename = await check('large-with-recent-usage',
    (JSON.stringify({ text: '工具输出'.repeat(1000) }) + '\n').repeat(100) + tokenLine() + '\n');
  assert.equal(reads - before.reads, 1, '末尾已有用量时只需读取一个分块');
  assert.equal(bytes - before.bytes, 65536, '长文件只读取尾部 64 KiB');
  assert.equal(closes - before.closes, 1, '读取完成须关闭文件');
  const cachedReads = reads;
  assert.deepEqual(await readLatestUsage(filename), expected);
  assert.equal(reads, cachedReads, '文件未变时应命中缓存');
  const next = { ...expected, totalTokens: 999 };
  await fs.promises.appendFile(filename, tokenLine(next) + '\n');
  assert.deepEqual(await readLatestUsage(filename), next, '文件追加后须读取最新记录');
  failedReadPath = path.join(directory, 'read-error.jsonl');
  await fs.promises.writeFile(failedReadPath, tokenLine());
  assert.equal(await readLatestUsage(failedReadPath), null, '读取出错时保留空用量回退');
  assert.equal(opens, closes, '每次打开的文件均应关闭');
  console.log('上下文用量验证通过：尾部读取、缓存更新、跨块中文、超长行、部分写入及无记录回退');
} finally {
  fs.promises.open = originalOpen;
  await fs.promises.rm(directory, { recursive: true, force: true });
}
