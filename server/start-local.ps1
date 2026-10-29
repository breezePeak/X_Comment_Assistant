$ErrorActionPreference = 'Stop'
$serviceUrl = 'http://127.0.0.1:12345'
$serviceRoot = $PSScriptRoot
$dataDirectory = Join-Path $serviceRoot 'data'

function Test-LocalService {
    try {
        $health = Invoke-RestMethod -Uri "$serviceUrl/healthz" -TimeoutSec 2
        return $health.ok -and $health.service -eq 'x-comment-assistant' -and $health.localOnly
    } catch { return $false }
}

try {
    if (Test-LocalService) {
        Write-Host "Local service is already running: $serviceUrl"
        exit 0
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Install Node.js 24 or newer, then double-click this launcher again.' }
    $nodeVersion = & $nodeCommand.Source --version
    if ($LASTEXITCODE -ne 0 -or ([version]$nodeVersion.TrimStart('v')).Major -lt 24) { throw 'Node.js 24 or newer is required.' }
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    $serverFile = Join-Path $serviceRoot 'server.mjs'
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $serverFile + '"'), '--local') -WorkingDirectory $serviceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDirectory 'service.log') -RedirectStandardError (Join-Path $dataDirectory 'service-error.log')
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-LocalService) {
            Write-Host "Started: $serviceUrl"
            Write-Host ('Database: ' + (Join-Path $dataDirectory 'posts.sqlite'))
            exit 0
        }
        if ($process.HasExited) { throw ('Service failed. See ' + (Join-Path $dataDirectory 'service-error.log')) }
        Start-Sleep -Milliseconds 200
    }
    throw 'Service did not become ready. Check port 12345 and data/service-error.log.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
