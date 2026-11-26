import fs from 'node:fs';

const usageCache = new Map();

function usageFromLine(parts) {
  const line = parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse());
  if (!line.includes('"token_count"')) return null;
  try {
    const event = JSON.parse(line.toString('utf8'));
    const info = event.payload?.type === 'token_count' ? event.payload.info : null;
    return info ? {
      lastInputTokens: info.last_token_usage?.input_tokens ?? null,
      lastTotalTokens: info.last_token_usage?.total_tokens ?? null,
      totalTokens: info.total_token_usage?.total_tokens ?? null,
      modelContextWindow: info.model_context_window ?? null,
    } : null;
  } catch {
    // 会话还在写入时，末尾可能是不完整的 JSON 行，继续向前查找。
    return null;
  }
}

async function readUsageFromTail(file, size) {
  let position = size;
  let parts = [];
  while (position > 0) {
    const length = Math.min(position, 64 * 1024);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    let end = bytesRead;
    for (let index = bytesRead - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      parts.push(buffer.subarray(index + 1, end));
      const usage = usageFromLine(parts);
      if (usage) return usage;
      parts = [];
      end = index;
    }
    // 先拼完整字节行再解码，避免分块截断中文；超长行只在完整时合并一次。
    if (end) parts.push(buffer.subarray(0, end));
  }
  return parts.length ? usageFromLine(parts) : null;
}

export async function readLatestUsage(sessionPath) {
  if (!sessionPath) return null;
  try {
    const stat = await fs.promises.stat(sessionPath);
    const cached = usageCache.get(sessionPath);
    if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.usage;
    const file = await fs.promises.open(sessionPath, 'r');
    let usage;
    try {
      // 最新用量通常在文件末尾，避免每次轮询都读取长对话的全部工具输出。
      usage = await readUsageFromTail(file, stat.size);
    } finally {
      await file.close();
    }
    usageCache.set(sessionPath, { size: stat.size, mtimeMs: stat.mtimeMs, usage });
    if (usageCache.size > 100) usageCache.delete(usageCache.keys().next().value);
    return usage;
  } catch {
    return null;
  }
}
