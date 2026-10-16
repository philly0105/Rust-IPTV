<#
.SYNOPSIS
  Real-window probe for Tsrust IPTV (iptv-tauri.exe): window style, mpv host/child windows,
  and synthetic clicks, double-clicks and drags on the embedded video.

.DESCRIPTION
  Actions (-Action):
    Info      (default) Read-only. Main window style, frame and fullscreen state, the mpv host
              window (class TsrustIptvMpvHost) with its children (mpv's own video window, from
              the mpv.exe process), window region (holes), what is under the host's centre, and
              mpv's pause state over its IPC pipe (read-only get_property).
    Click     One left click on the video. Expect: mpv.click -> pause toggles.
    DblClick  A double click on the video. Expect: pause back to what it was, fullscreen toggles
              (or PiP exits when in PiP).
    Drag      Press, move by -Dx/-Dy, release (PiP only). Expect: the main window moves by the
              same amount (clamped to the monitor's work area, docked to edges within 16 px).
              Always uses real input (-InputMode Real), because the host tracks the real cursor.
    Close     Posts WM_CLOSE to the main window (a normal quit, like Alt+F4). Use it to check
              that quitting in PiP or fullscreen reopens framed: run Close, relaunch the exe,
              then Info. It never kills the process.
    SelfTest  Offline. Checks how the mpv IPC pipe is picked (the newest session's
              tsrust-iptv-mpv-<pid>-<n>) against fake pipe lists. Needs no running app.

  Pause is read over mpv's IPC pipe. Click reports INFO (not verified) when it cannot read
  it; DblClick reports FAIL, because "pause kept" is part of what it checks.

  Input (-InputMode):
    Post  (default for Click/DblClick) PostMessage straight to the host window. Does not move
          the real cursor; works with the window in the background.
    Real  SendInput at the host's position (moves the real cursor; the window must be visible
          and not covered).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1                       # Info
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1 -ProcessId 1234 -Action Click
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1 -Action DblClick -InputMode Real
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1 -Action Drag -Dx -300 -Dy -200
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-probe.ps1 -Action Close

  Every action prints "RESULT: PASS|FAIL|INFO <detail>" as its last line; the exit code is 1 on
  FAIL, 2 when the app or the video window cannot be found, else 0.

  Suggested run against the release build with a stream playing:
    1. Info                    -> Framed=True, host present, mpv child present, Paused=False
    2. Click                   -> RESULT PASS (paused flips)
    3. Click                   -> back to playing
    4. DblClick                -> RESULT PASS (Fullscreen flips, Paused unchanged)
    5. DblClick                -> back to windowed
    6. (enter PiP in the UI) Drag -Dx -200 -Dy -150 -> RESULT PASS (window moved)
    7. Close while in PiP; relaunch; Info -> Framed=True, not topmost, normal size
    8. Same as 7 from fullscreen.
#>
[CmdletBinding()]
param(
  [int]$ProcessId = 0,
  [ValidateSet('Info', 'Click', 'DblClick', 'Drag', 'Close', 'SelfTest')]
  [string]$Action = 'Info',
  [ValidateSet('Post', 'Real')]
  [string]$InputMode = 'Post',
  [int]$Dx = -200,
  [int]$Dy = -150,
  # Point inside the host, as fractions of its client size (default: centre).
  [double]$FracX = 0.5,
  [double]$FracY = 0.5,
  # How long to wait for the app to react before reading the state again.
  [int]$SettleMs = 900
)

$ErrorActionPreference = 'Stop'

