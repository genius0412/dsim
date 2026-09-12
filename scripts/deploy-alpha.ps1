<#
.SYNOPSIS
  Deploy the ALPHA preview server to Fly from Windows PowerShell. Production is never touched.

.DESCRIPTION
  A launcher, not a second deploy script. The deploy itself still runs through
  scripts/fly-deploy.sh --alpha, which is the single source of truth for how this app is
  deployed (config pinning, --ha=false, the satellite re-shrink on the production path).
  Duplicating those flags here would create a second thing to forget to update.

  What this adds on top is everything that stands between a Windows shell and that script:

    1. cwd       - runs from the repo root no matter where the shell happens to be.
    2. bash      - a .sh is not executable from PowerShell; Git Bash runs it.
    3. flyctl    - installs it via winget when missing.
    4. `fly`     - the deploy script calls `fly`; some flyctl builds ship only `flyctl.exe`.
                   A tiny shim bridges that without touching the repo or the real PATH.
    5. login     - opens the browser for Fly's own sign-in (GitHub SSO) when not signed in.
                   Credentials are entered on fly.io and stored by flyctl; this script never
                   sees, reads, or stores them.
    6. proof     - after the deploy, checks /health and whether the LAN rendezvous is
                   actually live in the build that just shipped.

.PARAMETER Yes
  Skip the confirmation prompt. The deploy is still alpha-only.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\deploy-alpha.ps1
