<#
.SYNOPSIS
    Serves the MeridianData site on http://localhost:<port>/ and opens it in the browser.

.DESCRIPTION
    Tiny static file server (System.Net.HttpListener, no admin rights needed for localhost).
    The site itself is plain HTML/JS and talks directly to the public Meridian API from the
    browser, so nothing else runs on this machine.

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
    '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.svg' = 'image/svg+xml'; '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
    '' = 'text/plain; charset=utf-8'
}
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { throw "Could not listen on $prefix - is the port in use? ($($_.Exception.Message))" }
Write-Host ""
Write-Host "  MeridianDataHub  ->  $prefix" -ForegroundColor Cyan
Write-Host "  Serving $rootFull" -ForegroundColor DarkGray
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
            $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
            if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
            $file = [IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/') -replace '/', '\')))
            if (-not $file.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $file -PathType Leaf)) {
                $res.StatusCode = 404
                $bytes = [Text.Encoding]::UTF8.GetBytes("404 - not found: $path")
                $res.ContentType = 'text/plain; charset=utf-8'
            } else {
                $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
                $ct = $mime[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
                $res.ContentType = $ct
                $res.Headers['Cache-Control'] = 'no-cache'
                $bytes = [IO.File]::ReadAllBytes($file)
            }
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
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
