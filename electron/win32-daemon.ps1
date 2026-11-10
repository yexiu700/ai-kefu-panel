# Long-lived Win32 helper for AI客服壳. One line of JSON in → one line of JSON out.
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HyWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  // Unknown failures remain unknown; access denied is evidence of an elevated target.
  public static int Elevation(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 5 ? 1 : -1;
    try {
      if (!OpenProcessToken(process, 8, out token)) return Marshal.GetLastWin32Error() == 5 ? 1 : -1;
      int value, length;
      return GetTokenInformation(token, 20, out value, 4, out length) ? value : -1;
    } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
  }
  public static uint GetThreadId(IntPtr hWnd) {
    uint pid = 0;
    return GetWindowThreadProcessId(hWnd, out pid);
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Get-ProcName([uint32]$procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -ne $p) { return $p.ProcessName }
  } catch {}
  return ''
}

function Get-WinInfo([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or -not [HyWin]::IsWindow($h)) { return $null }
  $len = [HyWin]::GetWindowTextLength($h)
  $title = ''
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][HyWin]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
  }
  $r = New-Object HyWin+RECT
  $okRect = [HyWin]::GetWindowRect($h, [ref]$r)
  $w = 0; $hgt = 0
  if ($okRect) { $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top }
  $procId = [uint32]0
  [void][HyWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $proc = Get-ProcName $procId
  $exe = if ($proc) { "$proc.exe" } else { '' }
  return [pscustomobject]@{
    hwnd = $h.ToInt64()
    title = $title
    exe = $exe
    processName = $proc
    pid = $procId
    left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom
    width = $w; height = $hgt
    visible = [HyWin]::IsWindowVisible($h)
    iconic = [HyWin]::IsIconic($h)
  }
}

function List-OpenApps {
  $list = New-Object System.Collections.Generic.List[object]
  $cb = [HyWin+EnumProc]{
    param([IntPtr]$h, [IntPtr]$l)
    if (-not [HyWin]::IsWindowVisible($h)) { return $true }
    $info = Get-WinInfo $h
    if ($null -eq $info) { return $true }
    if ([string]::IsNullOrWhiteSpace($info.title)) { return $true }
    if ($info.width -lt 80 -or $info.height -lt 80) { return $true }
    # skip tool windows without title already handled; skip our own panels by title
    if ($info.title -like 'AI客服*' -or $info.title -like '阿卓帕*' -or $info.title -like '回柚*') { return $true }
    if ($info.exe -match '^(?i)(quick-reply|electron)\.exe$') { return $true }
    $list.Add([pscustomobject]@{
      hwnd = $info.hwnd
      title = $info.title
      exe = $info.exe
    }) | Out-Null
    return $true
  }
  [void][HyWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Activate-Hwnd([IntPtr]$h) {
  $info = Get-WinInfo $h
  $selfElevation = [HyWin]::Elevation([uint32]$PID)
  $targetElevation = if ($info) { [HyWin]::Elevation([uint32]$info.pid) } else { -1 }
  $r = @{ ok = $false; hwnd = $h.ToInt64(); targetTitle = $info.title; exe = $info.exe; processName = $info.processName;
    fgBefore = [HyWin]::GetForegroundWindow().ToInt64(); fgAfter = 0; isWindow = ($null -ne $info);
    elevatedSelf = $(if ($selfElevation -lt 0) { $null } else { $selfElevation -eq 1 });
    elevatedTarget = $(if ($targetElevation -lt 0) { $null } else { $targetElevation -eq 1 }); activateAttempts = 0; rebound = $false }
  if ($info) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $r.activateAttempts = $attempt
      # Release the foreground lock before requesting focus. Always release ALT.
      [HyWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [HyWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      if ([HyWin]::IsIconic($h)) { [void][HyWin]::ShowWindow($h, 9) }
      [void][HyWin]::BringWindowToTop($h)
      [void][HyWin]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 60
      $fg = [HyWin]::GetForegroundWindow()
      if ($fg -eq $h -or ($fg -ne [IntPtr]::Zero -and ([HyWin]::GetAncestor($h, 3) -eq $fg -or [HyWin]::IsChild($h, $fg)))) {
        $r.ok = $true
        break
      }
    }
  }
  $r.fgAfter = [HyWin]::GetForegroundWindow().ToInt64()
  if ($targetElevation -eq 1 -and $selfElevation -eq 0) { $r.ok = $false; $r.error = 'elevation-mismatch' }
  elseif (-not $r.ok) { $r.error = 'Target activation failed' }
  return $r
}

# Only inspect the focused control belonging to the target process; never log its content.
function Test-PastedText([IntPtr]$h, [string]$prefix) {
  if ([string]::IsNullOrWhiteSpace($prefix)) { return 'skipped' }
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el -or $el.Current.IsPassword) { return 'unavailable' }
    $procId = [uint32]0
    [void][HyWin]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($el.Current.ProcessId -ne $procId) { return 'unavailable' }
    $pattern = $null
    $value = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = $pattern.Current.Value
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $value = $pattern.DocumentRange.GetText(-1)
    }
    if ($null -eq $value) { return 'unavailable' }
    if ($value.Contains($prefix)) { return 'match' }
    return 'mismatch'
  } catch { return 'unavailable' }
}

