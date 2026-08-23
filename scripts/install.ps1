#Requires -Version 5.1
# Safe for: irm .../install.ps1 | iex
# Also: powershell -File install.ps1 -Action start
& {
<#
.SYNOPSIS
  dsh-telegram-channel manager menu: install / start / stop / status.

.EXAMPLE
  irm https://raw.githubusercontent.com/zhang0098/dsh-telegram-channel/master/scripts/install.ps1 | iex

.EXAMPLE
  .\scripts\install.ps1 -Action start
  .\scripts\install.ps1 -Action install -Token '...' -UserId '123'
#>
[CmdletBinding()]
param(
  [ValidateSet('', 'menu', 'install', 'start', 'stop', 'status', 'open')]
  [string] $Action = '',
  [string] $Token = $env:DSH_TELEGRAM_TOKEN,
  [string] $UserId = $env:DSH_TELEGRAM_ALLOWED_USER_IDS,
  [string] $ProfileName = 'web',
  [string] $Source = 'github:zhang0098/dsh-telegram-channel',
  [int] $Port = 3080,
  [switch] $Local,
  [switch] $NoPersist
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) {
  Write-Host ""
  Write-Host ("==> " + $Message) -ForegroundColor Cyan
}

function Write-Ok([string] $Message) {
  Write-Host $Message -ForegroundColor Green
}

function Write-Warn2([string] $Message) {
  Write-Host $Message -ForegroundColor Yellow
}

function Ensure-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw ("Command not found: " + $Name + ". Install DeepSeek Harness CLI (dsh) and add it to PATH.")
  }
}

