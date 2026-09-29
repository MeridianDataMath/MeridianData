<#
.SYNOPSIS
    Builds the Meridian Predict snapshot on this PC and publishes it to the repo's "snapshots" branch.

.DESCRIPTION
    The Predict API (api.predict.meridian.xyz) answers 403 to datacenter IPs, so GitHub Actions cannot
    build data/predict.json. This script runs on a normal PC instead:

      1. node scripts/build-snapshot.mjs --predict --out <temp>   (all predictions since launch, paced
         under the API's 200 requests/minute; about 2-3 minutes)
      2. checks the result (Test-Snapshot below): the push replaces the only published snapshot, so a short or
         incomplete build is logged and dropped instead
      3. publishes predict.json, predict-status.json, predict-ideas.json, bettors/, questions/ and slips/ as a brand-new single-commit branch
         "snapshots" (force-pushed, no parent), so the repository's history never grows: only the latest snapshot
         is ever kept.
      4. triggers the deploy workflow, which copies those files into data/ on the site.

    It runs this checkout's code as it is and never pulls: a hidden task that pulled and ran origin/main every
    30 minutes would give anyone who can push to main code execution on this PC. Update the checkout by hand
    (git pull) after reading what changed.

    Needs git (with cached GitHub credentials) and node.exe — either on PATH or the portable copy in
    ..\tools\node next to the repo. Log: logs\snapshot.log. Install the schedule with Install-SnapshotTask.ps1.

.PARAMETER DryRun        Build and check only; do not push.
.PARAMETER PublishOnly   Skip the build and publish the existing data\predict.json (after the same checks).
.PARAMETER Force         Skip the two prediction-count checks, for one run when a drop is real (the API removed
                         predictions); the snapshot must still be complete.
#>
[CmdletBinding()]
param([switch]$DryRun, [switch]$PublishOnly, [switch]$Force)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # PS 5.1 pipes a BOM to native commands otherwise (breaks git mktree)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $ScriptDir
$gitDir = Join-Path $Repo '.git'
$LogDir = Join-Path $Repo 'logs'; if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogPath = Join-Path $LogDir 'snapshot.log'
function Log([string]$m) { $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Host $line; try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {} }

# The push replaces the only published snapshot (no history is kept) and the deploy follows at once, so a build that is
# well-formed but short (an indexer resync, pages missing under a partial GraphQL answer) or missing files must never get
# there. Returns why not, or $null when the snapshot in $dir looks whole.
function Test-Snapshot([string]$dir, $j) {
    if (-not $j -or -not $j.agg) { return 'predict.json has no data' + $(if ($j -and $j.error) { ': ' + $j.error } else { '' }) }
    $n = [int]$j.predictions
    if ($n -le 0 -or @($j.agg.bettors).Count -le 0) { return "empty snapshot ($n predictions, $(@($j.agg.bettors).Count) bettors)" }
    if (-not $Force) {
        # the API's own count at build time (the builder takes every prediction since launch: they match exactly)
        $want = [int]$j.apiTotal - [int]$j.preLaunch
        if ($j.apiTotal -and $n -lt 0.98 * $want) { return "only $n of the $want predictions the API counts" }
        # the snapshot this one replaces: the count only grows (a real drop is published once with -Force)
        $prevRaw = & cmd /c "git --git-dir=`"$gitDir`" show refs/remotes/origin/snapshots:predict-status.json 2>nul"
        if ($LASTEXITCODE -eq 0 -and $prevRaw) {
            $prev = $null; try { $prev = ($prevRaw -join "`n") | ConvertFrom-Json } catch {}
            if ($prev -and $prev.predictions -gt 0 -and $n -lt 0.95 * $prev.predictions) { return "$n predictions, the published snapshot has $($prev.predictions) (run once with -Force if the drop is real)" }
        }
    }
    # every wallet and question the snapshot lists has its file (the builder leaves out predictions of malformed wallets)
    foreach ($c in @(@{ sub = 'bettors'; ids = @(@($j.agg.bettors) + @($j.agg.makers) | ForEach-Object { $_.address }) },
                     @{ sub = 'questions'; ids = @($j.questionsWithOi | ForEach-Object { $_.id }) })) {
        $have = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        Get-ChildItem -LiteralPath (Join-Path $dir $c.sub) -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object { [void]$have.Add($_.BaseName) }
        $missing = @($c.ids | Where-Object { -not $have.Contains([string]$_) })
        if ($missing.Count) { return "$($missing.Count) of $($c.ids.Count) $($c.sub) files missing, e.g. $($missing | Select-Object -First 1)" }
    }
    return $null
}

