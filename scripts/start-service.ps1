$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $projectDir 'src\recruiting-service.mjs'
$status = & $node $entry status | ConvertFrom-Json
if ($status.running) { Write-Output 'Recruiting service already running.'; exit 0 }
$logs = Join-Path $projectDir '.local\service'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), 'run') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'service.stdout.log') -RedirectStandardError (Join-Path $logs 'service.stderr.log') -PassThru
Write-Output "Recruiting service starting: $($process.Id). Open http://127.0.0.1:19336/ and check service:status."
