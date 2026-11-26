import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { gatewayOrigin, LauncherSettings } from './config';

const execFileAsync = promisify(execFile);

export interface DesktopStatus {
  running: boolean;
  cdpReady: boolean;
}

export type GatewayProbe =
  | { kind: 'free' }
  | { kind: 'occupied' }
  | { kind: 'codexdeck'; connected: boolean };

async function requestDesktopQuit(port: number): Promise<boolean> {
  let target: { webSocketDebuggerUrl?: string } | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const targets: unknown = await response.json();
    if (!Array.isArray(targets)) return false;
    target = targets.find((value) => value?.type === 'page' && value.url === 'app://-/index.html');
  } catch {
    return false;
  }
  const socketUrl = target?.webSocketDebuggerUrl;
  if (!socketUrl) return false;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let sent = false;
    const finish = (error?: Error, accepted = true) => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.close();
      if (error) reject(error);
      else resolve(accepted);
    };
    const onOpen = () => {
      // 关闭窗口只会让 Windows 版驻留后台；使用应用自己的退出消息，保留退出确认与保存流程。
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
          expression: '(async () => { if (typeof window.electronBridge?.sendMessageFromView !== "function") return false; await window.electronBridge.sendMessageFromView({ type: "quit-app" }); return true; })()',
          awaitPromise: true, returnByValue: true,
        } }));
        sent = true;
      } catch {
        finish(new Error('发送 Desktop 退出请求失败，请在应用中手动退出后重试。'));
      }
    };
    const onMessage = (event: MessageEvent) => {
      let packet;
      try { packet = JSON.parse(String(event.data)); } catch { return; }
      if (packet.id !== 1) return;
      if (packet.error || packet.result?.exceptionDetails) {
        finish(new Error('Desktop 正常退出请求失败，请在应用中手动退出后重试。'));
      } else {
        finish(undefined, packet.result?.result?.value === true);
      }
    };
    const onError = () => finish(new Error('连接 Desktop 退出接口失败，请在应用中手动退出后重试。'));
    // 正常退出可能先关闭 CDP，后面的进程等待会确认应用确实已经结束。
    const onClose = () => sent ? finish() : onError();
    const timer = setTimeout(() => finish(new Error('连接 Desktop 退出接口超时，请在应用中手动退出后重试。')), 3000);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

export async function runDesktopScript(script: string, port: number, action: 'Status' | 'Start' | 'Close'):
    Promise<string> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Port', String(port)];
  if (action === 'Close') args.push(await requestDesktopQuit(port) ? '-WaitForExit' : '-Close');
  else if (action !== 'Start') args.push('-' + action);
  try {
    const { stdout } = await execFileAsync('powershell.exe', args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: action === 'Start' ? 60000 : action === 'Close' ? 30000 : 10000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string; killed?: boolean };
    if (failure.killed) throw new Error(action === 'Close'
      ? '等待 Desktop 退出超时，请在应用中手动退出后重试。'
      : action === 'Start' ? '启动 Desktop 超时，请查看应用状态后重试。' : '检查 Desktop 状态超时，请重试。');
    const detail = (failure.stderr || failure.stdout || failure.message)
      .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    throw new Error(detail || 'Desktop 操作失败');
  }
}

export async function readDesktopStatus(script: string, port: number): Promise<DesktopStatus> {
  const output = await runDesktopScript(script, port, 'Status');
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' ||
      typeof (value as DesktopStatus).running !== 'boolean' ||
      typeof (value as DesktopStatus).cdpReady !== 'boolean') {
    throw new Error('Desktop 状态格式无效');
  }
  return value as DesktopStatus;
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (opened: boolean) => { socket.destroy(); resolve(opened); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function probeGateway(settings: LauncherSettings, token: string): Promise<GatewayProbe> {
  const origin = gatewayOrigin(settings);
  try {
    const response = await fetch(origin + '/api/health', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      signal: AbortSignal.timeout(1800),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' &&
          typeof (body as { connected?: unknown }).connected === 'boolean' &&
          typeof (body as { workspace?: unknown }).workspace === 'string' &&
          typeof (body as { approvalCount?: unknown }).approvalCount === 'number') {
        return { kind: 'codexdeck', connected: (body as { connected: boolean }).connected };
      }
    }
  } catch {
    // HTTP 不可用时仍需判断端口是否已被其他程序占用。
  }
  const url = new URL(origin);
  return await isPortOpen(url.hostname.replace(/^\[|\]$/g, ''), settings.gatewayPort)
    ? { kind: 'occupied' } : { kind: 'free' };
}

export async function checkGatewayBridge(settings: LauncherSettings, token: string): Promise<boolean> {
  try {
    const response = await fetch(gatewayOrigin(settings) + '/api/models', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