function Get-DshHome {
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Get-ProfileDir {
  $dir = Join-Path (Get-DshHome) ('profiles\' + $ProfileName)
  if (-not (Test-Path -LiteralPath $dir)) {
    throw ("Profile directory not found: " + $dir + "`nRun dsh web once first.")
  }
  return $dir
}

function Set-UserEnv([string] $Name, [string] $Value) {
  Set-Item -Path ("Env:" + $Name) -Value $Value
  if (-not $NoPersist) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  }
}

function Get-UserEnv([string] $Name) {
  $v = [Environment]::GetEnvironmentVariable($Name, 'User')
  if ($v) { return $v }
  return [Environment]::GetEnvironmentVariable($Name, 'Process')
}

# pnpm 10+/11: package-name alone does NOT approve git/tarball installs.
# Need the stable repo key (works across commits). See: https://pnpm.io/settings/build
function Get-AllowBuildsEntries {
  return @(
    '  dsh-telegram-channel: true'
    "  'dsh-telegram-channel@git+https://github.com/zhang0098/dsh-telegram-channel.git': true"
  )
}

function Ensure-AllowBuilds([string] $ProfileDir) {
  $path = Join-Path $ProfileDir 'pnpm-workspace.yaml'
  $entries = Get-AllowBuildsEntries
  $block = (@('allowBuilds:') + $entries) -join "`r`n"

  if (-not (Test-Path -LiteralPath $path)) {
    $content = @(
      'packages:'
      '  - .'
      ''
      'nodeLinker: hoisted'
      'autoInstallPeers: false'
      ''
      $block
    ) -join "`r`n"
    Set-Content -LiteralPath $path -Value $content -Encoding utf8
    Write-Host ("Created " + $path + " (allowBuilds)")
    return
  }

  $raw = Get-Content -LiteralPath $path -Raw
  # Drop pnpm auto-placeholders ("set this to true or false") for this package.
  $raw = [regex]::Replace(
    $raw,
    '(?m)^\s*[''"]?dsh-telegram-channel@https://codeload\.github\.com/[^\r\n]+:\s*set this to true or false\s*\r?\n?',
    ''
  )

  $repoKeyPresent = $raw -match 'dsh-telegram-channel@git\+https://github\.com/zhang0098/dsh-telegram-channel\.git'
  $nameKeyPresent = $raw -match '(?m)^\s*dsh-telegram-channel\s*:\s*true\s*$'
  if ($repoKeyPresent -and $nameKeyPresent) {
    Write-Host 'allowBuilds already present (git repo + package name), skip'
    return
  }

  $toInsert = @()
  if (-not $nameKeyPresent) { $toInsert += '  dsh-telegram-channel: true' }
  if (-not $repoKeyPresent) {
    $toInsert += "  'dsh-telegram-channel@git+https://github.com/zhang0098/dsh-telegram-channel.git': true"
  }
  $insertText = ($toInsert -join "`r`n")

  if ($raw -match '(?m)^allowBuilds\s*:') {
    $raw = $raw -replace '(?m)^(allowBuilds\s*:)', ('$1' + "`r`n" + $insertText)
    Set-Content -LiteralPath $path -Value ($raw.TrimEnd() + "`r`n") -Encoding utf8
    Write-Host ("Updated allowBuilds (git repo approval) -> " + $path)
    return
  }

  Add-Content -LiteralPath $path -Value ("`r`n" + $block + "`r`n") -Encoding utf8
  Write-Host ("Appended allowBuilds -> " + $path)
}

function Get-ListenPids([int] $ListenPort) {
  $pids = @()
  try {
    $pids = @(
      Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    $pids = @()
  }
  if ($pids.Count -eq 0) {
    $lines = netstat -ano | Select-String -Pattern 'LISTENING' | Select-String -Pattern (':' + $ListenPort + '\s')
    foreach ($line in $lines) {
      if ($line -match '\s(\d+)\s*$') {
        $pids += [int]$Matches[1]
      }
    }
    $pids = @($pids | Select-Object -Unique)
  }
  return $pids
}

function Get-DshWebPids {
  $found = @()
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = [string]$_.CommandLine
    if ($cmd -match 'bin\.js' -and $cmd -match '\bweb\b' -and $cmd -match 'deepseek-ai') {
      $found += [int]$_.ProcessId
    } elseif ($cmd -match 'dsh\\lib\\bin\.js' -and $cmd -match '\bweb\b') {
      $found += [int]$_.ProcessId
    }
  }
  return @($found | Select-Object -Unique)
}

function Show-Status {
  Write-Step ('Status (profile=' + $ProfileName + ', port=' + $Port + ')')

  $token = Get-UserEnv 'DSH_TELEGRAM_TOKEN'
  $allow = Get-UserEnv 'DSH_TELEGRAM_ALLOWED_USER_IDS'
  if ($token) { Write-Ok ('Token: set (length ' + $token.Length + ')') } else { Write-Warn2 'Token: NOT set (DSH_TELEGRAM_TOKEN)' }
  if ($allow) { Write-Ok ('Allowlist: ' + $allow) } else { Write-Warn2 'Allowlist: NOT set (DSH_TELEGRAM_ALLOWED_USER_IDS)' }

  $profileDir = $null
  try { $profileDir = Get-ProfileDir } catch { Write-Warn2 $_.Exception.Message }
  if ($profileDir) {
    $pkg = Join-Path $profileDir 'package.json'
    if (Test-Path -LiteralPath $pkg) {
      $raw = Get-Content -LiteralPath $pkg -Raw
      if ($raw -match 'dsh-telegram-channel') {
        Write-Ok ('Plugin: found in ' + $pkg)
      } else {
        Write-Warn2 'Plugin: not in package.json yet (choose 1 to install)'
      }
    }
  }

  $listen = @(Get-ListenPids $Port)
  if ($listen.Count -gt 0) {
    Write-Ok ('dsh web: RUNNING  http://127.0.0.1:' + $Port + '  (PID ' + ($listen -join ', ') + ')')
  } else {
    Write-Warn2 ('dsh web: not listening on port ' + $Port + ' (choose 2 to start)')
  }
}

function Invoke-Install {
  Ensure-Command 'dsh'

  $useToken = $Token
  $useUserId = $UserId
  if (-not $useToken) { $useToken = Get-UserEnv 'DSH_TELEGRAM_TOKEN' }
  if (-not $useUserId) { $useUserId = Get-UserEnv 'DSH_TELEGRAM_ALLOWED_USER_IDS' }

  if (-not $useToken) {
    $useToken = Read-Host 'Paste BotFather Bot Token'
  }
  $useToken = ([string]$useToken).Trim()
  if (-not $useToken) { throw 'Missing Bot Token.' }

  if (-not $useUserId) {
    $useUserId = Read-Host 'Paste Telegram numeric User ID (@userinfobot)'
  }
  $useUserId = ([string]$useUserId).Trim()
  if ($useUserId -notmatch '^[0-9]+(,[0-9]+)*$') {
    throw ("User ID must be numeric (comma-separated ok), got: '" + $useUserId + "'")
  }
  $useUserId = ($useUserId -replace '\s+', '')

  Write-Step 'Write user environment variables'
  Set-UserEnv 'DSH_TELEGRAM_TOKEN' $useToken
  Set-UserEnv 'DSH_TELEGRAM_ALLOWED_USER_IDS' $useUserId
  Write-Host ('DSH_TELEGRAM_TOKEN = (set, length ' + $useToken.Length + ')')
  Write-Host ('DSH_TELEGRAM_ALLOWED_USER_IDS = ' + $useUserId)
  if ($NoPersist) {
    Write-Warn2 '(-NoPersist: not written to user-level env)'
  }

  $profileDir = Get-ProfileDir
  Write-Step 'Ensure pnpm allowBuilds'
  Ensure-AllowBuilds $profileDir

  $installSource = $Source
  if ($Local) {
    $scriptRoot = $PSScriptRoot
    if (-not $scriptRoot -and $MyInvocation.MyCommand.Path) {
      $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if (-not $scriptRoot) {
      throw 'Cannot use -Local with remote irm|iex. git clone first, then run local script.'
    }
    $installSource = (Resolve-Path (Join-Path $scriptRoot '..')).Path
  }

  Write-Step ('Install plugin: dsh plugin --profile ' + $ProfileName + ' add ' + $installSource)
  & dsh plugin --profile $ProfileName add $installSource
  if ($LASTEXITCODE -ne 0) {
    throw ('dsh plugin add failed (exit=' + $LASTEXITCODE + '). Try: dsh plugin --profile ' + $ProfileName + ' remove dsh-telegram-channel')
  }

  Write-Ok 'Install complete.'
  Write-Host 'Next: choose 2 to start dsh web -> open a Web chat -> phone /sessions'
}

function Invoke-Start {
  Ensure-Command 'dsh'
  $listen = @(Get-ListenPids $Port)
  if ($listen.Count -gt 0) {
    Write-Warn2 ('Already running: http://127.0.0.1:' + $Port + ' (PID ' + ($listen -join ', ') + ')')
    Write-Host 'To restart: choose 3 (stop), then 2 (start).'
    return
  }

  $token = Get-UserEnv 'DSH_TELEGRAM_TOKEN'
  $allow = Get-UserEnv 'DSH_TELEGRAM_ALLOWED_USER_IDS'
  if (-not $token) { Write-Warn2 'Warning: DSH_TELEGRAM_TOKEN not set; bot may not poll.' }
  if (-not $allow) { Write-Warn2 'Warning: DSH_TELEGRAM_ALLOWED_USER_IDS not set; all users denied.' }

  Write-Step 'Start dsh web in a new window (close that window to stop)'
  $lines = @(
    "`$env:DSH_TELEGRAM_TOKEN = [Environment]::GetEnvironmentVariable('DSH_TELEGRAM_TOKEN','User')"
    "`$env:DSH_TELEGRAM_ALLOWED_USER_IDS = [Environment]::GetEnvironmentVariable('DSH_TELEGRAM_ALLOWED_USER_IDS','User')"
    "if (-not `$env:DSH_TELEGRAM_TOKEN) { `$env:DSH_TELEGRAM_TOKEN = [Environment]::GetEnvironmentVariable('DSH_TELEGRAM_TOKEN','Process') }"
    "if (-not `$env:DSH_TELEGRAM_ALLOWED_USER_IDS) { `$env:DSH_TELEGRAM_ALLOWED_USER_IDS = [Environment]::GetEnvironmentVariable('DSH_TELEGRAM_ALLOWED_USER_IDS','Process') }"
    "Write-Host 'dsh-telegram-channel: starting dsh web ...' -ForegroundColor Cyan"
    "Write-Host ('Token length: ' + (`$env:DSH_TELEGRAM_TOKEN + '').Length)"
    "Write-Host ('Allow IDs: ' + `$env:DSH_TELEGRAM_ALLOWED_USER_IDS)"
    "dsh web"
  )
  $psCommand = $lines -join '; '
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoExit',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $psCommand
  ) | Out-Null

  Write-Host 'New window opened. Waiting for port...'
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Get-ListenPids $Port).Count -gt 0) {
      $ok = $true
      break
    }
  }
  if ($ok) {
    Write-Ok ('Started: http://127.0.0.1:' + $Port)
  } else {
    Write-Warn2 'Port not listening yet. Check the new window for errors.'
  }
}

