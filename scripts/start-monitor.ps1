$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$monitorDir = Join-Path $projectDir '.local\monitor\company-2'
New-Item -ItemType Directory -Path $monitorDir -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$daemonPath = Join-Path $projectDir 'src\monitor-daemon.mjs'
$currentStatus = (& $nodePath $daemonPath status | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not read monitor state. Refusing duplicate start.' }
if ($currentStatus.running) {
    Write-Output "Monitor already running: $($currentStatus.runtime.pid)."
    exit 0
}
$processInfo = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $daemonPath + '"'), 'run') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $monitorDir 'stdout.log') -RedirectStandardError (Join-Path $monitorDir 'stderr.log') -PassThru
Write-Output "Monitor process started: $($processInfo.Id). Run npm run monitor:status to verify health."