# Focus only a uniquely identified editable control. Never guess screen coordinates.
function Focus-MediaInput([IntPtr]$h) {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -and $focused.Current.ProcessId -eq $root.Current.ProcessId -and $focused.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and -not $focused.Current.IsPassword -and $focused.Current.Name -notmatch '搜索|查找|search|find') { return $true }
    $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $candidates = @($edits | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and -not $_.Current.IsPassword -and $_.Current.IsKeyboardFocusable -and $_.Current.Name -match '消息|输入|回复|message|input|reply' -and $_.Current.Name -notmatch '搜索|查找|search|find' })
    if ($candidates.Count -ne 1) { return $false }
    $candidates[0].SetFocus()
    return $candidates[0].Equals([System.Windows.Automation.AutomationElement]::FocusedElement)
  } catch { return $false }
}

function Send-KeysTo([IntPtr]$h, $mode, $key, $delayMs, [string]$prefix, [string]$previousExe, [bool]$media = $false, [bool]$focusInput = $false, [uint32]$clipboardSequence = 0) {
  $rebound = $false
  if (-not [HyWin]::IsWindow($h)) {
    $apps = @(List-OpenApps)
    $candidate = $apps | Where-Object { $previousExe -and $_.exe -ieq $previousExe } | Select-Object -First 1
    if (-not $candidate) { $candidate = $apps | Where-Object { $_.title -like '*咚咚工作台*' -or $_.exe -match '^(jdm_dd_workbench|pop_dd_workbench|jm_dd_workbench)\.exe$' } | Select-Object -First 1 }
    if ($candidate) { $h = [IntPtr]([int64]$candidate.hwnd); $rebound = $true }
  }
  $r = Activate-Hwnd $h
  $r.rebound = $rebound
  $r.sendKeysOk = $false; $r.verify = 'skipped'; $r.method = 'sendkeys'
  if (-not $r.ok) { return $r }
  try {
  Start-Sleep -Milliseconds ([Math]::Max(40, [int]$delayMs))
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  if (($media -or $focusInput) -and $r.exe -match '^(?i)(jdm_dd_workbench|pop_dd_workbench|jm_dd_workbench)\.exe$' -and -not (Focus-MediaInput $h)) {
    $r.ok = $false; $r.error = 'input-focus-unavailable'; $r.message = '无法确认京东工作台输入框焦点，请先点击聊天输入框再重试，或手动粘贴剪贴板中的媒体'; return $r
  }
  $fg = [HyWin]::GetForegroundWindow()
  if ($fg -ne $h -and -not [HyWin]::IsChild($h, $fg) -and [HyWin]::GetAncestor($h, 3) -ne $fg) {
    $r.ok = $false; $r.error = 'foreground-changed'; $r.message = '前台窗口发生变化，已停止粘贴，请重新选择聊天窗'; return $r
  }
  if ($media -and $clipboardSequence -ne 0 -and [HyWin]::GetClipboardSequenceNumber() -ne $clipboardSequence) {
    $r.ok = $false; $r.error = 'clipboard-changed'; $r.message = '剪贴板已被其他程序更改，已停止粘贴，请重试'; return $r
  }
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  # Verify before Enter can clear the input and before JS can restore the clipboard.
  Start-Sleep -Milliseconds ([Math]::Max($(if ($media) { 1500 } else { 200 }), [int]$delayMs))
  $verify = if ($media) { 'unavailable' } else { Test-PastedText $h $prefix }
  if ($verify -eq 'mismatch') {
    $r.ok = $false; $r.sendKeysOk = $true; $r.verify = $verify; $r.error = 'Paste verification mismatch'; return $r
  }
  if ($mode -eq 'send') {
    $fg = [HyWin]::GetForegroundWindow()
    if ($fg -ne $h -and -not [HyWin]::IsChild($h, $fg) -and [HyWin]::GetAncestor($h, 3) -ne $fg) {
      $r.ok = $false; $r.sendKeysOk = $true; $r.verify = $verify; $r.error = 'foreground-changed'; $r.message = '粘贴后前台窗口发生变化，已停止按发送键，请核对目标输入框'; return $r
    }
    switch ($key) {
      'ctrl_enter' { [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}') }
      'alt_s' { [System.Windows.Forms.SendKeys]::SendWait('%s') }
      default { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
    }
  }
  $r.sendKeysOk = $true; $r.verify = $verify; return $r
  } catch { $r.ok = $false; $r.error = $_.Exception.Message; return $r }
}


function Get-ExePathFromHwnd([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or -not [HyWin]::IsWindow($h)) { return $null }
  $procId = [uint32]0
  [void][HyWin]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($procId -eq 0) { return $null }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    if ($p.Path) { return $p.Path }
  } catch {}
  try {
    $wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.ExecutablePath) { return $wmi.ExecutablePath }
  } catch {}
  return $null
}

