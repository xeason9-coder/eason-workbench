$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$Collector = [System.IO.Path]::GetFullPath((Join-Path $Root 'we-mp-rss'))
$Kb = Join-Path $Root 'KB'
$Python = Join-Path $Collector '.venv\Scripts\python.exe'
$BackupRoot = Join-Path $Root 'backups'

function Test-RunningCommand([string]$Exe, [string[]]$Tokens) {
    $FullExe = [IO.Path]::GetFullPath($Exe)
    foreach ($Process in Get-CimInstance Win32_Process) {
        if (-not $Process.ExecutablePath -or
            -not [string]::Equals([IO.Path]::GetFullPath($Process.ExecutablePath), $FullExe, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not $Process.CommandLine) { continue }
        $Matches = $true
        foreach ($Token in $Tokens) {
            if ($Process.CommandLine.IndexOf($Token, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $Matches = $false; break }
        }
        if ($Matches) { return $true }
    }
    return $false
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $Kb '.dev.vars')) -or
        -not (Test-Path -LiteralPath (Join-Path $Collector 'config.yaml')) -or
        -not (Test-Path -LiteralPath (Join-Path $Collector 'data\db.db'))) {
        throw '缺少数据源或私密配置文件，未创建备份。'
    }
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $Running = @(
        (Test-RunningCommand $Python @('main.py')),
        (Test-RunningCommand $Node @('node_modules/wrangler/wrangler-dist/cli.js', 'dist/server/wrangler.json', '--persist-to')),
        (Test-RunningCommand $Node @('scripts/run-framework.mjs', 'dev')),
        (Test-RunningCommand $Node @('scripts/fusion-background.mjs'))
    )
    if ($Running -contains $true) { throw '融合服务仍在运行，请先停止本地服务；未创建备份。' }
    foreach ($Port in @(5173, 8768)) {
        if (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0) {
            throw "端口 $Port 仍在监听；未创建备份。"
        }
    }

    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $Destination = Join-Path $BackupRoot $Stamp
    if (Test-Path -LiteralPath $Destination) { throw '同名备份已存在，未覆盖任何文件。' }
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & "$env:SystemRoot\System32\icacls.exe" $Destination /inheritance:r /grant:r `
        "$($Identity):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法限制备份文件访问权限；未继续。' }

    Copy-Item -LiteralPath (Join-Path $Kb '.dev.vars') -Destination (Join-Path $Destination 'KB.dev.vars')
    $Persisted = Join-Path $Root 'runtime\kb'
    if (Test-Path -LiteralPath $Persisted) {
        Copy-Item -LiteralPath $Persisted -Destination (Join-Path $Destination 'runtime-kb') -Recurse
    } else {
        New-Item -ItemType Directory -Path (Join-Path $Destination 'runtime-kb') | Out-Null
    }
    $PrivateRuntime = Join-Path $Destination 'runtime'
    New-Item -ItemType Directory -Path $PrivateRuntime -Force | Out-Null
    $ModelKey = Join-Path $Root 'runtime\model-encryption.key'
    if (Test-Path -LiteralPath $ModelKey) {
        Copy-Item -LiteralPath $ModelKey -Destination (Join-Path $PrivateRuntime 'model-encryption.key')
    }
    Get-ChildItem -LiteralPath (Join-Path $Root 'runtime') -File -Force | Where-Object {
        $_.Name -match '(?i)acceptance|account|账号|验收'
    } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $PrivateRuntime }
    $CollectorBackup = Join-Path $Destination 'collector'
    $DataBackup = Join-Path $CollectorBackup 'data'
    New-Item -ItemType Directory -Path $DataBackup -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Collector 'config.yaml') -Destination (Join-Path $CollectorBackup 'config.yaml')
    Get-ChildItem -LiteralPath (Join-Path $Collector 'data') -Force | Where-Object {
        $_.Name -notin @('cache', 'backups', 'rehearsal', 'db.db', 'db.db-wal', 'db.db-shm', 'db.before-url-dedupe.sqlite', 'db.before-workbench.sqlite') -and
        $_.Name -notmatch '\.log$|\.pid$|\.workbench-backup-'
    } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $DataBackup -Recurse }
    $DbTarget = Join-Path $DataBackup 'db.db'
    @'
import sqlite3, sys
src, dst = sys.argv[1:]
with sqlite3.connect(f"file:{src.replace(chr(92), '/')}?mode=ro", uri=True, timeout=30) as source:
    with sqlite3.connect(dst) as target:
        source.backup(target)
    names = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    counts = {n: source.execute('SELECT COUNT(*) FROM "' + n.replace('"','""') + '"').fetchone()[0] for n in names}
with sqlite3.connect(dst) as target:
    integrity = target.execute('PRAGMA integrity_check').fetchone()[0]
    copied = {n: target.execute('SELECT COUNT(*) FROM "' + n.replace('"','""') + '"').fetchone()[0] for n in names}
if integrity != 'ok' or counts != copied:
    raise SystemExit('SQLite 备份校验失败')
print(f"SQLite integrity: {integrity}; tables: {len(names)}; row counts match.")
'@ | & $Python -X utf8 - (Join-Path $Collector 'data\db.db') $DbTarget
    if ($LASTEXITCODE -ne 0) { throw 'SQLite备份失败；请检查本次备份目录，不要用于恢复。' }
    Set-Content -LiteralPath (Join-Path $Destination 'COMPLETE.txt') -Value '本地融合版备份已完成；恢复前请确认此文件存在。' -Encoding UTF8
    Write-Host "备份已完成：$Destination"
} catch {
    Write-Error "备份失败：$($_.Exception.Message)"
    exit 1
}
