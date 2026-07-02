param(
    [string]$Culture = "zh-CN"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Write-JsonLine {
    param([hashtable]$Payload)

    $json = $Payload | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Speech

    $cultureInfo = [System.Globalization.CultureInfo]::GetCultureInfo($Culture)
    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq $cultureInfo.Name } |
        Select-Object -First 1

    if (-not $recognizerInfo) {
        Write-JsonLine @{
            type = "error"
            message = "No Windows speech recognizer is installed for $Culture."
        }
        exit 2
    }

    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizerInfo)
    $grammar = [System.Speech.Recognition.DictationGrammar]::new()
    $recognizer.LoadGrammar($grammar)
    $recognizer.SetInputToDefaultAudioDevice()

    Register-ObjectEvent -InputObject $recognizer -EventName AudioStateChanged -Action {
        Write-JsonLine @{
            type = "audio"
            state = $EventArgs.AudioState.ToString()
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $recognizer -EventName SpeechHypothesized -Action {
        $text = $EventArgs.Result.Text
        if ($text) {
            Write-JsonLine @{
                type = "hypothesis"
                text = $text
            }
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -Action {
        $text = $EventArgs.Result.Text
        if ($text) {
            Write-JsonLine @{
                type = "result"
                text = $text
                confidence = [Math]::Round($EventArgs.Result.Confidence, 3)
            }
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognitionRejected -Action {
        Write-JsonLine @{
            type = "rejected"
            message = "Speech was not clear enough."
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $recognizer -EventName RecognizeCompleted -Action {
        if ($EventArgs.Error) {
            Write-JsonLine @{
                type = "error"
                message = $EventArgs.Error.Message
            }
        }
    } | Out-Null

    Write-JsonLine @{
        type = "ready"
        culture = $recognizerInfo.Culture.Name
        recognizer = $recognizerInfo.Description
    }

    $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

    while ($true) {
        Start-Sleep -Milliseconds 250
    }
}
catch {
    Write-JsonLine @{
        type = "error"
        message = $_.Exception.Message
    }
    exit 1
}
finally {
    if ($recognizer) {
        try {
            $recognizer.RecognizeAsyncCancel()
            $recognizer.Dispose()
        }
        catch {
        }
    }
}