if (-not ('TsrWindowProbe.W' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace TsrWindowProbe {
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; public int pad1, pad2; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();

  public static List<IntPtr> TopLevel(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static void Mouse(uint flags) {
    var i = new INPUT[1]; i[0].type = 0; i[0].mi.dwFlags = flags;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
}
}
"@
}

# Read rects, cursor positions and monitors in physical pixels. On a display scaled above 100 %, a
# DPI-unaware PowerShell gets virtualized (scaled-down) coordinates, so sizes would not match what
# the app sees. At 96 DPI (100 %) this changes nothing.
# Per-monitor v2 (-4) for the process, else for this thread (the host may already have set the
# process mode), else the Vista-era system-aware call.
$PER_MONITOR_AWARE_V2 = [IntPtr](-4)
if (-not [TsrWindowProbe.W]::SetProcessDpiAwarenessContext($PER_MONITOR_AWARE_V2)) {
  if ([TsrWindowProbe.W]::SetThreadDpiAwarenessContext($PER_MONITOR_AWARE_V2) -eq [IntPtr]::Zero) {
    [void][TsrWindowProbe.W]::SetProcessDPIAware()
  }
}

$WM_CLOSE = 0x0010; $WM_LBUTTONDOWN = 0x0201; $WM_LBUTTONUP = 0x0202; $WM_LBUTTONDBLCLK = 0x0203
$MK_LBUTTON = 1; $MOUSEEVENTF_LEFTDOWN = 0x2; $MOUSEEVENTF_LEFTUP = 0x4
$WS_CAPTION = 0x00C00000; $WS_THICKFRAME = 0x00040000; $WS_POPUP = 0x80000000
$WS_DISABLED = 0x08000000; $WS_EX_TOPMOST = 0x8

function Fail-Missing([string]$what) { "RESULT: FAIL $what"; exit 2 }

function Get-App {
  if ($ProcessId -gt 0) { $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue }
  else {
    $all = @(Get-Process iptv-tauri -ErrorAction SilentlyContinue)
    if ($all.Count -gt 1) { "Several iptv-tauri processes: $($all.Id -join ', '). Pass -ProcessId."; exit 2 }
    $p = $all | Select-Object -First 1
  }
  if (-not $p) { Fail-Missing 'iptv-tauri.exe is not running' }
  return $p
}

function Rect-Of([IntPtr]$h) { $r = New-Object TsrWindowProbe.W+RECT; [void][TsrWindowProbe.W]::GetWindowRect($h, [ref]$r); $r }
function Fmt([object]$r) { "$($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)" }

function Get-Main([uint32]$appPid) {
  # The Tauri main window: visible top-level window titled like the app (tao class), else the largest.
  $wins = [TsrWindowProbe.W]::TopLevel($appPid) | Where-Object { [TsrWindowProbe.W]::IsWindowVisible($_) -or ([TsrWindowProbe.W]::Title($_) -like 'Tsrust IPTV*') }
  $main = $wins | Where-Object { [TsrWindowProbe.W]::Title($_) -like 'Tsrust IPTV*' } | Select-Object -First 1
  if (-not $main) { $main = $wins | Sort-Object { $r = Rect-Of $_; ($r.R - $r.L) * ($r.B - $r.T) } -Descending | Select-Object -First 1 }
  return $main
}

function Get-State([System.Diagnostics.Process]$app) {
  $main = Get-Main ([uint32]$app.Id)
  if (-not $main) { return $null }
  $style = [int64][TsrWindowProbe.W]::GetWindowLongPtr($main, -16) -band 0xFFFFFFFF
  $ex = [int64][TsrWindowProbe.W]::GetWindowLongPtr($main, -20) -band 0xFFFFFFFF
  $wr = Rect-Of $main
  $cr = New-Object TsrWindowProbe.W+RECT; [void][TsrWindowProbe.W]::GetClientRect($main, [ref]$cr)
  $origin = New-Object TsrWindowProbe.W+POINT; [void][TsrWindowProbe.W]::ClientToScreen($main, [ref]$origin)
  $mi = New-Object TsrWindowProbe.W+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][TsrWindowProbe.W+MONITORINFO])
  [void][TsrWindowProbe.W]::GetMonitorInfo([TsrWindowProbe.W]::MonitorFromWindow($main, 2), [ref]$mi)
  $m = $mi.rcMonitor
  $mpvHost = [TsrWindowProbe.W]::Children($main) | Where-Object { [TsrWindowProbe.W]::Cls($_) -eq 'TsrustIptvMpvHost' } | Select-Object -First 1
  [pscustomobject]@{
    Main       = $main
    Title      = [TsrWindowProbe.W]::Title($main)
    Class      = [TsrWindowProbe.W]::Cls($main)
    Style      = $style
    ExStyle    = $ex
    Rect       = $wr
    Client     = $cr
    # Title bar height: how far the client area starts below the window's top edge. tao keeps
    # WS_CAPTION on frameless windows and hides the frame in WM_NCCALCSIZE, so the style bit
    # alone does not tell framed from frameless.
    FrameTop   = $origin.Y - $wr.T
    Framed     = (($origin.Y - $wr.T) -ge 20)
    Topmost    = (($ex -band $WS_EX_TOPMOST) -ne 0)
    Maximized  = [TsrWindowProbe.W]::IsZoomed($main)
    Minimized  = [TsrWindowProbe.W]::IsIconic($main)
    Fullscreen = ($wr.L -le $m.L -and $wr.T -le $m.T -and $wr.R -ge $m.R -and $wr.B -ge $m.B -and -not [TsrWindowProbe.W]::IsZoomed($main))
    Monitor    = $m
    WorkArea   = $mi.rcWork
    Dpi        = [TsrWindowProbe.W]::GetDpiForWindow($main)
    MpvHost    = $mpvHost
  }
}

