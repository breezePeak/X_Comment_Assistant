param([string]$NodePath)
$ErrorActionPreference = 'Stop'
$serviceName = 'XCommentAssistant'
$serviceRoot = $PSScriptRoot
$dataDirectory = Join-Path $serviceRoot 'data'
$runtimeDirectory = Join-Path $dataDirectory 'windows-service'
$wrapper = Join-Path $runtimeDirectory "$serviceName.exe"
$serverFile = Join-Path $serviceRoot 'server.mjs'

try {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an Administrator PowerShell.'
    }
    if (-not $NodePath) {
        $NodePath = Get-Command node -All -CommandType Application | Select-Object -ExpandProperty Source -Unique | Where-Object {
            $version = & $_ --version
            $LASTEXITCODE -eq 0 -and ([version]$version.TrimStart('v')).Major -ge 24
        } | Select-Object -First 1
    }
    if (-not $NodePath) { throw 'Node.js 24+ is required. Supply -NodePath with its full path.' }
    $NodePath = (Resolve-Path -LiteralPath $NodePath).Path
    $version = & $NodePath --version
    if ($LASTEXITCODE -ne 0 -or ([version]$version.TrimStart('v')).Major -lt 24) { throw 'Node.js 24+ is required.' }
    $existing = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($existing -and $existing.PathName.Trim('"') -ne $wrapper) { throw 'Service name is already used by another installation.' }
    # Only replace the listener belonging to this exact server file.
    $listeners = @(Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine.Contains($serverFile) -or $owner.CommandLine -notmatch '(?:^|\s)--local(?:\s|$)') {
            throw 'Port 12345 is occupied by another program; no process was stopped.'
        }
    }
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $wrapper)) {
        Invoke-WebRequest 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $wrapper -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ne '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA') {
        throw 'WinSW checksum mismatch; installation cancelled.'
    }
    if ($existing) { Stop-Service $serviceName; (Get-Service $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    foreach ($listener in $listeners) {
        if (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue) { Stop-Process -Id $listener.OwningProcess -ErrorAction Stop }
    }
    $runtimeNode = Join-Path $runtimeDirectory 'node.exe'
    if ($NodePath -ne $runtimeNode) { Copy-Item -LiteralPath $NodePath -Destination $runtimeNode -Force }
    $escapedRoot = [Security.SecurityElement]::Escape($serviceRoot)
    @"
<service>
  <id>$serviceName</id>
  <name>X Comment Assistant</name>
  <description>Local posts and analytics API on 127.0.0.1:12345.</description>
  <executable>%BASE%\node.exe</executable>
  <arguments>"$escapedRoot\server.mjs" --local</arguments>
  <workingdirectory>$escapedRoot</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <logpath>$escapedRoot\data</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@ | Set-Content -LiteralPath (Join-Path $runtimeDirectory "$serviceName.xml") -Encoding UTF8
    & icacls.exe $serviceRoot /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to grant service read access.' }
    & icacls.exe $dataDirectory /grant '*S-1-5-19:(OI)(CI)M' /T | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to grant service database access.' }
    if (-not $existing) {
        & $wrapper install
        if ($LASTEXITCODE -ne 0) { throw 'Service installation failed.' }
    }
    Set-Service $serviceName -StartupType Automatic
    & sc.exe failure $serviceName reset= 86400 actions= restart/10000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to configure service recovery.' }
    Start-Service $serviceName
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:12345/healthz' -TimeoutSec 2
            if ($health.ok -and $health.service -eq 'x-comment-assistant' -and $health.localOnly -and (Get-Service $serviceName).Status -eq 'Running') {
                Get-CimInstance Win32_Service -Filter "Name='$serviceName'" | Select-Object Name, State, StartMode, StartName, PathName
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'Service is not healthy. Check data/XCommentAssistant*.log.'
} catch {
    Write-Error $_
    exit 1
}
