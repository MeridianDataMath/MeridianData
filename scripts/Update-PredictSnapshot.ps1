<#
.SYNOPSIS
    Builds the Meridian Predict snapshot on this PC and publishes it to the repo's "snapshots" branch.

.DESCRIPTION
    The Predict API (api.predict.meridian.xyz) answers 403 to datacenter IPs, so GitHub Actions cannot
    build data/predict.json. This script runs on a normal PC instead:

      1. node scripts/build-snapshot.mjs --predict --out <temp>   (all predictions since launch, paced
         under the API's 200 requests/minute; about 2-3 minutes)
      2. publishes predict.json as a brand-new single-commit branch "snapshots" (force-pushed, no parent),
         so the repository's history never grows: only the latest snapshot is ever kept.
      3. the site reads https://raw.githubusercontent.com/<owner>/<repo>/snapshots/predict.json and the
         GitHub Pages build copies the same file into data/ on its next run.

    Needs git (with cached GitHub credentials) and node.exe — either on PATH or the portable copy in
    ..\tools\node next to the repo. Log: logs\snapshot.log. Install the schedule with Install-SnapshotTask.ps1.

.PARAMETER DryRun        Build only; do not push.
.PARAMETER PublishOnly   Skip the build and publish the existing data\predict.json.
#>
[CmdletBinding()]
param([switch]$DryRun, [switch]$PublishOnly)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # PS 5.1 pipes a BOM to native commands otherwise (breaks git mktree)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $Repo 'logs'; if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogPath = Join-Path $LogDir 'snapshot.log'
function Log([string]$m) { $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Host $line; try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {} }

# single instance
$mutex = New-Object System.Threading.Mutex($false, 'Local\MeridianDataPredictSnapshot')
if (-not $mutex.WaitOne(0)) { Log 'another run is still going; exiting'; exit 0 }
try {
    # locate node
    $node = $null
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
    foreach ($cand in @((Join-Path (Split-Path -Parent $Repo) 'tools\node\node.exe'), (Join-Path $Repo 'tools\node\node.exe'))) { if (-not $node -and (Test-Path $cand)) { $node = $cand } }
    if (-not $node) { throw 'node.exe not found (PATH or ..\tools\node\node.exe)' }

    # keep the checkout current so the builder uses the latest code (never fails the run)
    Set-Location $Repo
    try { git pull --ff-only --quiet 2>$null | Out-Null } catch { Log "git pull skipped: $($_.Exception.Message)" }

    $dataDir = Join-Path $Repo 'data'; if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    $tmp = $null
    if ($PublishOnly) {
        $file = Join-Path $dataDir 'predict.json'
        $j = Get-Content $file -Raw | ConvertFrom-Json
        if (-not $j.agg) { throw 'data\predict.json has no data' }
        Log ('publishing existing snapshot: {0} predictions' -f $j.predictions)
    } else {
        $tmp = Join-Path $env:TEMP ('md-snapshot-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        Log "building predict snapshot with $node"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $node (Join-Path $ScriptDir 'build-snapshot.mjs') --predict --out $tmp 2>&1 | ForEach-Object { Log ('  ' + $_) }
        if ($LASTEXITCODE -ne 0) { throw "builder exited with $LASTEXITCODE" }
        $file = Join-Path $tmp 'predict.json'
        $j = Get-Content $file -Raw | ConvertFrom-Json
        if (-not $j.agg) { throw "snapshot has no data: $($j.error)" }
        Log ('built: {0} predictions, {1} bettors, {2} makers, {3} KB, {4:N0}s' -f $j.predictions, $j.agg.bettors.Count, $j.agg.makers.Count, [math]::Round((Get-Item $file).Length / 1024), $sw.Elapsed.TotalSeconds)
        Copy-Item $file (Join-Path $dataDir 'predict.json') -Force   # local copy for development
        $bettorsSrc = Join-Path $tmp 'bettors'
        if (Test-Path $bettorsSrc) { $bettorsDst = Join-Path $dataDir 'bettors'; if (Test-Path $bettorsDst) { [IO.Directory]::Delete($bettorsDst, $true) }; Copy-Item $bettorsSrc $bettorsDst -Recurse }
    }
    $srcDir = if ($PublishOnly) { $dataDir } else { $tmp }

    if ($DryRun) { Log 'dry run: not publishing'; exit 0 }

    # publish the whole snapshot directory (predict.json + bettors/*.json) as a fresh single-commit branch:
    # a temporary index turns the directory into a tree without touching the working copy; no history growth.
    $idx = Join-Path $env:TEMP ('md-index-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $env:GIT_INDEX_FILE = $idx
    $gitDir = Join-Path $Repo '.git'
    & cmd /c "git --git-dir=`"$gitDir`" --work-tree=`"$srcDir`" add -A -- predict.json bettors 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git add (temp index) failed' }
    $tree = (& cmd /c "git --git-dir=`"$gitDir`" write-tree").Trim()
    Remove-Item Env:GIT_INDEX_FILE
    [IO.File]::Delete($idx)
    if (-not $tree) { throw 'git write-tree failed' }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + ' UTC'
    $msg = ('Predict snapshot {0} ({1} predictions)' -f $stamp, $j.predictions)
    $commit = (git -c user.name=MeridianDataMath -c user.email=MeridianDataMath@users.noreply.github.com commit-tree $tree -m $msg).Trim()
    if (-not $commit) { throw 'git commit-tree failed' }
    $env:GIT_TERMINAL_PROMPT = '0'
    # via cmd so git's informational stderr ("remote: ...") is not turned into a PowerShell error
    $push = & cmd /c "git push --force --quiet origin ${commit}:refs/heads/snapshots 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "git push failed: $push" }
    Log "published snapshots branch @ $($commit.Substring(0, 8))"
    if ($tmp) { [IO.Directory]::Delete($tmp, $true) }
} catch {
    Log "FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