function Get-AppIconPngBase64([IntPtr]$h) {
  $exe = Get-ExePathFromHwnd $h
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
    if ($null -eq $icon) { return $null }
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
    return [Convert]::ToBase64String($bytes)
  } catch {
    return $null
  }
}

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $op = [string]$req.op
    switch ($op) {
      'ping' { Write-Result @{ ok = $true; op = 'ping' } }
      'clipboard-files' {
        try {
          Add-Type -AssemblyName System.Windows.Forms
          $files = New-Object System.Collections.Specialized.StringCollection
          foreach ($file in $req.paths) {
            if (-not [System.IO.File]::Exists([string]$file)) { throw '文件不存在或无权访问，请重新添加媒体' }
            [void]$files.Add([string]$file)
          }
          if ($files.Count -eq 0) { throw '没有可复制的媒体文件' }
          $data = New-Object System.Windows.Forms.DataObject
          $data.SetFileDropList($files)
          # Persistent CF_HDROP data survives the helper and needs no temporary copies.
          [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
          $actual = [System.Windows.Forms.Clipboard]::GetFileDropList()
          if ($actual.Count -ne $files.Count) { throw '文件剪贴板写入校验失败，请重试' }
          Write-Result @{ ok = $true; count = $actual.Count; format = 'CF_HDROP'; clipboardSequence = [HyWin]::GetClipboardSequenceNumber() }
        } catch { Write-Result @{ ok = $false; message = '无法复制媒体文件，请检查文件是否存在、访问权限和剪贴板占用'; error = 'file-clipboard-failed' } }
      }
      'list' {
        $apps = @(List-OpenApps)
        Write-Result @{ ok = $true; apps = $apps }
      }
      'fg' {
        $h = [HyWin]::GetForegroundWindow()
        Write-Result @{ ok = $true; window = (Get-WinInfo $h) }
      }
      'rect' {
        $h = [IntPtr]([int64]$req.hwnd)
        Write-Result @{ ok = $true; window = (Get-WinInfo $h) }
      }
      'activate' {
        $h = [IntPtr]([int64]$req.hwnd)
        Write-Result (Activate-Hwnd $h)
      }
      'send' {
        $h = [IntPtr]([int64]($req.hwnd))
        $mode = if ($req.mode) { [string]$req.mode } else { 'send' }
        $key = if ($req.key) { [string]$req.key } else { 'enter' }
        $delay = if ($null -ne $req.delayMs) { [int]$req.delayMs } else { 80 }
        Write-Result (Send-KeysTo $h $mode $key $delay ([string]$req.prefix) ([string]$req.exe) ([bool]$req.media) ([bool]$req.focusInput) ([uint32]$req.clipboardSequence))
      }
      'icon' {
        $h = [IntPtr]([int64]$req.hwnd)
        $b64 = Get-AppIconPngBase64 $h
        if ($null -eq $b64) { Write-Result @{ ok = $true; pngBase64 = $null } }
        else { Write-Result @{ ok = $true; pngBase64 = $b64 } }
      }
      'quit' { Write-Result @{ ok = $true }; break }
      default { Write-Result @{ ok = $false; error = "unknown op: $op" } }
    }
  } catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
  }
}