# Why the last Get-Paused returned $null (printed with INFO/FAIL results).
$script:PauseReason = ''

function Select-MpvPipe([string[]]$Names, [int]$AppPid) {
  # The core names each embedded session's pipe "tsrust-iptv-mpv-<pid>-<session>" (a fresh
  # name per session, see crates/iptv-core/src/player/embedded.rs). The newest session has the
  # highest number. The bare "tsrust-iptv-mpv-<pid>" is the older scheme, kept as a fallback.
  $prefix = "tsrust-iptv-mpv-$AppPid"
  $best = $null; $bestN = [int64]-1
  foreach ($n in $Names) {
    if ($n -match ('^' + [regex]::Escape($prefix) + '-(\d+)$')) {
      $num = [int64]$Matches[1]
      if ($num -gt $bestN) { $bestN = $num; $best = $n }
    }
  }
  if ($best) { return $best }
  if ($Names -contains $prefix) { return $prefix }
  return $null
}

function Get-PipeNames {
  try {
    [System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_ -replace '^\\\\\.\\pipe\\', '' }
  } catch { @() }
}

function Get-Paused([System.Diagnostics.Process]$app) {
  # Read-only: mpv's JSON IPC on the newest embedded session's pipe.
  $script:PauseReason = ''
  $name = Select-MpvPipe -Names @(Get-PipeNames) -AppPid $app.Id
  if (-not $name) { $script:PauseReason = "no pipe tsrust-iptv-mpv-$($app.Id)-<session> found (is mpv running?)"; return $null }
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(1500)
    $w = New-Object System.IO.StreamWriter($pipe); $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($pipe)
    $w.Write("{`"command`":[`"get_property`",`"pause`"],`"request_id`":4711}`n")
    $deadline = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $deadline) {
      $task = $r.ReadLineAsync()
      if (-not $task.Wait(1000)) { break }
      $line = $task.Result
      if ($line -and $line -match '"request_id":4711') {
        if ($line -match '"data":true') { return $true }
        if ($line -match '"data":false') { return $false }
        $script:PauseReason = "unexpected reply on $name`: $line"
        return $null
      }
    }
    $script:PauseReason = "no reply on $name within 2 s"
    return $null
  } catch { $script:PauseReason = "could not use $name`: $($_.Exception.Message)"; return $null } finally { $pipe.Dispose() }
}

