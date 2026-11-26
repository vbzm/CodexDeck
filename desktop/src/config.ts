import path from 'node:path';
import { isIP } from 'node:net';

export interface LauncherSettings {
  gatewayHost: string;
  gatewayPort: number;
  cdpPort: number;
  workspace: string;
  startAllOnOpen: boolean;
  startAtLogin: boolean;
}

export function defaultSettings(workspace: string): LauncherSettings {
  return {
    gatewayHost: '127.0.0.1',
    gatewayPort: 8787,
    cdpPort: 49397,
    workspace,
    startAllOnOpen: false,
    startAtLogin: false,
  };
}

function port(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name}必须是 1–65535 的整数`);
  }
  return number;
}

export function validateSettings(value: unknown, workspace: string): LauncherSettings {
  if (!value || typeof value !== 'object') throw new Error('配置格式无效');
  const input = value as Record<string, unknown>;
  const gatewayHost = String(input.gatewayHost ?? '').trim();
  if (gatewayHost !== 'localhost' && !isIP(gatewayHost)) {
    throw new Error('监听地址必须是 IP 地址或 localhost');
  }
  const folder = String(input.workspace ?? '').trim();
  if (!path.win32.isAbsolute(folder)) throw new Error('工作目录必须是绝对路径');
  return {
    gatewayHost,
    gatewayPort: port(input.gatewayPort, '网关端口'),
    cdpPort: port(input.cdpPort, 'CDP 端口'),
    workspace: path.win32.normalize(folder || workspace),
    startAllOnOpen: input.startAllOnOpen === true,
    startAtLogin: input.startAtLogin === true,
  };
}

export function gatewayOrigin(settings: LauncherSettings): string {
  const host = settings.gatewayHost === '0.0.0.0' ? '127.0.0.1'
    : settings.gatewayHost === '::' ? '::1' : settings.gatewayHost;
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${settings.gatewayPort}`;
}

export function isLocalHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}