function Invoke-Stop {
  Write-Step ('Stop dsh web (port ' + $Port + ')')
  $pids = @()
  $pids += Get-ListenPids $Port
  $pids += Get-DshWebPids
  $pids = @($pids | Where-Object { $_ -gt 0 } | Select-Object -Unique)

  if ($pids.Count -eq 0) {
    Write-Warn2 'No running dsh web found.'
    return
  }

  foreach ($procId in $pids) {
    try {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $name = if ($p) { $p.ProcessName } else { '?' }
      Write-Host ('Kill PID ' + $procId + ' (' + $name + ')')
      Stop-Process -Id $procId -Force -ErrorAction Stop
    } catch {
      Write-Warn2 ('Cannot kill PID ' + $procId + ': ' + $_.Exception.Message)
    }
  }

  Start-Sleep -Seconds 1
  $left = @(Get-ListenPids $Port)
  if ($left.Count -eq 0) {
    Write-Ok 'Stopped.'
  } else {
    Write-Warn2 ('Port still in use: PID ' + ($left -join ', '))
  }
}

function Invoke-Open {
  $url = ('http://127.0.0.1:' + $Port)
  $listen = @(Get-ListenPids $Port)
  if ($listen.Count -eq 0) {
    Write-Warn2 'Service not running. Choose 2 to start first.'
    return
  }
  Start-Process $url
  Write-Ok ('Opened ' + $url)
}

