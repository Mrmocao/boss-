$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $projectDir 'src\recruiting-service.mjs'
$supervisor = Join-Path $PSScriptRoot 'service-supervisor.ps1'
$status = & $node $entry status | ConvertFrom-Json
$logs = Join-Path $projectDir '.local\service'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stopFlag = Join-Path $logs 'supervisor-stop'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force }
$supervisorRecord = Join-Path $logs 'supervisor.json'
$supervisorAlive = $false
try {
    $record = Get-Content -Raw -LiteralPath $supervisorRecord | ConvertFrom-Json
    Get-Process -Id ([int]$record.pid) -ErrorAction Stop | Out-Null
    $supervisorAlive = $true
} catch { $supervisorAlive = $false }
if (-not $supervisorAlive) {
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $supervisor + '"'),'-ProjectDir',('"' + $projectDir + '"')) -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'supervisor.stdout.log') -RedirectStandardError (Join-Path $logs 'supervisor.stderr.log') -PassThru
    Write-Output "Recruiting service supervisor starting: $($process.Id). Open http://127.0.0.1:19336/ and check service:status."
} elseif ($status.running) {
    Write-Output 'Recruiting service and supervisor already running.'
} else {
    Write-Output 'Recruiting service supervisor already running and will restart the service.'
}