function Invoke-SelfTest {
  # Offline checks of the pipe selection; no app, no pipes.
  $cases = @(
    @{ Names = @('tsrust-iptv-mpv-1234-1', 'tsrust-iptv-mpv-1234-3', 'tsrust-iptv-mpv-1234-2'); Pid = 1234; Want = 'tsrust-iptv-mpv-1234-3' },
    @{ Names = @('tsrust-iptv-mpv-1234-9', 'tsrust-iptv-mpv-1234-10'); Pid = 1234; Want = 'tsrust-iptv-mpv-1234-10' },
    @{ Names = @('tsrust-iptv-mpv-1234', 'other'); Pid = 1234; Want = 'tsrust-iptv-mpv-1234' },
    @{ Names = @('tsrust-iptv-mpv-1234', 'tsrust-iptv-mpv-1234-4'); Pid = 1234; Want = 'tsrust-iptv-mpv-1234-4' },
    @{ Names = @('tsrust-iptv-mpv-12345-7', 'tsrust-iptv-mpv-12345'); Pid = 1234; Want = $null },
    @{ Names = @('tsrust-iptv-mpv-1234-x', 'tsrust-iptv-mpv-1234-'); Pid = 1234; Want = $null },
    @{ Names = @(); Pid = 1234; Want = $null }
  )
  $failed = 0
  foreach ($c in $cases) {
    $got = Select-MpvPipe -Names $c.Names -AppPid $c.Pid
    $ok = if ($null -eq $c.Want) { $null -eq $got } else { $got -eq $c.Want }
    "{0} [{1}] pid {2} -> '{3}' (want '{4}')" -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), ($c.Names -join ', '), $c.Pid, $got, $c.Want
    if (-not $ok) { $failed++ }
  }
  # The real pipe listing must at least be readable.
  $listed = @(Get-PipeNames).Count
  "pipe listing : $listed pipes readable"
  if ($failed -eq 0) { 'RESULT: PASS self-test' } else { "RESULT: FAIL self-test ($failed case(s))"; exit 1 }
}

function Show-Info($s, [System.Diagnostics.Process]$app) {
  "App PID      : $($app.Id)  ($($app.Path))"
  "Main window  : 0x{0:X} class={1} title='{2}'" -f [int64]$s.Main, $s.Class, $s.Title
  "Style        : 0x{0:X8}  caption={1} thickframe={2} popup={3} | ex 0x{4:X8} topmost={5}" -f $s.Style, (($s.Style -band $WS_CAPTION) -eq $WS_CAPTION), (($s.Style -band $WS_THICKFRAME) -ne 0), (($s.Style -band $WS_POPUP) -ne 0), $s.ExStyle, $s.Topmost
  "Frame        : FrameTop=$($s.FrameTop)px Framed=$($s.Framed)"
  "State        : Maximized=$($s.Maximized) Minimized=$($s.Minimized) Fullscreen=$($s.Fullscreen) DPI=$($s.Dpi)"
  "Window rect  : $(Fmt $s.Rect)   client $($s.Client.R)x$($s.Client.B)"
  "Monitor      : $(Fmt $s.Monitor)   work $(Fmt $s.WorkArea)"
  foreach ($h in [TsrWindowProbe.W]::TopLevel([uint32]$app.Id)) {
    if ($h -eq $s.Main) { continue }
    if (-not [TsrWindowProbe.W]::IsWindowVisible($h)) { continue }
    "Other window : 0x{0:X} class={1} title='{2}' rect={3}" -f [int64]$h, [TsrWindowProbe.W]::Cls($h), [TsrWindowProbe.W]::Title($h), (Fmt (Rect-Of $h))
  }
  if (-not $s.MpvHost) { "mpv host     : none (nothing is playing in embedded mpv)"; return }
  $hs = [int64][TsrWindowProbe.W]::GetWindowLongPtr($s.MpvHost, -16) -band 0xFFFFFFFF
  "mpv host     : 0x{0:X} rect={1} style=0x{2:X8} visible={3}" -f [int64]$s.MpvHost, (Fmt (Rect-Of $s.MpvHost)), $hs, [TsrWindowProbe.W]::IsWindowVisible($s.MpvHost)
  $box = New-Object TsrWindowProbe.W+RECT
  $rgn = [TsrWindowProbe.W]::GetWindowRgnBox($s.MpvHost, [ref]$box)
  "  region     : " + $(if ($rgn -eq 0) { 'none (whole window)' } elseif ($rgn -eq 3) { "complex (holes cut), box $(Fmt $box)" } else { "simple, box $(Fmt $box)" })
  foreach ($c in [TsrWindowProbe.W]::Children($s.MpvHost)) {
    $cp = [TsrWindowProbe.W]::Pid($c)
    $pn = (Get-Process -Id $cp -ErrorAction SilentlyContinue).ProcessName
    $cs = [int64][TsrWindowProbe.W]::GetWindowLongPtr($c, -16) -band 0xFFFFFFFF
    "  child      : 0x{0:X} class={1} pid={2} ({3}) rect={4} enabled={5} disabled-style={6}" -f [int64]$c, [TsrWindowProbe.W]::Cls($c), $cp, $pn, (Fmt (Rect-Of $c)), [TsrWindowProbe.W]::IsWindowEnabled($c), (($cs -band $WS_DISABLED) -ne 0)
  }
  $hr = Rect-Of $s.MpvHost
  $p = New-Object TsrWindowProbe.W+POINT; $p.X = [int](($hr.L + $hr.R) / 2); $p.Y = [int](($hr.T + $hr.B) / 2)
  $under = [TsrWindowProbe.W]::WindowFromPoint($p)
  "  under ctr  : ({0},{1}) -> 0x{2:X} class={3} (expect TsrustIptvMpvHost: mpv's window is disabled so input reaches the host)" -f $p.X, $p.Y, [int64]$under, [TsrWindowProbe.W]::Cls($under)
  $paused = Get-Paused $app
  "mpv paused   : " + $(if ($null -eq $paused) { "unknown ($script:PauseReason)" } else { $paused })
}

