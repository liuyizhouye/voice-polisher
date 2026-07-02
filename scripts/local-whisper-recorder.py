import argparse
import json
import queue
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path


EMIT_LOCK = threading.Lock()


def emit(payload):
    with EMIT_LOCK:
        print(json.dumps(payload, ensure_ascii=False), flush=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="large-v3")
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

        message = (
            f"正在下载/加载 {self.args.model}，首次启动会比较久；"
            "后续打开会直接使用本地缓存"
        )
        ticker = ProgressTicker(14, 88, message)
        ticker.start_ticking()

        try:
            self.model = WhisperModel(
                self.args.model,
                device=self.args.device,
                compute_type=self.args.compute_type,
            )
        except Exception as error:
            ticker.stop()
            emit({
                "type": "error",
                "fatal": True,
                "message": (
                    "本地 Whisper 模型加载失败。"
                    f"model={self.args.model}, device={self.args.device}, "
                    f"compute_type={self.args.compute_type}. Details: {error}"
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
            "device": self.args.device,
            "computeType": self.args.compute_type,
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
