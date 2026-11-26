import fs from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import { defaultSettings, LauncherSettings, validateSettings } from './config';

interface StoredFile {
  version: 1;
  settings: LauncherSettings;
  encryptedToken?: string;
}

export interface SavedConfiguration {
  settings: LauncherSettings;
  token: string;
}

export async function loadConfiguration(file: string, workspace: string): Promise<SavedConfiguration> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: defaultSettings(workspace), token: '' };
    }
    throw error;
  }
  const stored = JSON.parse(content) as StoredFile;
  if (stored.version !== 1) throw new Error('启动器配置版本不受支持');
  const settings = validateSettings(stored.settings, workspace);
  if (!stored.encryptedToken) return { settings, token: '' };
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法读取访问令牌');
  const token = safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64'));
  return { settings, token };
}

export async function saveConfiguration(file: string, value: SavedConfiguration): Promise<void> {
  if (value.token && !safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法保存访问令牌');
  }
  const stored: StoredFile = {
    version: 1,
    settings: value.settings,
    ...(value.token ? { encryptedToken: safeStorage.encryptString(value.token).toString('base64') } : {}),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
