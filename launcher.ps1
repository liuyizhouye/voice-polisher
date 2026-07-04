$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:LOCALAPPDATA "VoicePolisher\logs"
$launcherLog = Join-Path $logDir "launcher.log"

function WriteLog {
    param([string]$Text)

    try {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -LiteralPath $launcherLog -Value "[$timestamp] $Text"
    }
    catch {
        # Logging must not prevent the app from starting.
    }
}

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

try {
    Set-Location -LiteralPath $appDir
    WriteLog -Text "starting from $appDir"

    $distDir = Join-Path $appDir "dist"
    if (Test-Path -LiteralPath $distDir) {
        $unpackedDir = Join-Path $distDir "win-unpacked"
        $unpackedExe = $null

        if (Test-Path -LiteralPath $unpackedDir) {
            $unpackedExe = Get-ChildItem -LiteralPath $unpackedDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
        }

        if ($unpackedExe) {
            $env:VOICE_POLISHER_PROJECT_DIR = $appDir
            WriteLog -Text "launching packaged app from dist/win-unpacked"
            $process = Start-Process -FilePath $unpackedExe.FullName -WorkingDirectory $unpackedDir -PassThru
            Start-Sleep -Milliseconds 900
            if ($process.HasExited) {
                Show-Message "Voice Polisher exited immediately. Check the log: $launcherLog"
                exit 1
            }
            exit 0
        }

        $desktopExe = Get-ChildItem -LiteralPath $distDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

        if ($desktopExe) {
            $env:VOICE_POLISHER_PROJECT_DIR = $appDir
            WriteLog -Text "launching packaged app from dist"
            $process = Start-Process -FilePath $desktopExe.FullName -WorkingDirectory $appDir -PassThru
            Start-Sleep -Milliseconds 900
            if ($process.HasExited) {
                Show-Message "Voice Polisher exited immediately. Check the log: $launcherLog"
                exit 1
            }
            exit 0
        }
    }

    $electronCommand = Join-Path $appDir "node_modules\.bin\electron.cmd"
    if (-not (Test-Path -LiteralPath $electronCommand)) {
        Show-Message "Desktop dependencies are missing. Run npm install in this folder, then open Voice Polisher again."
        exit 1
    }

    $env:VOICE_POLISHER_PROJECT_DIR = $appDir
    WriteLog -Text "launching development desktop app"
    Start-Process `
        -FilePath $electronCommand `
        -ArgumentList @("`"$appDir`"") `
        -WorkingDirectory $appDir `
        -WindowStyle Hidden | Out-Null
}
catch {
    WriteLog -Text "error: $($_.Exception.Message)"
    Show-Message ($_.Exception.Message)
}
