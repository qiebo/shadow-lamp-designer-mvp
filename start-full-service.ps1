[CmdletBinding()]
param(
  [int]$PreferredPort = 5173,
  [switch]$ForceSwiftShader
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Test-PortOpen {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", $Port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-FreePort {
  param(
    [int]$StartPort,
    [int]$ScanRange = 20
  )

  for ($p = $StartPort; $p -le ($StartPort + $ScanRange); $p += 1) {
    if (-not (Test-PortOpen -Port $p)) {
      return $p
    }
  }
  throw "No free port found in range $StartPort-$($StartPort + $ScanRange)."
}

function Find-ChromiumBrowser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) {
      return $path
    }
  }
  return $null
}

function Open-AppUrl {
  param(
    [string]$Url,
    [switch]$SwiftShader
  )

  if (-not $SwiftShader) {
    Start-Process $Url
    return
  }

  $browser = Find-ChromiumBrowser
  if ($null -eq $browser) {
    Start-Process $Url
    Write-Host "[WARN] Chrome/Edge not found. Opened with default browser (no SwiftShader flags)." -ForegroundColor Yellow
    return
  }

  $profileDir = Join-Path $PSScriptRoot ".swiftshader-browser-profile"
  if (-not (Test-Path -LiteralPath $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir | Out-Null
  }

  $args = @(
    "--new-window",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--user-data-dir=$profileDir",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    $Url
  )
  Start-Process -FilePath $browser -ArgumentList $args | Out-Null
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "[ERROR] npm was not found. Install Node.js first." -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "[INFO] Installing dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] npm install failed." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
  }
}

$port = Get-FreePort -StartPort $PreferredPort
$url = "http://127.0.0.1:$port/"
$devCommand = "cd /d `"$PSScriptRoot`" && npm run dev -- --host 127.0.0.1 --port $port --strictPort"

Write-Host "[INFO] Starting dev server: $url" -ForegroundColor Cyan
Start-Process -FilePath "cmd.exe" -ArgumentList "/k $devCommand" | Out-Null

$deadline = (Get-Date).AddSeconds(45)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-PortOpen -Port $port) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 400
}

Open-AppUrl -Url $url -SwiftShader:$ForceSwiftShader

if ($ready) {
  if ($ForceSwiftShader) {
    Write-Host "[OK] Service is ready. Browser opened in SwiftShader mode at $url" -ForegroundColor Green
  } else {
    Write-Host "[OK] Service is ready. Browser opened at $url" -ForegroundColor Green
  }
} else {
  Write-Host "[WARN] Browser opened, but service is still warming up." -ForegroundColor Yellow
  Write-Host "       Wait a few seconds and refresh once." -ForegroundColor Yellow
}
