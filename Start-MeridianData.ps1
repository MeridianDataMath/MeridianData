<#
.SYNOPSIS
    Serves the MeridianData site on http://localhost:<port>/ and opens it in the browser.

.DESCRIPTION
    Tiny static file server (System.Net.HttpListener, no admin rights needed for localhost).
    The site itself is plain HTML/JS and talks directly to the public Meridian API from the
    browser, so nothing else runs on this machine.

    Only the files the site is made of are served (index.html, css/, js/, vendor/, assets/, data/, cards/, a/, p/ and
    the copy agent's download files); everything else in the checkout (.git, logs, scripts, and the copy agent's
    signer.key and config.json if it was ever run from agent/) answers 404. Requests from other machines are refused,
    and every answer carries the production headers from the /* block of _headers, Content-Security-Policy included.

.PARAMETER Port       TCP port to listen on (default 8787).
.PARAMETER NoBrowser  Do not open the default browser.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Start-MeridianData.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'; '.mjs' = 'application/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'; '.svg' = 'image/svg+xml'; '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'
    '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.txt' = 'text/plain; charset=utf-8'
}

# What deploys (mirrors dist/ in .github/workflows/pages.yml). The copy agent writes signer.key, config.json and
# state.json next to itself, and this origin renders third-party text, so nothing outside this list may be reachable.
$allowDirs = @('css', 'js', 'vendor', 'assets', 'data', 'cards', 'a', 'p')
$allowFiles = @('index.html', 'agent/copy-agent.mjs', 'agent/package.json', 'agent/package-lock.json', 'agent/config.example.json')
$denyPrefix = @('data/cache/')   # the snapshot builder's own price cache, not part of the site

# The production headers: the /* block of _headers, read at start so the two cannot drift apart.
$siteHeaders = [ordered]@{}
$headersFile = Join-Path $root '_headers'
if (Test-Path -LiteralPath $headersFile -PathType Leaf) {
    $inAll = $false
    foreach ($line in [IO.File]::ReadAllLines($headersFile)) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -match '^\S') { $inAll = ($line.Trim() -eq '/*'); continue }   # a path line starts the next block
        if ($inAll -and $line -match '^\s+([A-Za-z0-9-]+):\s*(.+?)\s*\z') { $siteHeaders[$Matches[1]] = $Matches[2] }
    }
}
if (-not $siteHeaders.Contains('Content-Security-Policy')) { Write-Warning "No Content-Security-Policy found in $headersFile" }

# The site file a request path names, or $null. The path is taken as it was sent (RawUrl), decoded once, and every
# segment must be a plain file name: that alone rules out '..', dotfiles, encoded or doubly encoded forms, backslashes,
# drive letters and ':' streams, empty segments ('//'), trailing dots and DOS device names.
function Resolve-SiteFile([string]$rawUrl) {
    $p = ($rawUrl -split '[?#]', 2)[0]
    if (-not $p.StartsWith('/')) { return $null }   # absolute-form or '*' request targets
    try { $p = [Uri]::UnescapeDataString($p) } catch { return $null }
    if ($p -eq '/') { $p = '/index.html' }
    $segs = $p.Substring(1).Split('/')
    foreach ($s in $segs) {
        if ($s -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?\z') { return $null }
        if ($s -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|\z)') { return $null }
    }
    $rel = $segs -join '/'
    if (-not (($allowFiles -contains $rel) -or ($segs.Count -gt 1 -and $allowDirs -contains $segs[0]))) { return $null }
    foreach ($d in $denyPrefix) { if ($rel.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $null } }
    $file = [IO.Path]::GetFullPath((Join-Path $root ($rel -replace '/', '\')))
    # a share page is served at /a/<address> without its .html, as in production
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -and -not [IO.Path]::GetExtension($file)) { $file += '.html' }
    if (-not $file.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    # nor may a link inside an allowed folder lead elsewhere
    for ($f = $file; $f.Length -gt $rootFull.Length; $f = [IO.Path]::GetDirectoryName($f)) {
        if (([IO.File]::GetAttributes($f) -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    }
    return $file
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { throw "Could not listen on $prefix - is the port in use? ($($_.Exception.Message))" }
Write-Host ""
Write-Host "  MeridianDataHub  ->  $prefix" -ForegroundColor Cyan
Write-Host "  Serving the site files of $rootFull" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""
if (-not $NoBrowser) { Start-Process $prefix | Out-Null }

try {
    while ($listener.IsListening) {
        $task = $listener.GetContextAsync()
        while (-not $task.Wait(500)) { }   # poll so Ctrl+C is honoured
        $ctx = $task.Result
        $req = $ctx.Request; $res = $ctx.Response
        try {
            foreach ($k in $siteHeaders.Keys) { $res.Headers[$k] = $siteHeaders[$k] }
            $res.Headers['Cache-Control'] = 'no-cache'
            $file = $null; $status = 200
            # http.sys listens on every interface and matches only the Host header, so a machine on the network that
            # sends 'Host: localhost' would reach this loop: only this machine is answered
            if (-not [Net.IPAddress]::IsLoopback($req.RemoteEndPoint.Address)) { $status = 403 }
            elseif ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { $status = 405; $res.Headers['Allow'] = 'GET, HEAD' }
            else { $file = Resolve-SiteFile $req.RawUrl; if (-not $file) { $status = 404 } }
            if ($file) {
                $ct = $mime[[IO.Path]::GetExtension($file).ToLowerInvariant()]; if (-not $ct) { $ct = 'application/octet-stream' }
                $res.ContentType = $ct
                $bytes = [IO.File]::ReadAllBytes($file)
            } else {
                $res.StatusCode = $status
                $res.ContentType = 'text/plain; charset=utf-8'
                $bytes = [Text.Encoding]::UTF8.GetBytes(@{ 403 = '403 - this server answers only this machine'; 405 = '405 - method not allowed'; 404 = '404 - not found' }[$status])
            }
            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
        } catch {
            try { $res.StatusCode = 500 } catch { }
        } finally {
            try { $res.OutputStream.Close() } catch { }
        }
    }
} finally {
    $listener.Stop(); $listener.Close()
    Write-Host 'MeridianData stopped.'
}
