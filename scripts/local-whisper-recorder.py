import argparse
import ctypes
import ctypes.util
import json
import os
import queue
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path


EMIT_LOCK = threading.Lock()
MODEL_FILES = [
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
    "vocabulary.txt",
    "model.bin",
]


def emit(payload):
    with EMIT_LOCK:
        print(json.dumps(payload, ensure_ascii=False), flush=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--list-devices", action="store_true")
    return parser.parse_args()


class ProgressTicker:
    def __init__(self, start, end, message):
        self.start = start
        self.end = end
        self.message = message
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.last_percent = start - 1

    def start_ticking(self):
        self.thread.start()

    def stop(self):
        self.done.set()
        self.thread.join(timeout=1.0)

    def _run(self):
        started_at = time.monotonic()
        while not self.done.is_set():
            elapsed = time.monotonic() - started_at
            # Smoothly approaches the end value without claiming completion early.
            ratio = min(0.96, 1 - (1 / (1 + elapsed / 9)))
            percent = int(self.start + (self.end - self.start) * ratio)
            if percent > self.last_percent:
                emit({
                    "type": "progress",
                    "progress": percent,
                    "message": self.message,
                })
                self.last_percent = percent
            self.done.wait(0.8)


class LocalWhisperWorker:
    def __init__(self, args):
        self.args = args
        self.commands = queue.Queue()
        self.model = None
        self.np = None
        self.sd = None
        self.runtime_device = args.device
        self.runtime_compute_type = args.compute_type
        self.ready = False
        self.busy = False
        self.busy_lock = threading.Lock()
        self.stop_recording_event = None

    def load(self):
        emit({
            "type": "progress",
            "progress": 3,
            "message": "正在启动本地 Whisper 引擎",
        })

        try:
            import numpy as np
            import sounddevice as sd
            from faster_whisper import WhisperModel
        except Exception as error:
            emit({
                "type": "error",
                "fatal": True,
                "message": (
                    "Local Whisper dependencies are missing. Run "
                    "scripts\\setup-local-whisper.ps1 first. "
                    f"Details: {error}"
                ),
            })
            return False

        self.np = np
        self.sd = sd

        emit({
            "type": "progress",
            "progress": 9,
            "message": "正在检查麦克风与 CUDA 环境",
        })

        try:
            input_devices = self.get_input_devices()
            emit({
                "type": "devices",
                "devices": input_devices,
            })
        except Exception as error:
            emit({
                "type": "warning",
                "message": f"麦克风列表读取失败：{error}",
            })

        self.runtime_device, self.runtime_compute_type = resolve_runtime(
            self.args.device,
            self.args.compute_type,
        )

        model_source = self.args.model
        ticker = None

        try:
            model_source, cached = ensure_model_snapshot(self.args.model)
            memory_target = "显存" if self.runtime_device == "cuda" else "内存"
            message = (
                f"正在从本地缓存加载 {self.args.model}"
                if cached
                else f"{self.args.model} 下载完成，正在加载到{memory_target}"
            )
        except Exception as error:
            emit({
                "type": "error",
                "fatal": True,
                "message": (
                    f"本地 Whisper 模型准备失败：{error}。"
                    "如果之前下载被中断，请关闭软件后清理 HuggingFace 缓存里的 "
                    "*.incomplete 文件再重试。"
                ),
            })
            return False

        ticker_start = 14 if cached else 72
        ticker = ProgressTicker(ticker_start, 88, message)
        ticker.start_ticking()

        try:
            self.model = WhisperModel(
                model_source,
                device=self.runtime_device,
                compute_type=self.runtime_compute_type,
            )
        except Exception as error:
            ticker.stop()
            emit({
                "type": "error",
                "fatal": True,
                "message": (
                    "本地 Whisper 模型加载失败。"
                    f"model={self.args.model}, device={self.runtime_device}, "
                    f"compute_type={self.runtime_compute_type}. Details: {error}"
                ),
            })
            return False

        ticker.stop()
        self.ready = True
        emit({
            "type": "ready",
            "progress": 100,
            "engine": "faster-whisper",
            "model": self.args.model,
            "device": self.runtime_device,
            "computeType": self.runtime_compute_type,
            "sampleRate": self.args.sample_rate,
            "message": "本地 Whisper 已就绪",
        })
        return True

    def get_input_devices(self):
        devices = []
        all_devices = self.sd.query_devices()
        default_input = self.sd.default.device[0]

        for index, device in enumerate(all_devices):
            if int(device.get("max_input_channels", 0)) <= 0:
                continue
            devices.append({
                "id": index,
                "name": str(device.get("name", f"Microphone {index}")),
                "channels": int(device.get("max_input_channels", 0)),
                "default": index == default_input,
            })

        return devices

    def run(self):
        if not self.load():
            return 2

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                emit({"type": "warning", "message": f"忽略未知命令：{line}"})
                continue

            command_type = command.get("type")
            if command_type == "record":
                self.start_recording(command)
            elif command_type == "stop":
                self.stop_recording()
            elif command_type == "devices":
                emit({"type": "devices", "devices": self.get_input_devices()})
            elif command_type == "shutdown":
                self.stop_recording()
                break
            else:
                emit({"type": "warning", "message": f"未知命令：{command_type}"})

        return 0

    def start_recording(self, command):
        if not self.ready:
            emit({"type": "error", "message": "本地 Whisper 模型还没有加载完成"})
            return

        with self.busy_lock:
            if self.busy:
                emit({"type": "error", "message": "本地 Whisper 正在处理上一段录音"})
                return
            self.busy = True

        language = normalize_language(command.get("language") or self.args.language)
        input_device = parse_input_device(command.get("inputDevice"))
        self.stop_recording_event = threading.Event()

        thread = threading.Thread(
            target=self.record_then_transcribe,
            args=(language, input_device, self.stop_recording_event),
            daemon=True,
        )
        thread.start()

    def stop_recording(self):
        if self.stop_recording_event:
            self.stop_recording_event.set()

    def record_then_transcribe(self, language, input_device, stop_event):
        audio_queue = queue.Queue()
        temp_path = Path(tempfile.mkstemp(prefix="voice-polisher-", suffix=".wav")[1])
        frames_written = 0
        last_level_at = 0.0

        def audio_callback(indata, frames, time_info, status):
            if status:
                emit({"type": "warning", "message": str(status)})
            audio_queue.put(indata.copy())

        try:
            with wave.open(str(temp_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(self.args.sample_rate)

                with self.sd.InputStream(
                    channels=1,
                    samplerate=self.args.sample_rate,
                    dtype="int16",
                    callback=audio_callback,
                    device=input_device,
                ):
                    emit({
                        "type": "recording",
                        "inputDevice": input_device,
                        "language": language,
                    })

                    while not stop_event.is_set():
                        try:
                            chunk = audio_queue.get(timeout=0.2)
                        except queue.Empty:
                            continue

                        wav_file.writeframes(chunk.tobytes())
                        frames_written += len(chunk)

                        now = time.monotonic()
                        if now - last_level_at >= 0.25:
                            level = float(
                                self.np.sqrt(
                                    self.np.mean(self.np.square(chunk.astype(self.np.float32)))
                                )
                            )
                            emit({"type": "level", "value": min(1.0, level / 9000.0)})
                            last_level_at = now

                    while not audio_queue.empty():
                        chunk = audio_queue.get_nowait()
                        wav_file.writeframes(chunk.tobytes())
                        frames_written += len(chunk)

            duration = frames_written / float(self.args.sample_rate)
            if duration < 0.35:
                emit({"type": "error", "message": "Recording is too short."})
                emit({"type": "idle"})
                return

            emit({"type": "transcribing", "duration": round(duration, 2)})
            text, info = self.transcribe(temp_path, language)
            emit({
                "type": "result",
                "text": text,
                "duration": round(duration, 2),
                "language": getattr(info, "language", language),
                "languageProbability": round(
                    float(getattr(info, "language_probability", 0.0)),
                    3,
                ),
            })
            emit({"type": "idle"})
        except Exception as error:
            emit({"type": "error", "message": str(error)})
            emit({"type": "idle"})
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass
            self.stop_recording_event = None
            with self.busy_lock:
                self.busy = False

    def transcribe(self, temp_path, language):
        initial_prompt = None
        if language == "zh":
            initial_prompt = "以下是中文口述录音，请忠实逐字转写，不要总结，不要补写。"

        segments, info = self.model.transcribe(
            str(temp_path),
            language=language,
            task="transcribe",
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 450,
                "speech_pad_ms": 250,
            },
            beam_size=5,
            best_of=5,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt,
        )

        text_parts = []
        for segment in segments:
            if segment.text:
                text_parts.append(segment.text)

        return "".join(text_parts).strip(), info


def parse_input_device(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_language(language):
    return {
        "zh-CN": "zh",
        "zh-TW": "zh",
        "zh": "zh",
        "en-US": "en",
        "en": "en",
    }.get(str(language), "zh")


def resolve_runtime(device, compute_type):
    device = str(device or "cpu").lower()
    compute_type = str(compute_type or "int8").lower()

    if device != "cuda":
        return device, compute_type

    missing = get_missing_cuda_runtime_dlls()
    if not missing:
        return "cuda", compute_type

    emit({
        "type": "warning",
        "message": (
            "CUDA 运行库不完整，缺少 "
            f"{', '.join(missing)}。已自动切换到 CPU/int8，"
            "不会影响使用，但转写会慢一些。"
        ),
    })
    return "cpu", "int8"


def get_missing_cuda_runtime_dlls():
    if os.name != "nt":
        return []

    required = ["cublas64_12.dll"]
    missing = []

    for dll_name in required:
        if not can_load_windows_dll(dll_name):
            missing.append(dll_name)

    return missing


def can_load_windows_dll(dll_name):
    try:
        ctypes.WinDLL(dll_name)
        return True
    except OSError:
        pass

    dll_path = ctypes.util.find_library(dll_name)
    if not dll_path:
        return False

    try:
        ctypes.WinDLL(dll_path)
        return True
    except OSError:
        return False


def ensure_model_snapshot(model_name):
    model_path = Path(str(model_name)).expanduser()
    if model_path.exists():
        validate_model_dir(model_path)
        return str(model_path), True

    repo_id = normalize_model_repo_id(model_name)

    cached_path = try_get_cached_snapshot(repo_id)
    if cached_path:
        emit({
            "type": "progress",
            "progress": 14,
            "message": f"已找到 {model_name} 本地缓存，正在加载模型",
        })
        return str(cached_path), True

    emit({
        "type": "progress",
        "progress": 14,
        "message": f"{model_name} 尚未完整缓存，正在下载模型文件",
    })

    from huggingface_hub import snapshot_download

    ticker = ProgressTicker(14, 70, f"正在下载 {model_name} 模型文件")
    ticker.start_ticking()
    try:
        downloaded_path = Path(snapshot_download(
            repo_id,
            allow_patterns=MODEL_FILES,
        ))
    finally:
        ticker.stop()

    validate_model_dir(downloaded_path)
    return str(downloaded_path), False


def try_get_cached_snapshot(repo_id):
    try:
        from huggingface_hub import snapshot_download

        cached_path = Path(snapshot_download(
            repo_id,
            allow_patterns=MODEL_FILES,
            local_files_only=True,
        ))
        validate_model_dir(cached_path)
        return cached_path
    except Exception:
        return None


def validate_model_dir(model_dir):
    model_dir = Path(model_dir)
    if not (model_dir / "model.bin").exists():
        raise FileNotFoundError(f"{model_dir} 缺少 model.bin")

    if not (model_dir / "config.json").exists():
        raise FileNotFoundError(f"{model_dir} 缺少 config.json")


def normalize_model_repo_id(model_name):
    value = str(model_name).strip()
    if "/" in value:
        return value
    return f"Systran/faster-whisper-{value}"


def list_devices():
    try:
        import sounddevice as sd
    except Exception as error:
        emit({
            "type": "error",
            "fatal": True,
            "message": (
                "Local Whisper dependencies are missing. Run "
                "scripts\\setup-local-whisper.ps1 first. "
                f"Details: {error}"
            ),
        })
        return 2

    devices = []
    all_devices = sd.query_devices()
    default_input = sd.default.device[0]

    for index, device in enumerate(all_devices):
        if int(device.get("max_input_channels", 0)) <= 0:
            continue
        devices.append({
            "id": index,
            "name": str(device.get("name", f"Microphone {index}")),
            "channels": int(device.get("max_input_channels", 0)),
            "default": index == default_input,
        })

    emit({"type": "devices", "devices": devices})
    return 0


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    args = parse_args()
    if args.list_devices:
        return list_devices()

    worker = LocalWhisperWorker(args)
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())