function Host-Point($s) {
  $cr = New-Object TsrWindowProbe.W+RECT; [void][TsrWindowProbe.W]::GetClientRect($s.MpvHost, [ref]$cr)
  $x = [int]($cr.R * $FracX); $y = [int]($cr.B * $FracY)
  $sp = New-Object TsrWindowProbe.W+POINT; $sp.X = $x; $sp.Y = $y; [void][TsrWindowProbe.W]::ClientToScreen($s.MpvHost, [ref]$sp)
  [pscustomobject]@{ X = $x; Y = $y; ScreenX = $sp.X; ScreenY = $sp.Y; LParam = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF)) }
}

function Post-Click($s, [switch]$Double) {
  $pt = Host-Point $s
  [void][TsrWindowProbe.W]::PostMessage($s.MpvHost, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $pt.LParam)
  [void][TsrWindowProbe.W]::PostMessage($s.MpvHost, $WM_LBUTTONUP, [IntPtr]0, $pt.LParam)
  if ($Double) {
    Start-Sleep -Milliseconds 60
    [void][TsrWindowProbe.W]::PostMessage($s.MpvHost, $WM_LBUTTONDBLCLK, [IntPtr]$MK_LBUTTON, $pt.LParam)
    [void][TsrWindowProbe.W]::PostMessage($s.MpvHost, $WM_LBUTTONUP, [IntPtr]0, $pt.LParam)
  }
}

function Real-Click($s, [switch]$Double) {
  $pt = Host-Point $s
  [void][TsrWindowProbe.W]::SetCursorPos($pt.ScreenX, $pt.ScreenY)
  Start-Sleep -Milliseconds 80
  [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTDOWN); [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTUP)
  if ($Double) {
    Start-Sleep -Milliseconds ([Math]::Min(80, [int]([TsrWindowProbe.W]::GetDoubleClickTime() / 4)))
    [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTDOWN); [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTUP)
  }
}

if ($Action -eq 'SelfTest') { Invoke-SelfTest; exit 0 }

$app = Get-App
$s = Get-State $app
if (-not $s) { Fail-Missing 'no main window found for the process' }

