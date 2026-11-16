$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'import-feishu-config.ps1'
$testDir = Join-Path $env:TEMP ('ai-kefu-feishu-test-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $testDir 'nested\feishu.env'
$source = Join-Path $testDir 'source.env'
$secret1 = 'test-secret-one#123'
$secret2 = 'test-secret-two=456'
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-Import([string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @Arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $text = $result -join "`n"
    Assert (-not $text.Contains($secret1) -and -not $text.Contains($secret2)) '输出泄露了测试密钥'
    return @{ Code = $code; Text = $text }
}
try {
    $result = Invoke-Import @('-AppId', 'test-id', '-AppSecret', $secret1, '-TargetPath', $target)
    Assert ($result.Code -eq 0) '参数导入失败'
    $content = [IO.File]::ReadAllText($target)
    Assert ($content.Contains('AIKEFU_FEISHU_APP_SECRET=' + $secret1)) '密钥未保存'
    [IO.File]::AppendAllText($target, "# 保留注释`r`nOTHER_KEY=keep-me`r`nHUIYOU_FEISHU_APP_ID=old-id`r`nHUIYOU_FEISHU_APP_SECRET=old-secret`r`nAIKEFU_FEISHU_OVERSEAS_TABLE_ID=keep-overseas`r`n")
    [IO.File]::WriteAllText($source, "export HUIYOU_FEISHU_APP_ID='file-id'`r`nAIKEFU_FEISHU_APP_SECRET=`"$secret2`"`r`nAIKEFU_FEISHU_DOMESTIC_BASE_TOKEN=domestic-test`r`nHUIYOU_FEISHU_BASE_TOKEN=must-not-import`r`n")
    $result = Invoke-Import @('-EnvFile', $source, '-TargetPath', $target)
    Assert ($result.Code -eq 0) '文件导入失败'
    $content = [IO.File]::ReadAllText($target)
    foreach ($expected in @('# 保留注释', 'OTHER_KEY=keep-me', 'HUIYOU_FEISHU_APP_ID=file-id', 'AIKEFU_FEISHU_APP_ID=file-id', ('HUIYOU_FEISHU_APP_SECRET=' + $secret2), 'AIKEFU_FEISHU_DOMESTIC_BASE_TOKEN=domestic-test', 'AIKEFU_FEISHU_OVERSEAS_TABLE_ID=keep-overseas')) {
        Assert ($content.Contains($expected)) '增量更新或旧别名同步不正确'
    }
    Assert (-not $content.Contains('must-not-import')) '错误导入了未分地区配置'
    $before = $content
    $result = Invoke-Import @('-AppId', 'id', '-AppSecret', "bad`nsecret", '-TargetPath', $target)
    Assert ($result.Code -ne 0) '未拒绝换行注入'
    Assert ([IO.File]::ReadAllText($target) -eq $before) '失败时改写了配置'
    $result = Invoke-Import @('-EnvFile', (Join-Path $testDir 'missing.env'), '-TargetPath', $target)
    Assert ($result.Code -ne 0) '缺失源文件未报错'
    $result = Invoke-Import @('-EnvFile', $source, '-AppId', 'override-id', '-DomesticTableId', 'table-test', '-TargetPath', $target)
    Assert ($result.Code -eq 0) '显式参数覆盖文件失败'
    $content = [IO.File]::ReadAllText($target)
    Assert ($content.Contains('AIKEFU_FEISHU_APP_ID=override-id') -and $content.Contains('AIKEFU_FEISHU_DOMESTIC_TABLE_ID=table-test')) '参数覆盖值不正确'
    Write-Host '通过：参数导入、文件导入、目录创建、保留现有配置、同步旧别名、区域隔离、参数覆盖、失败不改写与输出脱敏。'
} finally {
    # 保留隔离测试目录，不批量删除文件。
}
