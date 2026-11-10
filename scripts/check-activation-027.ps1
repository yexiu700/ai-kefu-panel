$source = Get-Content -Raw -Encoding UTF8 electron/win32-daemon.ps1
Invoke-Expression $source.Substring(0, $source.IndexOf('while ($true)'))
$panels = New-Object System.Collections.Generic.List[object]
$cb = [HyWin+EnumProc]{ param([IntPtr]$h,[IntPtr]$l)
  if (-not [HyWin]::IsWindowVisible($h)) { return $true }; $w = Get-WinInfo $h
  if ($w -and $w.visible -and $w.title -like 'AI客服*') { $panels.Add($w) }
  return $true
}
[void][HyWin]::EnumWindows($cb,[IntPtr]::Zero)
Write-Output ('PANELS ' + ($panels | ConvertTo-Json -Compress))
if ($panels.Count -gt 0) {
  $panel = Activate-Hwnd ([IntPtr]([int64]$panels[0].hwnd))
  Write-Output ('PANEL_ACTIVATE ' + ($panel | ConvertTo-Json -Compress))
  $target = Activate-Hwnd ([IntPtr]602628)
  Write-Output ('JD_ACTIVATE ' + ($target | ConvertTo-Json -Compress))
  Add-Type -AssemblyName UIAutomationClient
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  Write-Output ('FOCUSED_CONTROL ' + $focused.Current.ControlType.ProgrammaticName + ' PID ' + $focused.Current.ProcessId)
}
Write-Output ('INVALID_ACTIVATE ' + ((Activate-Hwnd ([IntPtr]99999999)) | ConvertTo-Json -Compress))