# single instance
$mutex = New-Object System.Threading.Mutex($false, 'Local\MeridianDataPredictSnapshot')
if (-not $mutex.WaitOne(0)) { Log 'another run is still going; exiting'; exit 0 }
$tmp = $null; $idx = $null
try {
    # locate node
    $node = $null
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
    foreach ($cand in @((Join-Path (Split-Path -Parent $Repo) 'tools\node\node.exe'), (Join-Path $Repo 'tools\node\node.exe'))) { if (-not $node -and (Test-Path $cand)) { $node = $cand } }
    if (-not $node) { throw 'node.exe not found (PATH or ..\tools\node\node.exe)' }
    Set-Location $Repo   # no git pull here: see the description
    # leftovers of runs that never got to the cleanup below (the PC shut down mid-build; older versions of this script)
    Get-ChildItem $env:TEMP -Filter 'md-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^md-(snapshot|index)-[0-9a-f]{8}' -and $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
        ForEach-Object { try { if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $true) } else { $_.Delete() } } catch {} }

    $dataDir = Join-Path $Repo 'data'; if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
    if ($PublishOnly) {
        $srcDir = $dataDir
        $j = Get-Content (Join-Path $dataDir 'predict.json') -Raw | ConvertFrom-Json
        $why = Test-Snapshot $srcDir $j; if ($why) { throw "not publishing data\predict.json: $why" }
        Log ('publishing existing snapshot: {0} predictions' -f $j.predictions)
    } else {
        $tmp = Join-Path $env:TEMP ('md-snapshot-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        $srcDir = $tmp
        Log "building predict snapshot with $node"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        # through cmd, like the git calls below: under 'Stop' PowerShell 5.1 turns a native command's first stderr line into
        # a terminating error, and the builder warns on stderr about the failures it tolerates. Its exit code decides.
        & cmd /c "`"$node`" `"$(Join-Path $ScriptDir 'build-snapshot.mjs')`" --predict --out `"$tmp`" 2>&1" | ForEach-Object { Log ('  ' + $_) }
        if ($LASTEXITCODE -ne 0) { throw "builder exited with $LASTEXITCODE" }
        $file = Join-Path $tmp 'predict.json'
        $j = Get-Content $file -Raw | ConvertFrom-Json
        $why = Test-Snapshot $tmp $j; if ($why) { throw "snapshot not published: $why" }
        Log ('built: {0} predictions, {1} bettors, {2} makers, {3} KB, {4:N0}s' -f $j.predictions, $j.agg.bettors.Count, $j.agg.makers.Count, [math]::Round((Get-Item $file).Length / 1024), $sw.Elapsed.TotalSeconds)
        Copy-Item $file (Join-Path $dataDir 'predict.json') -Force   # local copy for development (only of a snapshot that passed)
        $statusFile = Join-Path $tmp 'predict-status.json'; if (Test-Path $statusFile) { Copy-Item $statusFile (Join-Path $dataDir 'predict-status.json') -Force }
        $ideasFile = Join-Path $tmp 'predict-ideas.json'; if (Test-Path $ideasFile) { Copy-Item $ideasFile (Join-Path $dataDir 'predict-ideas.json') -Force }
        $bettorsSrc = Join-Path $tmp 'bettors'
        if (Test-Path $bettorsSrc) { $bettorsDst = Join-Path $dataDir 'bettors'; if (Test-Path $bettorsDst) { [IO.Directory]::Delete($bettorsDst, $true) }; Copy-Item $bettorsSrc $bettorsDst -Recurse }
        $qSrc = Join-Path $tmp 'questions'
        if (Test-Path $qSrc) { $qDst = Join-Path $dataDir 'questions'; if (Test-Path $qDst) { [IO.Directory]::Delete($qDst, $true) }; Copy-Item $qSrc $qDst -Recurse }
        $sSrc = Join-Path $tmp 'slips'
        if (Test-Path $sSrc) { $sDst = Join-Path $dataDir 'slips'; if (Test-Path $sDst) { [IO.Directory]::Delete($sDst, $true) }; Copy-Item $sSrc $sDst -Recurse }
    }

    if ($DryRun) { Log 'dry run: not publishing'; exit 0 }

    # publish the whole snapshot directory (predict.json + predict-status.json + bettors/, questions/ and slips/ *.json) as a
    # fresh single-commit branch: a temporary index turns the directory into a tree without touching the working copy;
    # no history growth.
    $idx = Join-Path $env:TEMP ('md-index-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $env:GIT_INDEX_FILE = $idx
    $parts = @('predict.json', 'bettors', 'questions'); if (Test-Path (Join-Path $srcDir 'predict-status.json')) { $parts += 'predict-status.json' }
    if (Test-Path (Join-Path $srcDir 'slips')) { $parts += 'slips' }   # every prediction by id, for the slip page
    if (Test-Path (Join-Path $srcDir 'predict-ideas.json')) { $parts += 'predict-ideas.json' }   # the Copy trading page's ideas
    & cmd /c "git --git-dir=`"$gitDir`" --work-tree=`"$srcDir`" add -A -- $($parts -join ' ') 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git add (temp index) failed' }
    $tree = (& cmd /c "git --git-dir=`"$gitDir`" write-tree").Trim()
    Remove-Item Env:GIT_INDEX_FILE
    if (-not $tree) { throw 'git write-tree failed' }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + ' UTC'
    $msg = ('Predict snapshot {0} ({1} predictions)' -f $stamp, $j.predictions)
    # commit dates in UTC so the branch carries no local-timezone hint
    $utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') + '+0000'
    $env:GIT_AUTHOR_DATE = $utc; $env:GIT_COMMITTER_DATE = $utc
    $commit = (git -c user.name=MeridianDataMath -c user.email=MeridianDataMath@users.noreply.github.com commit-tree $tree -m $msg).Trim()
    if (-not $commit) { throw 'git commit-tree failed' }
    $env:GIT_TERMINAL_PROMPT = '0'
    # via cmd so git's informational stderr ("remote: ...") is not turned into a PowerShell error
    $push = & cmd /c "git push --force --quiet origin ${commit}:refs/heads/snapshots 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "git push failed: $push" }
    Log "published snapshots branch @ $($commit.Substring(0, 8))"
    # The site only carries this snapshot once the deploy workflow has run. Its own schedule (every 30 minutes,
    # and GitHub often runs cron late) would leave the snapshot 20-50 minutes old on the site, so trigger the
    # workflow now with the same GitHub credential git just pushed with (Git Credential Manager).
    try {
        # (through a file and cmd: a PowerShell pipe into git leaves it "missing protocol field")
        $credIn = Join-Path $env:TEMP ('md-gitcred-' + [guid]::NewGuid().ToString('N') + '.txt')
        [IO.File]::WriteAllText($credIn, "protocol=https`nhost=github.com`n`n")
        try { $cred = & cmd /c "git credential fill < `"$credIn`" 2>nul" } finally { Remove-Item $credIn -Force -ErrorAction SilentlyContinue }
        $token = ($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1) -replace '^password=', ''
        if ($token) {
            $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://api.github.com/repos/MeridianDataMath/MeridianData/actions/workflows/pages.yml/dispatches' `
                -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ContentType 'application/json' -Body '{"ref":"main"}' -TimeoutSec 30
            Log "deploy workflow triggered (HTTP $($r.StatusCode))"
        } else { Log 'deploy not triggered: no GitHub credential from git credential fill; the 30-minute schedule will pick the snapshot up' }
    } catch { Log "deploy not triggered ($($_.Exception.Message)); the 30-minute schedule will pick the snapshot up" }
} catch {
    Log "FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    # failed runs too: the build folder (tens of MB of wallet files) and the temporary index (git may leave its .lock)
    if ($idx) { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue; foreach ($f in @($idx, "$idx.lock")) { try { [IO.File]::Delete($f) } catch {} } }
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { try { [IO.Directory]::Delete($tmp, $true) } catch { Log "temp folder not removed: $tmp ($($_.Exception.Message))" } }
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
