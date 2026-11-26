const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

function loadServices({ mode = 'reply', cdp = true, bridge = true, scriptError = null } = {}) {
  const calls = { scripts: [], messages: [], sockets: [] };
  class Socket extends EventTarget {
    constructor(url) {
      super();
      calls.sockets.push(url);
      if (mode !== 'timeout') queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(value) {
      if (mode === 'send-error') throw new Error('连接已断开');
      const packet = JSON.parse(value);
      assert.equal(packet.method, 'Runtime.evaluate');
      assert.equal(packet.params.awaitPromise, true);
      const result = vm.runInNewContext(packet.params.expression, { window: bridge ? {
        electronBridge: { sendMessageFromView(message) {
          calls.messages.push(JSON.parse(JSON.stringify(message)));
          if (mode === 'rejected') return Promise.reject(new Error('退出请求被拒绝'));
        } },
      } : {} });
      if (mode === 'silent') return;
      queueMicrotask(async () => {
        if (mode === 'disconnect') this.dispatchEvent(new Event('close'));
        else {
          let response;
          try {
            const value = await result;
            response = mode === 'exception' ? { exceptionDetails: { text: '接口已变化' } } : { result: { value } };
          } catch (error) {
            response = { exceptionDetails: { text: error.message } };
          }
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: packet.id, result: response }) }));
        }
      });
    }
    close() {}
  }
  const exports = {};
  const nativeRequire = createRequire(path.join(__dirname, '../dist/services.js'));
  const execFile = () => {};
  execFile[promisify.custom] = async (_exe, args) => {
    calls.scripts.push(args);
    if (scriptError) throw scriptError;
    return { stdout: '已退出' };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/services.js'), 'utf8'), {
    exports,
    require(name) {
      if (name !== 'node:child_process') return nativeRequire(name);
      return { execFile };
    },
    fetch: async () => ({ ok: cdp, json: async () => [
      { type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://other-window' },
      { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://desktop-main' },
    ] }),
    WebSocket: Socket, AbortSignal,
    setTimeout: ['timeout', 'silent'].includes(mode) ? (callback) => { queueMicrotask(callback); return 1; } : setTimeout,
    clearTimeout,
  }, { filename: 'services.js' });
  return { run: () => exports.runDesktopScript('desktop.ps1', 49397, 'Close'), calls };
}

test('重启通过 Desktop 主页面正常退出，再等待进程结束', async () => {
  const { run, calls } = loadServices();
  assert.equal(await run(), '已退出');
  assert.deepEqual(calls.sockets, ['ws://desktop-main']);
  assert.deepEqual(calls.messages, [{ type: 'quit-app' }]);
  assert.equal(calls.scripts[0].at(-1), '-WaitForExit');
});

test('Desktop 在回复前正常断开 CDP，仍等待进程退出', async () => {
  const { run, calls } = loadServices({ mode: 'disconnect' });
  await run();
  assert.deepEqual(calls.messages, [{ type: 'quit-app' }]);
  assert.equal(calls.scripts[0].at(-1), '-WaitForExit');
});

test('CDP 或退出桥接不可用时通过 Windows 请求退出', async () => {
  for (const options of [{ cdp: false }, { bridge: false }]) {
    const { run, calls } = loadServices(options);
    await run();
    assert.equal(calls.messages.length, 0);
    assert.equal(calls.scripts[0].at(-1), '-Close');
  }
});

test('退出接口连接超时及执行异常时不继续重启', async () => {
  for (const [mode, message] of [
    ['timeout', /连接 Desktop 退出接口超时/], ['silent', /连接 Desktop 退出接口超时/],
    ['exception', /Desktop 正常退出请求失败/], ['rejected', /Desktop 正常退出请求失败/],
    ['send-error', /发送 Desktop 退出请求失败/],
  ]) {
    const { run, calls } = loadServices({ mode });
    await assert.rejects(run(), message);
    assert.equal(calls.scripts.length, 0);
  }
});

test('脚本退出等待超时提示可操作的中文原因', async () => {
  const error = Object.assign(new Error('Command failed: powershell.exe ...'), { killed: true });
  const { run } = loadServices({ scriptError: error });
  await assert.rejects(run(), /等待 Desktop 退出超时，请在应用中手动退出后重试/);
});

test('PowerShell 请求 Windows 正常退出并等待原进程', () => {
  const script = path.resolve(__dirname, '../../scripts/start-desktop-cdp.ps1').replaceAll("'", "''");
  // 提取生产脚本的关闭分支，进程替身不会接触正在使用的 Desktop。
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$null)
    $branch = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and
      $node.Extent.Text.StartsWith('if ($Close -or $WaitForExit)') }, $true)
    if (-not $branch) { throw '找不到关闭分支' }
    $code = [ScriptBlock]::Create($branch.Extent.Text)
    $global:closed = 0
    $global:waited = 0
    $global:queries = 0
    $global:exits = $true
    $global:acceptsQuit = $true
    $global:currentPath = 'desktop.exe'
    function Get-CodexMainProcesses {
      $global:queries++
      [pscustomobject]@{ ProcessId = 123; ExecutablePath = 'desktop.exe' }
    }
    function Request-CodexQuit($Process) {
      if ($Process.Id -ne 123) { throw '退出目标错误' }
      $global:closed++
      return $global:acceptsQuit
    }
    function Get-Process {
      param($Id, $ErrorAction)
      $process = [pscustomobject]@{ Id = $Id; HasExited = $false; Path = $global:currentPath }
      $process | Add-Member ScriptMethod WaitForExit {
        param($milliseconds)
        if ($milliseconds -lt 1 -or $milliseconds -gt 20000) { throw '等待时间无效' }
        $global:waited++
        return $global:exits
      }
      return $process
    }
    $Close = $false; $WaitForExit = $true
    & $code
    if ($global:closed -ne 0 -or $global:waited -ne 1 -or $global:queries -ne 1) { throw '等待退出路径错误' }
    $Close = $true; $WaitForExit = $false
    & $code
    if ($global:closed -ne 1 -or $global:waited -ne 2 -or $global:queries -ne 2) { throw '正常关闭路径错误' }
    $global:exits = $false
    try { & $code; throw '缺少超时错误' } catch {
      if ($_.Exception.Message -notlike '*未在 20 秒内退出*托盘*') { throw }
    }
    $global:acceptsQuit = $false
    try { & $code; throw '缺少退出请求错误' } catch {
      if ($_.Exception.Message -notlike '*无法向 Codex Desktop 发送退出命令*托盘*') { throw }
    }
    $global:currentPath = 'other.exe'
    & $code
    if ($global:closed -ne 3 -or $global:waited -ne 3) { throw '退出失败或进程已更换时不应继续等待' }
    Write-Output '进程等待验证通过'
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.match(output, /进程等待验证通过/);
});

test('Windows 退出辅助代码在没有匹配窗口时跳过按键', () => {
  const script = path.resolve(__dirname, '../../scripts/start-desktop-cdp.ps1').replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$null)
    $helper = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq 'Request-CodexQuit' }, $true)
    . ([ScriptBlock]::Create($helper.Extent.Text))
    function Invoke-CodexActivation { }
    if (Request-CodexQuit ([pscustomobject]@{ Id = 0; HasExited = $false })) {
      throw '不应向其他进程发送退出快捷键'
    }
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
});
