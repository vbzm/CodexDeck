import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const settingsDirectory = process.platform === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));

export const themeFile = process.env.CODEX_GATEWAY_THEME_FILE ||
  path.join(settingsDirectory, 'CodexDeck', 'theme.txt');

export async function readTheme(file = themeFile) {
  try {
    const theme = (await fs.readFile(file, 'utf8')).trim();
    return theme === 'dark' || theme === 'light' ? theme : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeTheme(theme, file = themeFile) {
  if (theme !== 'dark' && theme !== 'light') throw new Error('主题只能是深色或浅色');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, theme, 'utf8');
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
