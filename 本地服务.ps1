param(
    [ValidateSet('Start', 'Stop')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$Collector = [System.IO.Path]::GetFullPath((Join-Path $Root 'we-mp-rss'))
$Runtime = Join-Path $Root 'runtime'
$Logs = Join-Path $Runtime 'logs'
$Pids = Join-Path $Runtime 'pids'
$Python = Join-Path $Collector '.venv\Scripts\python.exe'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Kb = Join-Path $Root 'KB'

$Services = @(
    [pscustomobject]@{
        Name = 'collector'; Exe = $Python; Work = $Collector
        Args = @('-X', 'utf8', 'main.py', '-job', 'False')
        Tokens = @('main.py', '-job', 'False'); Port = 8768
        Url = 'http://127.0.0.1:8768/workbench/login'; Status = @(200)
    },
    [pscustomobject]@{
        Name = 'knowledge-base'; Exe = $Node; Work = $Kb
        Args = @('--import', './scripts/sites-env.mjs', './node_modules/wrangler/wrangler-dist/cli.js', 'dev', '--config', 'dist/server/wrangler.json', '--local', '--persist-to', '../runtime/kb', '--ip', '127.0.0.1', '--port', '5173', '--env-file', '.dev.vars', '--inspector-port', '0')
        Tokens = @('node_modules/wrangler/wrangler-dist/cli.js', 'dist/server/wrangler.json', '--persist-to'); Port = 5173
        Url = 'http://127.0.0.1:5173/api/fusion/auth/session'; Status = @(200, 401)
    },
    [pscustomobject]@{
        Name = 'fusion-background'; Exe = $Node; Work = $Kb
        Args = @('scripts/fusion-background.mjs')
        Tokens = @('scripts/fusion-background.mjs'); Port = $null
        Url = $null; Status = @()
    }
)

function Get-ProcessInfo([int]$Id) {
    Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction SilentlyContinue
}

function Test-ProcessTreeMember([int]$ChildId, [int]$RootId) {
    $Current = Get-ProcessInfo $ChildId
    for ($Depth = 0; $Current -and $Depth -lt 32; $Depth++) {
        if ([int]$Current.ProcessId -eq $RootId) { return $true }
        $Parent = Get-ProcessInfo ([int]$Current.ParentProcessId)
        if (-not $Parent) { return $false }
        try {
            $ChildStart = (Get-Process -Id ([int]$Current.ProcessId)).StartTime
            $ParentStart = (Get-Process -Id ([int]$Parent.ProcessId)).StartTime
            if ($ChildStart -lt $ParentStart) { return $false }
        } catch { return $false }
        $Current = $Parent
    }
    return $false
}

function Test-TargetProcess($Service, $Process) {
    if (-not $Process) { return $false }
    if ([string]::IsNullOrWhiteSpace($Process.ExecutablePath)) { return $false }
    if ([string]::IsNullOrWhiteSpace($Process.CommandLine)) { return $false }
    if (-not [string]::Equals([IO.Path]::GetFullPath($Process.ExecutablePath), [IO.Path]::GetFullPath($Service.Exe), [StringComparison]::OrdinalIgnoreCase)) { return $false }
    foreach ($Token in $Service.Tokens) {
        if ($Process.CommandLine.IndexOf($Token, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    }
    return $true
}

function Get-OwnedRecord($Service) {
    $File = Join-Path $Pids ($Service.Name + '.pid.json')
    if (-not (Test-Path -LiteralPath $File)) { return $null }
    $Record = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    $Process = Get-ProcessInfo ([int]$Record.pid)
    if (-not $Process) {
        Remove-Item -LiteralPath $File
        return $null
    }
    if (-not (Test-TargetProcess $Service $Process)) {
    throw "进程编号与$($Service.Name)记录不匹配；未停止该进程。"
    }
    $ActualStart = (Get-Process -Id ([int]$Record.pid)).StartTime.ToUniversalTime()
    $RecordedStart = if ($Record.startedUtc -is [datetime]) {
        $Record.startedUtc.ToUniversalTime()
    } else {
        [datetime]::Parse([string]$Record.startedUtc, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    }
    if ([math]::Abs(($ActualStart - $RecordedStart).TotalSeconds) -gt 2) {
        throw "$($Service.Name)的进程编号已被其他进程复用；未停止该进程。"
    }
    return $Record
}

function Test-HttpReady($Service) {
    try {
        $Response = Invoke-WebRequest -Uri $Service.Url -UseBasicParsing -TimeoutSec 3
        return $Service.Status -contains [int]$Response.StatusCode
    } catch {
        $Response = $_.Exception.Response
        if ($Response -and $Response.StatusCode) {
            return $Service.Status -contains [int]$Response.StatusCode
        }
        return $false
    }
}

function Test-OwnedHttpReady($Service, [int]$Id) {
    if (-not (Test-HttpReady $Service)) { return $false }
    $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Service.Port -ErrorAction SilentlyContinue)
    foreach ($OwnerId in $Listeners.OwningProcess | Select-Object -Unique) {
        if (Test-ProcessTreeMember ([int]$OwnerId) $Id) { return $true }
    }
    return $false
}

function Wait-Ready($Service, [int]$Id) {
    $TimeoutSeconds = if ($Service.Name -eq 'knowledge-base') { 90 } else { 30 }
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $NextProgress = (Get-Date).AddSeconds(10)
    do {
        $Process = Get-ProcessInfo $Id
        if (-not (Test-TargetProcess $Service $Process)) {
            throw "$($Service.Name) 已退出或进程信息变化；请查看 runtime\logs。"
        }
        if ($Service.Port -eq $null) {
            if (Test-Path -LiteralPath $Service.Stdout) {
                $Stream = $null; $Reader = $null
                try {
                    $Stream = [IO.File]::Open($Service.Stdout, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                    $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8)
                    if ($Reader.ReadToEnd().Contains('后台调度已连接')) { return }
                } catch [IO.IOException] {
                    # The redirected log may still be opening; retry within the readiness deadline.
                } finally { if ($Reader) { $Reader.Dispose() } elseif ($Stream) { $Stream.Dispose() } }
            }
        } elseif (Test-OwnedHttpReady $Service $Id) {
            return
        }
        if ($Service.Name -eq 'knowledge-base' -and (Get-Date) -ge $NextProgress) {
            Write-Host '知识库首次启动准备中，请稍候…'
            $NextProgress = (Get-Date).AddSeconds(10)
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $Deadline)
    throw "$($Service.Name) 等待$TimeoutSeconds 秒仍未通过本机健康检查；请查看 runtime\logs。"
}

function Stop-OwnedService($Service) {
    $Record = Get-OwnedRecord $Service
    if (-not $Record) {
        Write-Host "No owned process to stop: $($Service.Name)"
        return
    }
    & "$env:SystemRoot\System32\taskkill.exe" /PID ([int]$Record.pid) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not stop recorded process for $($Service.Name)." }
    $Deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $Deadline -and (Get-ProcessInfo ([int]$Record.pid))) { Start-Sleep -Milliseconds 250 }
    if (Get-ProcessInfo ([int]$Record.pid)) { throw "Process tree did not exit for $($Service.Name)." }
    Remove-Item -LiteralPath (Join-Path $Pids ($Service.Name + '.pid.json'))
    Write-Host "Stopped: $($Service.Name)"
}

function Start-LocalService($Service, [System.Collections.Generic.List[object]]$Started) {
    $Record = Get-OwnedRecord $Service
    if ($Record) {
        if ($Service.Port -eq $null) {
            Write-Host "Already running: $($Service.Name)"
            return
        }
        if (Test-OwnedHttpReady $Service ([int]$Record.pid)) {
            Write-Host "Already healthy: $($Service.Name)"
            return
        }
            throw "已记录的$($Service.Name)仍在运行但健康检查未通过；未自动重启。"
    }

    if ($Service.Port -ne $null) {
        $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Service.Port -ErrorAction SilentlyContinue)
        if ($Listeners.Count -gt 0) {
            $Healthy = Test-HttpReady $Service
            $State = if ($Healthy) { '健康检查有响应' } else { '健康检查未通过' }
            throw "端口 $($Service.Port) 被未登记进程占用（$State）；未停止该进程。"
        }
    }

    $LogName = '{0}-{1}' -f $Service.Name, (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $Stdout = Join-Path $Logs ($LogName + '.log')
    $Stderr = Join-Path $Logs ($LogName + '.err.log')
    $Service | Add-Member -NotePropertyName Stdout -NotePropertyValue $Stdout -Force
    $Process = Start-Process -FilePath $Service.Exe -ArgumentList $Service.Args `
        -WorkingDirectory $Service.Work -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr
    $Started.Add($Service) | Out-Null
    $Info = Get-ProcessInfo $Process.Id
    if (-not (Test-TargetProcess $Service $Info)) { throw "无法核对$($Service.Name)启动进程；请查看 runtime\logs。" }
    $StartedUtc = (Get-Process -Id $Process.Id).StartTime.ToUniversalTime().ToString('o')
    $Record = [pscustomobject]@{ pid = $Process.Id; startedUtc = $StartedUtc }
    $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Pids ($Service.Name + '.pid.json')) -Encoding UTF8
    Wait-Ready $Service $Process.Id
    Write-Host "已启动：$($Service.Name)；日志位置：$Stdout、$Stderr"
}

try {
    if ($Action -eq 'Stop') {
        New-Item -ItemType Directory -Path $Pids -Force | Out-Null
        foreach ($Service in @($Services)[2..0]) { Stop-OwnedService $Service }
        exit 0
    }

    $Background = Join-Path $Kb 'scripts\fusion-background.mjs'
    if (-not (Test-Path -LiteralPath (Join-Path $Kb 'dist\server\wrangler.json')) -or
        -not (Test-Path -LiteralPath (Join-Path $Kb 'node_modules\wrangler\wrangler-dist\cli.js'))) {
        throw '知识库本地Worker构建产物缺失；请先在 KB 目录运行 pnpm build，启动器不会自动构建。'
    }
    if (-not (Test-Path -LiteralPath $Python) -or -not (Test-Path -LiteralPath $Background) -or
        -not (Test-Path -LiteralPath (Join-Path $Kb '.dev.vars')) -or
        -not (Test-Path -LiteralPath (Join-Path $Collector 'data\fusion-service.key'))) {
            throw '缺少本地运行文件或私密配置，未启动任何服务。'
    }
    New-Item -ItemType Directory -Path $Logs -Force | Out-Null
    New-Item -ItemType Directory -Path $Pids -Force | Out-Null
    # Wrangler reads Worker bindings beside the generated configuration, not from the source checkout.
    $RuntimeVars = Join-Path $Kb 'dist\server\.dev.vars'
    Copy-Item -LiteralPath (Join-Path $Kb '.dev.vars') -Destination $RuntimeVars -Force
    $RuntimeIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & "$env:SystemRoot\System32\icacls.exe" $RuntimeVars /inheritance:r /grant:r "$($RuntimeIdentity):F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法保护构建版私密配置；未启动服务。' }
    $Started = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($Service in $Services) { Start-LocalService $Service $Started }
    } catch {
        for ($Index = $Started.Count - 1; $Index -ge 0; $Index--) {
            try { Stop-OwnedService $Started[$Index] } catch { Write-Warning "清理$($Started[$Index].Name)失败：$($_.Exception.Message)；请检查 runtime\pids 和日志。" }
        }
        throw
    }
    Write-Host 'Local services are ready: http://127.0.0.1:5173 and http://127.0.0.1:8768/workbench/'
} catch {
    Write-Error $_
    exit 1
}