function Show-Menu {
  Write-Host ''
  Write-Host '========================================' -ForegroundColor Green
  Write-Host '  dsh-telegram-channel  manager' -ForegroundColor Green
  Write-Host '========================================' -ForegroundColor Green
  Write-Host ('  profile = ' + $ProfileName + '    port = ' + $Port)
  Write-Host ''
  Write-Host '  1) Install / reinstall plugin (Token + allowlist)'
  Write-Host '  2) Start dsh web (new window)'
  Write-Host '  3) Stop dsh web'
  Write-Host '  4) Status'
  Write-Host '  5) Open browser'
  Write-Host '  0) Exit'
  Write-Host ''
}

function Invoke-MenuLoop {
  while ($true) {
    Show-Menu
    $choice = Read-Host 'Enter number'
    switch ($choice.Trim()) {
      '1' { try { Invoke-Install } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
      '2' { try { Invoke-Start } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
      '3' { try { Invoke-Stop } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
      '4' { try { Show-Status } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
      '5' { try { Invoke-Open } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
      '0' { Write-Host 'Bye.'; return }
      ''  { continue }
      default { Write-Warn2 ('Invalid option: ' + $choice) }
    }
  }
}

if (-not $Action) {
  if ($PSBoundParameters.ContainsKey('Token') -or $PSBoundParameters.ContainsKey('UserId') -or $Local) {
    $Action = 'install'
  } else {
    $Action = 'menu'
  }
}

switch ($Action) {
  'menu' { Invoke-MenuLoop }
  'install' { Invoke-Install }
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'status' { Show-Status }
  'open' { Invoke-Open }
  default { throw ('Unknown Action: ' + $Action) }
}
} @args