switch ($Action) {
  'Info' {
    Show-Info $s $app
    "RESULT: INFO Framed=$($s.Framed) Fullscreen=$($s.Fullscreen) Topmost=$($s.Topmost) MpvHost=$([bool]$s.MpvHost)"
  }
  'Click' {
    if (-not $s.MpvHost) { Fail-Missing 'no mpv host window (start playback first)' }
    $before = Get-Paused $app
    $whyBefore = $script:PauseReason
    if ($InputMode -eq 'Real') { Real-Click $s } else { Post-Click $s }
    Start-Sleep -Milliseconds $SettleMs
    $after = Get-Paused $app
    "Paused: $before -> $after"
    if ($null -eq $before -or $null -eq $after) {
      "RESULT: INFO not verified: could not read pause over IPC ($(if ($null -eq $before) { "before: $whyBefore" } else { "after: $script:PauseReason" }))"
      break
    }
    if ($before -ne $after) { 'RESULT: PASS click toggled pause' } else { 'RESULT: FAIL pause did not change'; exit 1 }
  }
  'DblClick' {
    if (-not $s.MpvHost) { Fail-Missing 'no mpv host window (start playback first)' }
    $before = Get-Paused $app
    $whyBefore = $script:PauseReason
    $wasPip = (-not $s.Framed) -and (-not $s.Fullscreen)
    if ($InputMode -eq 'Real') { Real-Click $s -Double } else { Post-Click $s -Double }
    Start-Sleep -Milliseconds ($SettleMs + 600)
    $after = Get-Paused $app
    $s2 = Get-State $app
    "Paused: $before -> $after   Fullscreen: $($s.Fullscreen) -> $($s2.Fullscreen)   Framed: $($s.Framed) -> $($s2.Framed)   Rect: $(Fmt $s.Rect) -> $(Fmt $s2.Rect)"
    # "Pause kept" is half of the contract: an unreadable state is a failure, never a pass.
    if ($null -eq $before -or $null -eq $after) {
      "RESULT: FAIL could not read pause over IPC ($(if ($null -eq $before) { "before: $whyBefore" } else { "after: $script:PauseReason" }))"
      exit 1
    }
    $pauseOk = ($before -eq $after)
    $modeOk = if ($wasPip) { $s2.Framed } else { $s.Fullscreen -ne $s2.Fullscreen }
    if ($pauseOk -and $modeOk) { "RESULT: PASS double click $(if ($wasPip) { 'left PiP' } else { 'toggled fullscreen' }), pause kept" }
    else { "RESULT: FAIL pauseKept=$pauseOk modeChanged=$modeOk"; exit 1 }
  }
  'Drag' {
    if (-not $s.MpvHost) { Fail-Missing 'no mpv host window (start playback first)' }
    if ($s.Framed -or $s.Fullscreen) { 'RESULT: FAIL drag only moves the window in PiP (enter PiP first)'; exit 1 }
    $pt = Host-Point $s
    $before = $s.Rect
    [void][TsrWindowProbe.W]::SetCursorPos($pt.ScreenX, $pt.ScreenY)
    Start-Sleep -Milliseconds 80
    [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTDOWN)
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      Start-Sleep -Milliseconds 25
      [void][TsrWindowProbe.W]::SetCursorPos($pt.ScreenX + [int]($Dx * $i / $steps), $pt.ScreenY + [int]($Dy * $i / $steps))
    }
    Start-Sleep -Milliseconds 60
    [TsrWindowProbe.W]::Mouse($MOUSEEVENTF_LEFTUP)
    Start-Sleep -Milliseconds $SettleMs
    $after = Rect-Of $s.Main
    $mx = $after.L - $before.L; $my = $after.T - $before.T
    "Rect: $(Fmt $before) -> $(Fmt $after)   moved ($mx,$my) for a drag of ($Dx,$Dy)"
    $sizeKept = (($after.R - $after.L) -eq ($before.R - $before.L)) -and (($after.B - $after.T) -eq ($before.B - $before.T))
    $w = $s.WorkArea
    $inside = $after.L -ge $w.L -and $after.T -ge $w.T -and $after.R -le $w.R -and $after.B -le $w.B
    if (($mx -ne 0 -or $my -ne 0) -and $sizeKept -and $inside) { 'RESULT: PASS PiP window followed the drag, same size, fully on the work area' }
    else { "RESULT: FAIL moved=($mx,$my) sizeKept=$sizeKept onWorkArea=$inside"; exit 1 }
  }
  'Close' {
    "Posting WM_CLOSE to 0x{0:X} (Framed=$($s.Framed) Fullscreen=$($s.Fullscreen))" -f [int64]$s.Main
    [void][TsrWindowProbe.W]::PostMessage($s.Main, $WM_CLOSE, [IntPtr]0, [IntPtr]0)
    $gone = $app.WaitForExit(8000)
    if ($gone) { 'RESULT: INFO app quit; relaunch it and run Info (expect Framed=True, Topmost=False, Fullscreen=False)' }
    else { 'RESULT: FAIL app did not quit within 8 s'; exit 1 }
  }
}
