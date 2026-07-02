$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $appDir

function Test-PortAvailable {
    param([int]$Port)

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Parse("127.0.0.1"),
            $Port
        )
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "This app needs Node.js. Please install Node.js 20+ first:" -ForegroundColor Yellow
    Write-Host "https://nodejs.org/" -ForegroundColor Cyan
    Read-Host "Press Enter to close"
    exit 1
}

$port = $null
foreach ($candidate in 5173..5199) {
    if (Test-PortAvailable -Port $candidate) {
        $port = $candidate
        break
    }
}

if (-not $port) {
    Write-Host "No available local port found between 5173 and 5199." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

$escapedAppDir = $appDir.Replace("'", "''")
$serverCommand = @"
`$env:PORT = '$port'
`$env:HOST = '127.0.0.1'
Set-Location -LiteralPath '$escapedAppDir'
node server.js
"@

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $serverCommand) `
    -WindowStyle Minimized | Out-Null

Start-Sleep -Milliseconds 900

$url = "http://127.0.0.1:$port"
Start-Process $url
Write-Host "Voice Polisher opened at $url" -ForegroundColor Green
