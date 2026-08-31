# WorkBuddy persistent daemon for Windows (Task Scheduler based, launchd equivalent).
# Decouples the backend from the launching session (agent / terminal / double-click):
#   - survives window close and agent session exit
#   - auto-restarts on crash (999 retries, 5s interval)
#   - starts automatically at logon
#
# Usage (run from project root, or anywhere - the script locates itself):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 stop      # stop now; still auto-starts next logon
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 uninstall # remove the task entirely
# Optional: -Port 7790   (default 7788), -NoOpen (skip opening browser)
#
# NOTE: output messages are English on purpose - avoids mojibake with
# Windows PowerShell 5.1 + non-BOM encodings, easier to read when helping others.
param(
  [Parameter(Position = 0)][string]$Action = "help",
  [int]$Port = 7788,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$ServerDir = Join-Path $ProjectRoot "server"
$TaskName = "WorkBuddyStudio"
$Url = "http://127.0.0.1:$Port"
$Healthz = "$Url/healthz"

function Test-Healthy {
  # curl.exe explicitly: in PowerShell "curl" is an alias for Invoke-WebRequest
  try {
    $r = & curl.exe -s -m 2 $Healthz 2>$null
    return ($r -match '"status":"ok"')
  } catch { return $false }
}

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Wait-Ready([int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Healthy) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return $false
}

# Portable Node auto-install (no admin, no installer wizard - mirrors macOS ensure_node).
# Lands in ~\.workbuddy-node; mirrors China-friendly first. ~25MB zip, 1-3 min.
$NodeVersion = "v22.14.0"
$NodeHome = Join-Path $env:USERPROFILE ".workbuddy-node"
function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Node $((node -v)) (system)"
    return $true
  }
  $n = Join-Path $NodeHome "node.exe"
  if (Test-Path $n) {
    $env:PATH = "$NodeHome;$env:PATH"
    Write-Host "[OK] Node $(& $n -v) (WorkBuddy portable)"
    return $true
  }

  $arch = switch ($env:PROCESSOR_ARCHITECTURE) { "ARM64" { "win-arm64" } default { "win-x64" } }
  $pkg = "node-$NodeVersion-$arch"
  $mirrors = @(
    "https://registry.npmmirror.com/-/binary/node",
    "https://nodejs.org/dist"
  )
  $zip = Join-Path $env:TEMP "$pkg.zip"
  $ok = $false
  foreach ($m in $mirrors) {
    Write-Host "==> Downloading Node.js $NodeVersion (~25MB, 1-3 min) from $m ..."
    try {
      # Security protocol: Win PowerShell 5.1 defaults to TLS1.0/1.1, nodejs.org requires TLS1.2+
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri "$m/$NodeVersion/$pkg.zip" -OutFile $zip -UseBasicParsing
      if ((Get-Item $zip).Length -gt 1MB) { $ok = $true; break }
    } catch { Write-Host "    source failed, trying next..." }
  }
  if (-not $ok) {
    Write-Host "[X] Node download failed. Install manually from https://nodejs.org, then re-run."
    return $false
  }

  Write-Host "==> Extracting to $NodeHome ..."
  $tmpDir = Join-Path $env:TEMP "wb-node-extract"
  if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  try {
    Expand-Archive -Path $zip -DestinationPath $tmpDir -Force
    if (Test-Path $NodeHome) { Remove-Item $NodeHome -Recurse -Force }
    Move-Item (Join-Path $tmpDir $pkg) $NodeHome
    $env:PATH = "$NodeHome;$env:PATH"
    Write-Host "[OK] Node $(& (Join-Path $NodeHome 'node.exe') -v) (WorkBuddy portable, ready)"
    return $true
  } catch {
    Write-Host "[X] Extract failed ($($_.Exception.Message)). Install Node manually from https://nodejs.org."
    return $false
  }
}

switch ($Action) {

"start" {
  if (-not (Ensure-Node)) { exit 1 }
  if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
    Write-Host "==> Installing dependencies (1-2 min, first run only)..."
    Push-Location $ServerDir
    try { & npm.cmd install --no-fund --no-audit; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
    finally { Pop-Location }
  }

  if (Test-Healthy) { Write-Host "[OK] WorkBuddy already running: $Url"; exit 0 }

  # Port occupied by something that is not us?
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    Write-Host "[X] Port $Port is occupied by another program. Retry with: -Port 7790"
    exit 1
  }

  $nodeBin = (Get-Command node).Source
  $tsxcli = Join-Path $ServerDir "node_modules\tsx\dist\cli.mjs"
  if (-not (Test-Path $tsxcli)) { Write-Host "[X] tsx not found at $tsxcli - run npm install in server\"; exit 1 }

  # Single process on purpose (NOT npm run dev): tsx watch swallows child crashes
  # and keeps running, which defeats Task Scheduler's restart-on-failure.
  # Hidden window: console apps launched by interactive tasks would otherwise pop a window.
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"`$env:PORT='$Port'; & '$nodeBin' '$tsxcli' 'src\index.ts'`"" `
    -WorkingDirectory $ServerDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Battery flags matter: laptops on battery would otherwise not start / get killed.
  # ExecutionTimeLimit 0: default 72h limit would kill a long-running server.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 5) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable
  # Interactive logon task (no password needed, mirrors macOS LaunchAgent behaviour)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  # Idempotent: remove previous registration first
  if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  Write-Host "==> Waiting for service"
  if (Wait-Ready) {
    Write-Host "[OK] Persistent service ready: $Url"
    Write-Host "     Daemon: Task Scheduler (survives window close & crashes; starts at logon)"
    Write-Host "     Stop:   stop (auto-starts next logon)   Remove entirely: uninstall"
    Write-Host "     Logs:   logs\server.log (app, written by the process itself)"
    if (-not $NoOpen) { Start-Process $Url }
    exit 0
  }
  Write-Host "[X] Not ready in 30s. Check logs\server.log and: Get-ScheduledTaskInfo -TaskName $TaskName"
  exit 1
}

"status" {
  if (Test-Healthy) { Write-Host "[OK] Running: $Url" } else { Write-Host "[X] Not running ($Url no response)" }
  $t = Get-Task
  if ($t) {
    Write-Host "Task Scheduler: registered ($($t.State); restart-on-crash enabled)"
    Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object NumberOfRuns, LastTaskResult, LastRunTime | Format-List
  } else {
    Write-Host "Task Scheduler: NOT registered (current instance is session-bound, dies with the session)"
  }
}

"stop" {
  if (Get-Task) {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "[OK] Stopped. Task kept - it will auto-start again at next logon."
  } else {
    Write-Host "Task Scheduler: not registered, nothing to stop."
  }
}

"uninstall" {
  if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Host "[OK] Removed Task Scheduler entry (no more auto-start)."
}

default {
  Write-Host "WorkBuddy daemon (Windows / Task Scheduler)"
  Write-Host "Usage: workbuddy-daemon.ps1 start|status|stop|uninstall [-Port 7788] [-NoOpen]"
}
}
