param(
    [int]$Port = 49397,
    [switch]$ProbeOnly,
    [switch]$Status,
    [switch]$Close,
    [switch]$WaitForExit
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if ($Port -lt 1 -or $Port -gt 65535) { throw 'CDP 端口无效。' }
if (@(@($ProbeOnly, $Status, $Close, $WaitForExit) | Where-Object { $_ }).Count -gt 1) {
    throw '只能指定一种操作。'
}

function Test-CodexCdp {
    try {
        $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
        return [bool](@($pages | Where-Object { $_.url -eq 'app://-/index.html' }).Count)
    } catch {
        return $false
    }
}

function Get-CodexMainProcesses {
    $sessionId = (Get-Process -Id $PID).SessionId
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' AND SessionId = $sessionId" | Where-Object {
        $_.ExecutablePath -like 'C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -and
        $_.CommandLine -notmatch '--type='
    })
}

function Invoke-CodexActivation([string]$Arguments = '') {
    if (-not ('CodexPackageActivation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager { }
public static class CodexPackageActivation {
    public static uint Activate(string appUserModelId, string arguments) {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId;
        int hr = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
        Marshal.ThrowExceptionForHR(hr);
        return processId;
    }
}
'@
    }
    return [CodexPackageActivation]::Activate('OpenAI.Codex_2p2nqsd0c76g0!App', $Arguments)
}

function Request-CodexQuit($Process) {
    # Windows 会把关闭的主窗口藏到托盘。用应用自己的 Ctrl+Q 退出命令，保留退出确认和清理流程。
    if (-not ('CodexWindowsQuit' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CodexWindowsQuit {
    private const ushort Control = 0x11, Q = 0x51;
    private const uint KeyUp = 0x0002;
    private static readonly int[] ShortcutKeys = { 0x10, Control, 0x12, 0x5B, 0x5C, Q };

    private delegate bool WindowVisitor(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visit, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)] private struct Input {
        public uint Type;
        public InputData Data;
    }
    [StructLayout(LayoutKind.Explicit)] private struct InputData {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        // INPUT 的联合体大小由 MOUSEINPUT 决定，64 位和 32 位布局都需要保留。
        [FieldOffset(0)] public MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput {
        public ushort Key, ScanCode;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    private static bool IsDesktopWindow(IntPtr window, uint processId) {
        uint owner;
        const uint GetOwner = 4;
        if (GetWindowThreadProcessId(window, out owner) == 0 || owner != processId || !IsWindowVisible(window) || IsIconic(window) ||
            GetWindow(window, GetOwner) != IntPtr.Zero || !IsWindowEnabled(window) || GetWindowTextLength(window) == 0) return false;
        var name = new StringBuilder(32);
        GetClassName(window, name, name.Capacity);
        return name.ToString() == "Chrome_WidgetWin_1";
    }

    private static Input Key(ushort key, uint flags) {
        return new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Key = key, Flags = flags } } };
    }

    private static IntPtr FindDesktopWindow(uint processId) {
        IntPtr foreground = GetForegroundWindow();
        if (IsDesktopWindow(foreground, processId)) return foreground;
        IntPtr window = IntPtr.Zero;
        EnumWindows((candidate, data) => {
            if (!IsDesktopWindow(candidate, processId)) return true;
            window = candidate;
            return false;
        }, IntPtr.Zero);
        return window;
    }

    public static bool HasWindow(uint processId) {
        return FindDesktopWindow(processId) != IntPtr.Zero;
    }

    public static bool TryQuit(uint processId) {
        var wait = Stopwatch.StartNew();
        IntPtr focusRequested = IntPtr.Zero;
        IntPtr focusedWindow = IntPtr.Zero;
        long focusedSince = -1;
        while (wait.ElapsedMilliseconds < 3000) {
            IntPtr window = FindDesktopWindow(processId);
            if (window != IntPtr.Zero && GetForegroundWindow() != window && focusRequested != window) {
                SetForegroundWindow(window);
                focusRequested = window;
            }
            // SendInput 会发给前台窗口。发送前再次检查窗口与进程，并避开用户正按住的修改键。
            if (window != IntPtr.Zero && GetForegroundWindow() == window) {
                // 窗口激活后留出时间，让 Electron 将焦点交给页面并接收菜单快捷键。
                if (focusedWindow != window) {
                    focusedWindow = window;
                    focusedSince = wait.ElapsedMilliseconds;
                }
                if (wait.ElapsedMilliseconds - focusedSince >= 100 &&
                    !Array.Exists(ShortcutKeys, key => GetAsyncKeyState(key) < 0)) {
                    var inputs = new[] { Key(Control, 0), Key(Q, 0), Key(Q, KeyUp), Key(Control, KeyUp) };
                    if (GetForegroundWindow() != window || !IsDesktopWindow(window, processId)) return false;
                    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
                }
            } else {
                focusedWindow = IntPtr.Zero;
            }
            Thread.Sleep(25);
        }
        return false;
    }
}
'@
    }
    if ($Process.HasExited) { return $true }
    if (-not [CodexWindowsQuit]::HasWindow($Process.Id)) {
        # 通过 Desktop 自己的激活入口恢复托盘或最小化窗口，使 Electron 同步页面焦点。
        if ($Process.HasExited) { return $true }
        try { $null = Invoke-CodexActivation } catch { return $false }
    }
    return [CodexWindowsQuit]::TryQuit($Process.Id)
}

if ($Close -or $WaitForExit) {
    $running = @(Get-CodexMainProcesses)
    $processes = @()
    foreach ($item in $running) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if (-not $process -or $process.Path -ne $item.ExecutablePath) { continue }
        $processes += $process
        if ($Close -and -not (Request-CodexQuit $process) -and -not $process.HasExited) {
            throw '无法向 Codex Desktop 发送退出命令。请右键 Codex Desktop 托盘图标选择「退出」，然后重试。'
        }
    }
    # 只等待已确认的原进程，避免反复查询 CIM 把 20 秒等待拖到启动器超时。
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    foreach ($process in $processes) {
        $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $process.WaitForExit($remaining)) {
            throw 'Codex Desktop 未在 20 秒内退出。请检查是否有退出确认，或从 Codex Desktop 托盘菜单选择「退出」后重试。'
        }
    }
    return
}

$cdpReady = Test-CodexCdp
if ($Status) {
    $running = @(Get-CodexMainProcesses)
    @{ running = ($running.Count -gt 0 -or $cdpReady); cdpReady = $cdpReady; mainProcessCount = $running.Count } |
        ConvertTo-Json -Compress
    return
}

if ($cdpReady) {
    Write-Output "Codex Desktop 的 CDP 已在本机端口 $Port 可用。"
    return
}
if ($ProbeOnly) { throw "本机端口 $Port 未找到 Codex Desktop 页面。" }

$running = @(Get-CodexMainProcesses)
if ($running.Count -gt 0) {
    throw 'Codex Desktop 已运行但未启用 CDP。请先在桌面里保存工作并手动退出，再重试此脚本。'
}

$arguments = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
$null = Invoke-CodexActivation $arguments
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-CodexCdp) {
        Write-Output "Codex Desktop 已启动，CDP 在本机端口 $Port 可用。"
        return
    }
}
throw 'Codex Desktop 已收到启动请求，但 CDP 页面未在 45 秒内就绪。'
