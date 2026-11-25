param(
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$serviceRoot = Join-Path $ProjectDir '.local\service'
$entry = Join-Path $ProjectDir 'src\recruiting-service.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$stopFlag = Join-Path $serviceRoot 'supervisor-stop'
$recordPath = Join-Path $serviceRoot 'supervisor.json'
$stdout = Join-Path $serviceRoot 'service.stdout.log'
$stderr = Join-Path $serviceRoot 'service.stderr.log'

New-Item -ItemType Directory -Force -Path $serviceRoot | Out-Null
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force }
$record = @{ pid = $PID; startedAt = (Get-Date).ToUniversalTime().ToString('o'); heartbeatAt = (Get-Date).ToUniversalTime().ToString('o') }
$record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8

try {
    while (-not (Test-Path -LiteralPath $stopFlag)) {
        $status = $null
        try { $status = (& $node $entry status 2>$null | ConvertFrom-Json) } catch { $status = $null }
        $alive = $false
        if ($status -and $status.running -and $status.pid) {
            try { Get-Process -Id ([int]$status.pid) -ErrorAction Stop | Out-Null; $alive = $true } catch { $alive = $false }
        }
        if (-not $alive) {
            Start-Process -FilePath $node -ArgumentList @(("`"$entry`""), 'run') -WorkingDirectory $ProjectDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
            Start-Sleep -Seconds 3
        } else {
            Start-Sleep -Seconds 5
        }
        $record.heartbeatAt = (Get-Date).ToUniversalTime().ToString('o')
        $record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8
    }
} finally {
    try {
        $current = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
        if ([int]$current.pid -eq $PID) { Remove-Item -LiteralPath $recordPath -Force }
    } catch { }
}
