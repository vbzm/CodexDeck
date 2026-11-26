import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './http.mjs';

const run = promisify(execFile);

export async function listDirectories(requestedPath) {
  if (!requestedPath) {
    if (process.platform !== 'win32') return { path: null, parent: null, entries: [{ name: '/', path: '/' }] };
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-PSDrive -PSProvider FileSystem).Root | ConvertTo-Json -Compress'], { timeout: 5000, windowsHide: true });
    const roots = JSON.parse(stdout.trim());
    return { path: null, parent: null, entries: (Array.isArray(roots) ? roots : [roots]).map((root) => ({ name: root, path: root })) };
  }
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    throw new HttpError(400, '目录必须是绝对路径');
  }
  const current = path.resolve(requestedPath);
  let entries;
  try {
    if (!(await fs.stat(current)).isDirectory()) throw new HttpError(400, '所选路径不是目录');
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '无法读取此目录');
  }
  const folders = entries.filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const parent = path.dirname(current);
  return { path: current, parent: parent === current ? null : parent, entries: folders };
}
