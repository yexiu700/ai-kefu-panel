# Parse and extract only the wait policy. Never start the daemon or touch windows/clipboard.
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot '../electron/win32-daemon.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$helper = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-PasteResult'
}, $true)
. ([scriptblock]::Create($helper.Extent.Text))
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$script:status = 'match'; $script:calls = 0; $script:matchAfter = 0
function Test-PastedText([IntPtr]$h, [string]$prefix) {
  $script:calls++
  if ($script:matchAfter -gt 0 -and $script:calls -lt $script:matchAfter) { return 'mismatch' }
  return $script:status
}
$r = Wait-PasteResult ([IntPtr]1) 'test' $false 80
Assert ($r.verify -eq 'match' -and $r.verifyWaitMs -lt 70) 'confirmed default text should return early'
$script:matchAfter = 3; $script:calls = 0
$r = Wait-PasteResult ([IntPtr]1) 'test' $false 300
Assert ($r.verify -eq 'match' -and $script:calls -ge 3) 'poll through transient mismatches'
$script:matchAfter = 0
foreach ($state in @('mismatch', 'unavailable', 'skipped')) {
  $script:status = $state
  $r = Wait-PasteResult ([IntPtr]1) 'test' $false 80
  Assert ($r.verify -eq $state -and $r.verifyWaitMs -ge 80 -and $r.verifyWaitMs -lt 180) "budget/state: $state"
}
$script:status = 'match'
$r = Wait-PasteResult ([IntPtr]1) 'test' $false 150
Assert ($r.verifyWaitMs -ge 150) 'explicit higher delay must be honored even on match'
$script:calls = 0
$r = Wait-PasteResult ([IntPtr]1) '' $true 80
Assert ($r.verifyWaitMs -ge 500 -and $r.verifyWaitMs -lt 800 -and $script:calls -eq 0) 'media floor without text verification'
$r = Wait-PasteResult ([IntPtr]1) '' $true 650
Assert ($r.verifyWaitMs -ge 650) 'higher media delay must be honored'
# Mock Win32 statics; extraction never loads the daemon's native interop class.
Add-Type @"
using System;
public class HyWin {
  public static IntPtr Foreground = (IntPtr)1;
  public static int AltEvents = 0;
  public static int TargetElevation = 0;
  public static bool CanActivate = true;
  public static IntPtr GetForegroundWindow() { return Foreground; }
  public static IntPtr GetAncestor(IntPtr h, uint flags) { return h; }
  public static bool IsChild(IntPtr parent, IntPtr child) { return false; }
  public static int Elevation(uint pid) { return pid == 42 ? TargetElevation : 0; }
  public static void keybd_event(byte k, byte s, uint f, UIntPtr e) { AltEvents++; }
  public static bool IsIconic(IntPtr h) { return false; }
  public static bool ShowWindow(IntPtr h, int n) { return true; }
  public static bool BringWindowToTop(IntPtr h) { return true; }
  public static bool SetForegroundWindow(IntPtr h) { if (CanActivate) Foreground = h; return CanActivate; }
}
"@
function Get-WinInfo([IntPtr]$h) { return @{pid=42;title='fixture';exe='fixture.exe';processName='fixture'} }
foreach ($name in @('Test-TargetForeground', 'Activate-Hwnd')) {
  $node = $ast.Find({ param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
  }, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$r = Activate-Hwnd ([IntPtr]1)
Assert ($r.ok -and $r.activateAttempts -eq 0 -and [HyWin]::AltEvents -eq 0) 'foreground fast path must not use ALT'
[HyWin]::TargetElevation = 1
$r = Activate-Hwnd ([IntPtr]1)
Assert (-not $r.ok -and $r.error -eq 'elevation-mismatch') 'fast path must retain elevation refusal'
[HyWin]::TargetElevation = 0; [HyWin]::Foreground = [IntPtr]2
$r = Activate-Hwnd ([IntPtr]1)
Assert ($r.ok -and $r.activateAttempts -eq 1 -and [HyWin]::AltEvents -eq 2) 'focus switch must use ALT and retry wait'
[HyWin]::CanActivate = $false; [HyWin]::Foreground = [IntPtr]2
$r = Activate-Hwnd ([IntPtr]1)
Assert (-not $r.ok -and $r.activateAttempts -eq 3 -and $r.error -eq 'Target activation failed') 'failed activation must retain retries/error'
Write-Output 'PASS: daemon parsing, early match, transient mismatch, fallback budgets, higher delays media floor, activation fast path, retries and elevation (isolated)'
