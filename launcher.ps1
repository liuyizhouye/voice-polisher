$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostAddress = "127.0.0.1"

function Show-Message {
    param(
        [string]$Text,
        [string]$Title = "Voice Polisher"
    )

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Text, 0, $Title, 48) | Out-Null
    }
    catch {
        Write-Host $Text
    }
}

function Test-PortAvailable {
    param([int]$Port)

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Parse($hostAddress),
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

function Find-AvailablePort {
    foreach ($candidate in 5173..5199) {
        if (Test-PortAvailable -Port $candidate) {
            return $candidate
        }
    }

    return $null
}

function Find-Browser {
    $commandNames = @("msedge.exe", "chrome.exe")

    foreach ($name in $commandNames) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and (Test-Path -LiteralPath $command.Source)) {
            return $command.Source
        }
    }

    $candidatePaths = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
        "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
    )

    foreach ($path in $candidatePaths) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }

    return $null
}

function Start-HiddenServer {
    param(
        [string]$NodePath,
        [int]$Port
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.Arguments = "server.js"
    $startInfo.WorkingDirectory = $appDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables["PORT"] = [string]$Port
    $startInfo.EnvironmentVariables["HOST"] = $hostAddress

    return [System.Diagnostics.Process]::Start($startInfo)
}

function Wait-ForServer {
    param(
        [string]$HostAddress,
        [int]$Port
    )

    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $client = $null
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $client.Connect($HostAddress, $Port)
            return $true
        }
        catch {
            Start-Sleep -Milliseconds 180
        }
        finally {
            if ($client) {
                $client.Close()
            }
        }
    }

    return $false
}

function Get-ProfileProcesses {
    param(
        [string]$ProcessName,
        [string]$ProfileDir
    )

    $name = "$ProcessName.exe"
    Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
}

function Wait-ForAppWindowToClose {
    param(
        [string]$BrowserPath,
        [string]$ProfileDir
    )

    $processName = [System.IO.Path]::GetFileNameWithoutExtension($BrowserPath)
    $sawAppProcess = $false

    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $processes = @(Get-ProfileProcesses -ProcessName $processName -ProfileDir $ProfileDir)
        if ($processes.Count -gt 0) {
            $sawAppProcess = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }

    if (-not $sawAppProcess) {
        return
    }

    while (@(Get-ProfileProcesses -ProcessName $processName -ProfileDir $ProfileDir).Count -gt 0) {
        Start-Sleep -Seconds 1
    }
}

function Stop-Server {
    param([System.Diagnostics.Process]$ServerProcess)

    if (-not $ServerProcess) {
        return
    }

    try {
        $ServerProcess.Refresh()
        if (-not $ServerProcess.HasExited) {
            $ServerProcess.Kill()
            $ServerProcess.WaitForExit(3000) | Out-Null
        }
    }
    catch {
        # The process may already be gone; nothing else is needed.
    }
}

try {
    Set-Location -LiteralPath $appDir

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        Show-Message "This app needs Node.js 20+ first. Please install it from https://nodejs.org/ and open Voice Polisher again."
        exit 1
    }

    $port = Find-AvailablePort
    if (-not $port) {
        Show-Message "No available local port was found between 5173 and 5199. Close another local service and try again."
        exit 1
    }

    $url = "http://${hostAddress}:$port"
    $serverProcess = Start-HiddenServer -NodePath $nodeCommand.Source -Port $port

    if (-not (Wait-ForServer -HostAddress $hostAddress -Port $port)) {
        Stop-Server -ServerProcess $serverProcess
        Show-Message "Voice Polisher did not start correctly. Please try again, or run npm start from this folder to see details."
        exit 1
    }

    $browserPath = Find-Browser
    if (-not $browserPath) {
        Start-Process $url | Out-Null
        $serverProcess = $null
        return
    }

    $profileDir = Join-Path $env:LOCALAPPDATA "VoicePolisher\BrowserProfile"
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

    $browserArgs = @(
        "--app=$url",
        "--user-data-dir=`"$profileDir`"",
        "--no-first-run",
        "--disable-session-crashed-bubble",
        "--disable-features=Translate",
        "--window-size=1280,860"
    )

    Start-Process -FilePath $browserPath -ArgumentList $browserArgs | Out-Null
    Wait-ForAppWindowToClose -BrowserPath $browserPath -ProfileDir $profileDir
}
catch {
    Show-Message ($_.Exception.Message)
}
finally {
    if ($serverProcess) {
        Stop-Server -ServerProcess $serverProcess
    }
}
