<#
.SYNOPSIS
导入 AI客服 的飞书同步配置，不显示密钥。
.DESCRIPTION
不带参数时提示输入 App ID 和 App Secret；可用 -EnvFile 导入已有配置文件。
已有配置中的其他键和注释会保留。只有明确提供的分地区配置才会更新。
.EXAMPLE
.\scripts\import-feishu-config.ps1
.EXAMPLE
.\scripts\import-feishu-config.ps1 -EnvFile C:\安全目录\feishu.env
#>
[CmdletBinding()]
param(
    [string]$AppId,
    [string]$AppSecret,
    [string]$EnvFile,
    [string]$DomesticBaseToken,
    [string]$DomesticTableId,
    [string]$OverseasBaseToken,
    [string]$OverseasTableId,
    [string]$TargetPath = (Join-Path $env:USERPROFILE '.config\ai-kefu-panel\feishu.env')
)
$ErrorActionPreference = 'Stop'

# 写入当前别名，同时同步已经存在的旧别名，避免旧别名优先级更高而遮蔽新值。
$prefixes = @('AIKEFU_FEISHU_', 'HUIYOU_FEISHU_')
$names = @('APP_ID', 'APP_SECRET', 'DOMESTIC_BASE_TOKEN', 'DOMESTIC_TABLE_ID', 'OVERSEAS_BASE_TOKEN', 'OVERSEAS_TABLE_ID')
$values = @{}

function Assert-ConfigValue([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOfAny([char[]]"`r`n`0") -ge 0) {
        throw "$Label 不能为空，且不能包含换行或空字符。"
    }
    # 与应用的 env 读取规则一致，不能把包围值的引号当作值的一部分保存。
    if ($Value -match '^([''"'']).*\1$') { throw "$Label 不能以成对引号包围；请直接输入值。" }
}

try {
    if ($EnvFile) {
        if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw '导入文件不存在。' }
        $source = @{}
        foreach ($line in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $EnvFile).Path)) {
            if ($line -match '^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$') {
                $key = $Matches[1]
                $value = $Matches[2]
                if ($value -match '^([''"''])(.*)\1$') { $value = $Matches[2] }
                $source[$key] = $value
            }
        }
        foreach ($name in $names) {
            # 与应用一致：旧别名优先；绝不导入不分地区的旧 Base/Table 配置。
            foreach ($prefix in @($prefixes[1], $prefixes[0])) {
                if ($source.ContainsKey($prefix + $name)) { $values[$name] = $source[$prefix + $name]; break }
            }
        }
    }
    $parameters = @{
        APP_ID = 'AppId'; APP_SECRET = 'AppSecret'
        DOMESTIC_BASE_TOKEN = 'DomesticBaseToken'; DOMESTIC_TABLE_ID = 'DomesticTableId'
        OVERSEAS_BASE_TOKEN = 'OverseasBaseToken'; OVERSEAS_TABLE_ID = 'OverseasTableId'
    }
    foreach ($name in $names) {
        $parameter = $parameters[$name]
        if ($PSBoundParameters.ContainsKey($parameter)) { $values[$name] = Get-Variable -Name $parameter -ValueOnly }
    }
    if (-not $values.ContainsKey('APP_ID')) { $values['APP_ID'] = Read-Host '请输入飞书 App ID' }
    if (-not $values.ContainsKey('APP_SECRET')) {
        $secure = Read-Host '请输入飞书 App Secret（输入隐藏）' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $values['APP_SECRET'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    }
    foreach ($name in $names) {
        if ($values.ContainsKey($name)) { Assert-ConfigValue $values[$name] $parameters[$name] }
    }

    $fullPath = [IO.Path]::GetFullPath($TargetPath)
    $lines = if (Test-Path -LiteralPath $fullPath -PathType Leaf) { [IO.File]::ReadAllLines($fullPath) } else { @() }
    $output = [Collections.Generic.List[string]]::new()
    $written = @{}
    foreach ($line in $lines) {
        $replace = $false
        if ($line -match '^\s*(?:export\s+)?([A-Z_]+)\s*=') {
            $key = $Matches[1]
            foreach ($name in $names) {
                if ($values.ContainsKey($name) -and $prefixes.Where({ $key -eq ($_ + $name) }).Count -gt 0) {
                    $output.Add($key + '=' + $values[$name])
                    $written[$key] = $true
                    $replace = $true
                    break
                }
            }
        }
        if (-not $replace) { $output.Add($line) }
    }
    foreach ($name in $names) {
        $key = $prefixes[0] + $name
        if ($values.ContainsKey($name) -and -not $written.ContainsKey($key)) { $output.Add($key + '=' + $values[$name]) }
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fullPath)) | Out-Null
    $temporaryPath = $fullPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllLines($temporaryPath, $output, [Text.UTF8Encoding]::new($false))
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($fullPath)) { [IO.File]::Replace($temporaryPath, $fullPath, ($fullPath + '.' + [Guid]::NewGuid().ToString('N') + '.bak')) }
    else { [IO.File]::Move($temporaryPath, $fullPath) }
    Write-Host '飞书配置已导入。App ID 已更新；App Secret：********。请重启 AI客服 后同步。'
} catch {
    # 不回显原异常或源文件内容，避免路径/解析异常带出密钥。
    Write-Error '导入失败：请检查文件是否存在、目录是否可写，以及必填配置是否为空或包含换行。' -ErrorAction Continue
    exit 1
}
