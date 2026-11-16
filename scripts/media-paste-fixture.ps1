param([string]$TestDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$previous = [System.Windows.Forms.Clipboard]::GetDataObject()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI客服 0.2.30 受控媒体粘贴测试'
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$form.Controls.Add($box)
$box.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq 'V') {
    $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
    @{ count = $files.Count; paths = @($files); text = [System.Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $TestDir 'received.json')
    $_.SuppressKeyPress = $true
  }
})
$form.Add_Shown({
  $box.Focus()
  $form.Handle.ToInt64().ToString() | Set-Content (Join-Path $TestDir 'hwnd.txt')
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({ if (Test-Path (Join-Path $TestDir 'stop')) { $form.Close() } })
$timer.Start()
try { [System.Windows.Forms.Application]::Run($form) }
finally {
  $timer.Stop()
  if ($null -ne $previous) { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true) }
}
