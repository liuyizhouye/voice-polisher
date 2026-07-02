$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$venvDir = Join-Path $appDir ".venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

Set-Location -LiteralPath $appDir

if (-not (Test-Path -LiteralPath $pythonExe)) {
    python -m venv $venvDir
}

& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install -r requirements-whisper.txt
& $pythonExe -c "import ctranslate2; print('CUDA compute types:', ', '.join(sorted(ctranslate2.get_supported_compute_types('cuda'))))"

Write-Host "Local Whisper environment is ready." -ForegroundColor Green