#>
[CmdletBinding()]
param(
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$App = 'dsim-alpha'

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "!! $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "!! $m" -ForegroundColor Red; exit 1 }

# --- 0. the repo -----------------------------------------------------------------------
# The error you hit was this and nothing more exotic: the shell was one directory above the
# repo, so there was no ./scripts to find. Anchor to the script's own location instead.
if (-not (Test-Path (Join-Path $RepoRoot 'fly.alpha.toml'))) {
  Die "fly.alpha.toml not found under $RepoRoot - is this script still inside the repo?"
}
Set-Location $RepoRoot
Say "repo: $RepoRoot"

# --- 1. bash ---------------------------------------------------------------------------
$Bash = $null
foreach ($c in @(
    (Get-Command bash -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe',
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
  if ($c -and (Test-Path $c)) { $Bash = $c; break }
}
if (-not $Bash) { Die 'Git Bash not found. Install Git for Windows, then re-run.' }
Say "bash: $Bash"

# --- 2. flyctl -------------------------------------------------------------------------
# Look for either name. Fly's own installer and the winget package have not always agreed on
# which executables land on PATH, so neither name is assumed.
function Find-Flyctl {
  foreach ($n in 'fly', 'flyctl') {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  foreach ($p in @(
      "$env:USERPROFILE\.fly\bin\flyctl.exe",
      "$env:USERPROFILE\.fly\bin\fly.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\flyctl.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\fly.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$Fly = Find-Flyctl
if (-not $Fly) {
  Say 'flyctl is not installed - installing from winget (Fly-io.flyctl)'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die 'winget is unavailable. Install flyctl manually from https://fly.io/docs/flyctl/install/ and re-run.'
  }
  winget install --id Fly-io.flyctl --exact --source winget --accept-source-agreements --accept-package-agreements
  # winget adds the shim directory to the PERSISTED PATH, which this already-running process
  # does not see. Re-read both scopes rather than telling you to open a new terminal.
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('PATH', 'User')
  $Fly = Find-Flyctl
  if (-not $Fly) { Die 'flyctl installed but still not on PATH. Open a new terminal and re-run this script.' }
}
Say "flyctl: $Fly"

# --- 3. a `fly` the bash script can call -----------------------------------------------
# fly-deploy.sh invokes `fly`. If only flyctl.exe exists, write a one-line shim into a
# throwaway directory and put it first on PATH for this process only. Nothing installed,
# nothing in the repo, no change to your real PATH.
$FlyDir = Split-Path -Parent $Fly
if (-not (Test-Path (Join-Path $FlyDir 'fly.exe'))) {
  $ShimDir = Join-Path $env:LOCALAPPDATA 'dsim-fly-shim'
  if (-not (Test-Path $ShimDir)) { New-Item -ItemType Directory -Path $ShimDir | Out-Null }
  # Extensionless + shebang: Git Bash resolves this as `fly`; Windows never runs it.
  $shim = "#!/usr/bin/env sh`nexec `"$($Fly -replace '\\', '/')`" `"`$@`"`n"
  [IO.File]::WriteAllText((Join-Path $ShimDir 'fly'), $shim)
  $env:PATH = "$ShimDir;$env:PATH"
  Say "shimmed `fly` -> flyctl for this run"
}
$env:PATH = "$FlyDir;$env:PATH"

# --- 4. credentials --------------------------------------------------------------------
# `fly auth login` opens fly.io in your browser. You sign in there (GitHub SSO, since your
# access is linked to GitHub) and flyctl stores the token in ~/.fly/config.yml. This script
# does not handle the password, the token, or anything else.
#
# NOTE: Windows PowerShell 5.1 turns `2>&1` on a NATIVE exe into a TERMINATING
# NativeCommandError the moment that exe writes anything to stderr - whatever its exit code
# is, and before $LASTEXITCODE can be tested. Under $ErrorActionPreference='Stop' that killed
# this script on `fly auth whoami` printing "no access token available", which is not a
# failure at all: it is the not-signed-in answer this check exists to detect, and the branch
# it should have taken was the one that runs `fly auth login`. So every native call goes
# through this helper, which drops the preference for the duration and hands back an exit
# code to test explicitly.
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [switch]$Interactive)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Interactive) {
      # A browser login and a deploy both need their output to reach the terminal live, so
      # these are not captured - which also means there is no redirection to go wrong.
      & $Exe @Arguments
      return [pscustomobject]@{ Code = $LASTEXITCODE; Text = '' }
    }
    $text = (& $Exe @Arguments 2>&1 | Out-String)
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = $text }
  } finally { $ErrorActionPreference = $prev }
}

$auth = Invoke-Native $Fly @('auth', 'whoami')
if ($auth.Code -ne 0) {
  Say 'not signed in to Fly - opening your browser to sign in'
  $login = Invoke-Native $Fly @('auth', 'login') -Interactive
  if ($login.Code -ne 0) { Die 'fly auth login failed or was cancelled.' }
  $auth = Invoke-Native $Fly @('auth', 'whoami')
  if ($auth.Code -ne 0) { Die "still not signed in after login: $($auth.Text.Trim())" }
}
Say "signed in as: $($auth.Text.Trim())"

# Being signed in is not the same as having access to THIS app. Check before building.
$st = Invoke-Native $Fly @('status', '-a', $App)
if ($st.Code -ne 0) {
  Die "signed in, but '$App' is not reachable from this account - confirm you were added to the org that owns it.`n$($st.Text.Trim())"
}

# --- 4b. the network path to Fly -------------------------------------------------------
# A deploy that dies on `Get "https://api.machines.dev/...": unexpected EOF` looks like Fly
# being down and is usually neither Fly nor this repo: it is a DUAL-STACK host whose IPv6
# route to Fly drops the TLS handshake. Measured here on 2026-09-12 - HTTPS over IPv6 to
# Google and Cloudflare was fine, while api.fly.io over IPv6 failed 4 attempts in 5, every
# failure a 5s timeout AFTER a successful TCP connect. That ordering is the whole problem:
# Happy Eyeballs only races the CONNECT, so a v6 socket that opens and then stalls in TLS is
# never retried over v4 by curl, by Go, or therefore by flyctl.
#
# This only reports. Preferring IPv4 is a machine-wide network setting and needs elevation,
# so the command is printed for you to run rather than run behind your back.
function Test-FlyPath {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path $curl)) { return $null }
  $probe = {
    param($family)
    $ok = 0
    foreach ($i in 1..3) {
      $code = (& $curl -s $family -o NUL -w '%{http_code}' --max-time 10 'https://api.fly.io/' 2>$null)
      if ($code -and $code -ne '000') { $ok++ }
    }
    return $ok
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return [pscustomobject]@{ V4 = (& $probe '-4'); V6 = (& $probe '-6') } }
  finally { $ErrorActionPreference = $prev }
}

$path = Test-FlyPath
if ($path -and $path.V4 -ge 2 -and $path.V6 -le 1) {
  Write-Host ''
  Warn "IPv6 to Fly is unreliable here: api.fly.io answered $($path.V4)/3 over IPv4 but only $($path.V6)/3 over IPv6."
  Warn 'flyctl prefers IPv6 and does not fall back once TLS stalls, so a deploy will likely fail'
  Warn 'with "unexpected EOF" or "context canceled". Prefer IPv4 in an ADMIN PowerShell:'
  Write-Host ''
  Write-Host '    netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 100 4' -ForegroundColor White
  Write-Host ''
  Write-Host '  and afterwards put it back with:' -ForegroundColor White
  Write-Host ''
  Write-Host '    netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 35 4' -ForegroundColor White
  Write-Host ''
  Write-Host '  It takes effect immediately, needs no reboot, and changes preference ORDER only -' -ForegroundColor White
  Write-Host '  IPv6 still works for anything with no IPv4 address.' -ForegroundColor White
  Write-Host ''
  if (-not $Yes) {
    $go = Read-Host 'Deploy anyway? [y/N]'
    if ($go -notmatch '^[Yy]') { Warn 'stopped - nothing was deployed.'; exit 1 }
  }
} elseif ($path) {
  Say "network to Fly: IPv4 $($path.V4)/3, IPv6 $($path.V6)/3"
}

# --- 5. confirm ------------------------------------------------------------------------
Write-Host ''
Write-Host "About to deploy the ALPHA preview app '$App' from fly.alpha.toml." -ForegroundColor White
Write-Host 'Production (dohun-sim-decode) is NOT touched by this script.' -ForegroundColor White
Write-Host 'This ships the LAN rendezvous to alpha, where LAN_SIGNALLING and LAN_UPLOADS are on.' -ForegroundColor White
Write-Host ''
if (-not $Yes) {
  $ans = Read-Host 'Type "deploy" to continue'
  if ($ans -ne 'deploy') { Warn 'cancelled - nothing was deployed.'; exit 1 }
}

# --- 6. the actual deploy --------------------------------------------------------------
Say 'running scripts/fly-deploy.sh --alpha'
$dep = Invoke-Native $Bash @('./scripts/fly-deploy.sh', '--alpha') -Interactive
if ($dep.Code -ne 0) { Die "deploy exited $($dep.Code) - check it with: fly machine list -a $App" }

# --- 7. proof --------------------------------------------------------------------------
# A green deploy is not proof the thing you deployed FOR is live, so check the two facts
# that actually matter: the server answers, and it is running the build you just pushed.
Say 'verifying'
try {
  $health = (Invoke-WebRequest -Uri "https://$App.fly.dev/health" -UseBasicParsing -TimeoutSec 30).Content.Trim()
  Write-Host "    /health       -> $health"
} catch {
  Warn "/health did not answer: $($_.Exception.Message)"
}
# A 200 on /health only says a process is up. It answers the literal string "ok" and this
# server has no version route, so it cannot tell you WHICH build is running - which is
# exactly how alpha sat serving healthy 200s from an image that predated the rendezvous
# entirely. /version.json is a VERCEL route, not one of this server's; asking Fly for it
# returns 426 Upgrade Required, because every path here except /health wants a WebSocket
# upgrade. So check the feature by speaking its own protocol instead.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $ping = Invoke-Native $node.Source @('scripts/lanping.mjs', "wss://$App.fly.dev")
  Write-Host $ping.Text.Trim()
  if ($ping.Code -ne 0) {
    Warn 'the rendezvous did NOT answer - this build may not contain it. Re-check before handing the URL to anyone.'
  } else {
    Say 'the LAN rendezvous is live on this server'
  }
} else {
  Warn 'node not found - skipped the rendezvous check. Run it yourself:'
  Write-Host "    node scripts/lanping.mjs wss://$App.fly.dev" -ForegroundColor White
}

Write-Host ''
Say 'server done. The LAN screen is still hidden on alpha.playdsim.com until the CLIENT flag is set:'
Write-Host '    Vercel -> the alpha project -> Settings -> Environment Variables' -ForegroundColor White
Write-Host '    add  VITE_LAN_ENABLED = 1   scoped to the `alpha` branch only (NOT Production)' -ForegroundColor White
Write-Host '    then redeploy alpha.' -ForegroundColor White
Write-Host ''
Write-Host 'Without it Vite tree-shakes the whole LAN screen out of the bundle.' -ForegroundColor White
