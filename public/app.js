const $ = selector => document.querySelector(selector);

const elements = {
  supportStatus: $("#supportStatus"),
  listenState: $("#listenState"),
  recordTimer: $("#recordTimer"),
  waveCanvas: $("#waveCanvas"),
  recordButton: $("#recordButton"),
  recordButtonIcon: $("#recordButtonIcon"),
  recordButtonLabel: $("#recordButtonLabel"),
  clearTranscriptButton: $("#clearTranscriptButton"),
  microphoneSelect: $("#microphoneSelect"),
  refreshDevicesButton: $("#refreshDevicesButton"),
  engineStatus: $("#engineStatus"),
  engineStatusText: $("#engineStatusText"),
  engineStatusPercent: $("#engineStatusPercent"),
  engineProgressBar: $("#engineProgressBar"),
  transcriptInput: $("#transcriptInput"),
  interimText: $("#interimText"),
  modeSelect: $("#modeSelect"),
  densitySelect: $("#densitySelect"),
  languageSelect: $("#languageSelect"),
  providerSelect: $("#providerSelect"),
  modelInput: $("#modelInput"),
  modelOptions: $("#modelOptions"),
  modelStatus: $("#modelStatus"),
  modelChip: $("#modelChip"),
  apiKeyInput: $("#apiKeyInput"),
  apiEndpointInput: $("#apiEndpointInput"),
  rememberKeyInput: $("#rememberKeyInput"),
  connectButton: $("#connectButton"),
  refineButton: $("#refineButton"),
  resultOutput: $("#resultOutput"),
  copyButton: $("#copyButton"),
  downloadButton: $("#downloadButton"),
  historyList: $("#historyList"),
  historyCount: $("#historyCount"),
  clearHistoryButton: $("#clearHistoryButton"),
  themeButton: $("#themeButton"),
  toast: $("#toast")
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const storageKeys = {
  history: "voice-polisher-history",
  apiKey: "voice-polisher-api-key",
  rememberKey: "voice-polisher-remember-key",
  provider: "voice-polisher-provider",
  model: "voice-polisher-model",
  apiEndpoint: "voice-polisher-api-endpoint",
  microphone: "voice-polisher-microphone",
  theme: "voice-polisher-theme"
};

let recognition = null;
let recognitionState = "idle";
let localWhisper = { available: false };
let localWhisperEventSource = null;
let localWhisperReady = false;
let nativeSpeech = { available: false };
let nativeEventSource = null;
let activeRecorder = "browser";
let isRecording = false;
let isTranscribing = false;
let shouldRestart = false;
let timerId = null;
let recordingWatchdogId = null;
let startedAt = 0;
let audioContext = null;
let audioStream = null;
let analyser = null;
let animationFrame = 0;
let history = loadJson(storageKeys.history, []);
let aiProviders = [];

init();

async function init() {
  restoreTheme();
  bindEvents();
  renderHistory();
  drawIdleWave();

  if (window.lucide) {
    window.lucide.createIcons();
  }

  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    localWhisper = health.localWhisper || { available: false };
    nativeSpeech = health.nativeSpeech || { available: false };
    configureAiSettings(health);
  } catch {
    configureAiSettings({});
    elements.modelStatus.textContent = "本地服务未响应";
  }

  if (localWhisper.available) {
    activeRecorder = "whisper";
    localWhisperReady = Boolean(localWhisper.ready);
    elements.supportStatus.textContent =
      `本地 Whisper ${localWhisper.device || "cuda"} / ${localWhisper.defaultModel || "small"}`;
    elements.listenState.textContent = localWhisperReady
      ? "本地 Whisper 已就绪"
      : "正在准备本地 Whisper";
    renderLocalWhisperMicrophoneOptions();
    updateLocalWhisperProgress(localWhisper);
    await openLocalWhisperEvents();
    loadLocalWhisperDevices().catch(() => {
      elements.listenState.textContent = "麦克风列表读取失败，将使用系统默认输入";
    });
    preloadLocalWhisperModel();
    updateRecordingUi();
  } else if (nativeSpeech.available) {
    activeRecorder = "native";
    elements.supportStatus.textContent = "Windows 系统听写可用";
    elements.listenState.textContent = "准备使用系统麦克风";
    renderNativeMicrophoneOptions();
  } else if (SpeechRecognition) {
    activeRecorder = "browser";
    elements.supportStatus.textContent = "浏览器听写可用";
    await loadMicrophoneDevices().catch(() => {
      elements.listenState.textContent = "麦克风待授权";
    });
  } else {
    elements.supportStatus.textContent = "当前环境不支持听写";
    elements.listenState.textContent = "可直接输入文本";
    elements.recordButton.disabled = true;
  }
}

function bindEvents() {
  elements.recordButton.addEventListener("click", () => {
    if (isTranscribing) return;

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  elements.clearTranscriptButton.addEventListener("click", () => {
    elements.transcriptInput.value = "";
    elements.interimText.textContent = "";
    showToast("已清空原始口述");
  });

  elements.microphoneSelect.addEventListener("change", () => {
    if (localWhisper.available) {
      localStorage.setItem(storageKeys.microphone, elements.microphoneSelect.value);
      elements.listenState.textContent = elements.microphoneSelect.value
        ? "本地 Whisper 麦克风已选择"
        : "本地 Whisper 使用系统默认麦克风";
      return;
    }

    if (nativeSpeech.available) {
      elements.listenState.textContent = "系统听写使用 Windows 默认麦克风";
      return;
    }

    localStorage.setItem(storageKeys.microphone, elements.microphoneSelect.value);
    if (isRecording) {
      stopRecording();
      window.setTimeout(startRecording, 350);
      return;
    }
    elements.listenState.textContent = "麦克风已选择";
  });

  elements.refreshDevicesButton.addEventListener("click", async () => {
    if (localWhisper.available) {
      elements.refreshDevicesButton.disabled = true;
      try {
        await loadLocalWhisperDevices();
        showToast("麦克风列表已刷新");
      } catch (error) {
        showToast(error?.message || "麦克风列表读取失败");
      } finally {
        elements.refreshDevicesButton.disabled = false;
      }
      return;
    }

    if (nativeSpeech.available) {
      showToast("系统听写使用 Windows 默认麦克风");
      elements.listenState.textContent = "请在 Windows 声音设置里切换默认输入设备";
      return;
    }

    elements.refreshDevicesButton.disabled = true;
    try {
      await loadMicrophoneDevices({ requestPermission: true });
      showToast("麦克风列表已刷新");
    } catch (error) {
      showToast(friendlyMicrophoneError(error));
    } finally {
      elements.refreshDevicesButton.disabled = false;
    }
  });

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.("devicechange", () => {
      loadMicrophoneDevices().catch(() => {});
    });
  }

  elements.languageSelect.addEventListener("change", () => {
    if (!isRecording) return;
    stopRecording();
    window.setTimeout(startRecording, 250);
  });

  elements.providerSelect.addEventListener("change", () => {
    localStorage.setItem(storageKeys.provider, elements.providerSelect.value);
    restoreProviderFields();
    elements.modelStatus.textContent = getSelectedProvider().requiresKey
      ? "等待 API key"
      : "可直接连接";
  });

  elements.modelInput.addEventListener("input", () => {
    const provider = getSelectedProvider();
    elements.modelChip.textContent =
      elements.modelInput.value.trim() || provider.defaultModel || "deepseek-v4-flash";
    elements.modelStatus.textContent = "等待连接";
    persistAiSettings();
  });

  elements.apiEndpointInput.addEventListener("input", () => {
    persistAiSettings();
    elements.modelStatus.textContent = "等待连接";
  });

  elements.connectButton.addEventListener("click", testModelConnection);
  elements.refineButton.addEventListener("click", refineTranscript);
  elements.copyButton.addEventListener("click", copyResult);
  elements.downloadButton.addEventListener("click", downloadResult);
  elements.clearHistoryButton.addEventListener("click", clearHistory);
  elements.themeButton.addEventListener("click", toggleTheme);

  elements.rememberKeyInput.addEventListener("change", () => {
    if (!elements.rememberKeyInput.checked) {
      localStorage.removeItem(apiKeyStorageKey(elements.providerSelect.value));
      localStorage.removeItem(storageKeys.apiKey);
      localStorage.setItem(storageKeys.rememberKey, "false");
      showToast("已取消保存 API key");
    } else {
      localStorage.setItem(storageKeys.rememberKey, "true");
      persistAiSettings();
    }
  });

  elements.apiKeyInput.addEventListener("input", () => {
    persistAiSettings();
    elements.modelStatus.textContent = "等待连接";
  });

  window.addEventListener("resize", () => {
    if (!isRecording) drawIdleWave();
  });
}

async function startRecording() {
  if (localWhisper.available) {
    return await startLocalWhisperRecording();
  }

  if (nativeSpeech.available) {
    return await startNativeRecording();
  }

  if (!SpeechRecognition) {
    showToast("当前浏览器不支持听写");
    return;
  }

  try {
    stopRecordingWatchdog();
    shouldRestart = true;
    isRecording = true;
    recognitionState = "starting";
    startedAt = Date.now();
    updateRecordingUi();
    elements.listenState.textContent = "正在请求麦克风权限";
    startTimer();

    recognition = createRecognition();
    recognition.start();
    startRecordingWatchdog();
    startAudioMeter().catch(error => {
      if (!isRecording) return;
      elements.listenState.textContent = friendlyMicrophoneError(error);
      showToast(friendlyMicrophoneError(error));
    });
  } catch (error) {
    isRecording = false;
    shouldRestart = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopRecordingWatchdog();
    stopAudioMeter();
    showToast(error?.message || friendlyMicrophoneError(error));
  }
}

function stopRecording() {
  if (activeRecorder === "whisper") {
    stopLocalWhisperRecording();
    return;
  }

  if (activeRecorder === "native") {
    stopNativeRecording();
    return;
  }

  shouldRestart = false;
  isRecording = false;
  recognitionState = "idle";
  elements.interimText.textContent = "";

  if (recognition) {
    try {
      recognition.stop();
    } catch {
      recognition = null;
    }
  }

  updateRecordingUi();
  stopTimer();
  stopRecordingWatchdog();
  stopAudioMeter();
  elements.listenState.textContent = "已暂停";
}

async function startLocalWhisperRecording() {
  if (!localWhisperReady) {
    elements.listenState.textContent = "本地 Whisper 模型还在下载/加载";
    showToast("请等本地 Whisper 进度条完成");
    return;
  }

  try {
    activeRecorder = "whisper";
    isRecording = true;
    isTranscribing = false;
    recognitionState = "starting";
    startedAt = Date.now();
    updateRecordingUi();
    startTimer();
    drawSyntheticWave();
    await openLocalWhisperEvents();
    elements.listenState.textContent = "正在启动本地 Whisper 录音";

    const response = await fetch("/api/local-whisper/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: elements.languageSelect.value,
        inputDevice: elements.microphoneSelect.value || null
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "本地 Whisper 启动失败");
    }
  } catch (error) {
    isRecording = false;
    isTranscribing = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    elements.listenState.textContent = "本地 Whisper 启动失败";
    showToast(error?.message || "本地 Whisper 启动失败");
  }
}

async function stopLocalWhisperRecording() {
  if (!isRecording) return;

  isRecording = false;
  isTranscribing = true;
  recognitionState = "transcribing";
  elements.interimText.textContent = "";
  updateRecordingUi();
  stopTimer();
  elements.listenState.textContent = "正在本地转写";

  await fetch("/api/local-whisper/stop", { method: "POST" }).catch(() => {});
}

function openLocalWhisperEvents() {
  if (localWhisperEventSource) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    localWhisperEventSource = new EventSource("/api/local-whisper/events");
    localWhisperEventSource.onopen = finish;

    localWhisperEventSource.onmessage = event => {
      try {
        handleLocalWhisperEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed diagnostic messages.
      }
    };

    localWhisperEventSource.onerror = () => {
      finish();
      if (!isRecording && !isTranscribing) return;
      elements.listenState.textContent = "本地 Whisper 连接中断";
    };

    window.setTimeout(finish, 500);
  });
}

function closeLocalWhisperEvents() {
  if (localWhisperEventSource) {
    localWhisperEventSource.close();
    localWhisperEventSource = null;
  }
}

function handleLocalWhisperEvent(event) {
  if (!event?.type) return;

  if (event.type === "status") {
    if (event.localWhisper) {
      updateLocalWhisperProgress(event.localWhisper);
    }
    return;
  }

  if (event.type === "progress") {
    updateLocalWhisperProgress(event);
    return;
  }

  if (event.type === "devices") {
    renderLocalWhisperMicrophoneOptions(event.devices || []);
    return;
  }

  if (event.type === "ready") {
    localWhisperReady = true;
    updateLocalWhisperProgress({ ...event, ready: true, progress: 100 });
    recognitionState = "started";
    elements.supportStatus.textContent =
      `本地 Whisper ${event.device || "cuda"} / ${event.model || "small"}`;
    elements.listenState.textContent = `本地 Whisper 已准备 (${event.model || "small"})`;
    updateRecordingUi();
    return;
  }

  if (event.type === "recording") {
    recognitionState = "recording";
    elements.listenState.textContent = "正在录音";
    return;
  }

  if (event.type === "level") {
    return;
  }

  if (event.type === "transcribing") {
    isRecording = false;
    isTranscribing = true;
    recognitionState = "transcribing";
    updateRecordingUi();
    stopTimer();
    elements.listenState.textContent = "正在本地转写";
    return;
  }

  if (event.type === "result") {
    const text = String(event.text || "").trim();
    if (text) {
      elements.transcriptInput.value = joinSpeech(elements.transcriptInput.value, text);
      elements.listenState.textContent = "本地转写完成";
      showToast("本地转写完成");
    } else {
      elements.listenState.textContent = "没有转写出文字";
      showToast("没有转写出文字");
    }
    elements.interimText.textContent = "";
    return;
  }

  if (event.type === "idle") {
    isRecording = false;
    isTranscribing = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    if (
      localWhisperReady &&
      ["正在", "启动", "录音"].some(word => elements.listenState.textContent.includes(word))
    ) {
      elements.listenState.textContent = "本地 Whisper 已就绪";
    }
    return;
  }

  if (event.type === "warning") {
    elements.interimText.textContent = event.message || "";
    return;
  }

  if (event.type === "error") {
    const message = translateLocalWhisperMessage(event.message);
    if (event.fatal) {
      localWhisperReady = false;
      updateLocalWhisperProgress({
        progress: 0,
        ready: false,
        loading: false,
        message
      });
    }
    isRecording = false;
    isTranscribing = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    elements.listenState.textContent = message;
    showToast(message);
    return;
  }

  if (event.type === "workerStopped") {
    localWhisperReady = false;
    isRecording = false;
    isTranscribing = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    updateLocalWhisperProgress({
      progress: 0,
      ready: false,
      loading: false,
      message: "本地 Whisper 已停止"
    });
  }
}

async function startNativeRecording() {
  try {
    activeRecorder = "native";
    isRecording = true;
    recognitionState = "starting";
    startedAt = Date.now();
    updateRecordingUi();
    startTimer();
    drawSyntheticWave();
    await openNativeSpeechEvents();
    elements.listenState.textContent = "正在启动 Windows 系统听写";

    const response = await fetch("/api/native-speech/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ culture: elements.languageSelect.value })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "系统听写启动失败");
    }
  } catch (error) {
    isRecording = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    closeNativeSpeechEvents();
    elements.listenState.textContent = "系统听写启动失败";
    showToast(error?.message || "系统听写启动失败");
  }
}

async function stopNativeRecording() {
  isRecording = false;
  recognitionState = "idle";
  elements.interimText.textContent = "";
  updateRecordingUi();
  stopTimer();
  stopAudioMeter();
  closeNativeSpeechEvents();
  elements.listenState.textContent = "已暂停";

  await fetch("/api/native-speech/stop", { method: "POST" }).catch(() => {});
}

function openNativeSpeechEvents() {
  closeNativeSpeechEvents();
  return new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    nativeEventSource = new EventSource("/api/native-speech/events");
    nativeEventSource.onopen = finish;

    nativeEventSource.onmessage = event => {
      try {
        handleNativeSpeechEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed diagnostic messages.
      }
    };

    nativeEventSource.onerror = () => {
      finish();
      if (!isRecording || activeRecorder !== "native") return;
      elements.listenState.textContent = "系统听写连接中断";
    };

    window.setTimeout(finish, 500);
  });
}

function closeNativeSpeechEvents() {
  if (nativeEventSource) {
    nativeEventSource.close();
    nativeEventSource = null;
  }
}

function handleNativeSpeechEvent(event) {
  if (!event?.type) return;

  if (event.type === "ready") {
    recognitionState = "started";
    elements.listenState.textContent = "Windows 系统听写已启动";
    elements.supportStatus.textContent = event.recognizer || "Windows 系统听写可用";
    return;
  }

  if (event.type === "audio") {
    elements.listenState.textContent =
      event.state === "Silence" ? "等待你说话" : "正在听";
    return;
  }

  if (event.type === "hypothesis") {
    elements.interimText.textContent = event.text || "";
    return;
  }

  if (event.type === "result") {
    const text = String(event.text || "").trim();
    if (!text) return;
    recognitionState = "result";
    elements.transcriptInput.value = joinSpeech(elements.transcriptInput.value, text);
    elements.interimText.textContent = "";
    elements.listenState.textContent = "已识别一段语音";
    return;
  }

  if (event.type === "rejected") {
    elements.listenState.textContent = "没有识别出清晰语音";
    return;
  }

  if (event.type === "error") {
    const message = translateNativeSpeechMessage(event.message);
    isRecording = false;
    recognitionState = "idle";
    updateRecordingUi();
    stopTimer();
    stopAudioMeter();
    closeNativeSpeechEvents();
    elements.listenState.textContent = message;
    showToast(message);
    return;
  }

  if (event.type === "stopped") {
    if (activeRecorder === "native" && isRecording) {
      isRecording = false;
      recognitionState = "idle";
      updateRecordingUi();
      stopTimer();
      stopAudioMeter();
      closeNativeSpeechEvents();
      elements.listenState.textContent = "系统听写已停止";
    }
  }
}

function createRecognition() {
  const instance = new SpeechRecognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = elements.languageSelect.value;

  instance.onstart = () => {
    recognitionState = "started";
    elements.listenState.textContent = "正在听写";
  };

  instance.onaudiostart = () => {
    recognitionState = "audio";
    elements.listenState.textContent = "麦克风已打开";
  };

  instance.onspeechstart = () => {
    recognitionState = "speech";
    elements.listenState.textContent = "正在识别语音";
  };

  instance.onspeechend = () => {
    if (isRecording) {
      elements.listenState.textContent = "等待继续说话";
    }
  };

  instance.onresult = event => {
    let finalText = "";
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const segment = event.results[index][0].transcript.trim();
      if (!segment) continue;

      if (event.results[index].isFinal) {
        finalText += segment;
      } else {
        interimText += segment;
      }
    }

    if (finalText) {
      recognitionState = "result";
      elements.transcriptInput.value = joinSpeech(
        elements.transcriptInput.value,
        finalText
      );
    }

    elements.interimText.textContent = interimText;
  };

  instance.onerror = event => {
    const messages = {
      "not-allowed": "麦克风权限被拒绝，请在这个应用窗口或系统设置里允许麦克风",
      "audio-capture": "没有检测到麦克风",
      "service-not-allowed": "浏览器听写服务不可用",
      "language-not-supported": "当前语言不支持听写",
      network: "听写网络不可用",
      "no-speech": "没有识别到语音"
    };
    const message = messages[event.error] || "听写出现错误";
    elements.listenState.textContent = message;
    if (event.error !== "no-speech") {
      showToast(message);
    }
    if (
      event.error === "not-allowed" ||
      event.error === "audio-capture" ||
      event.error === "service-not-allowed" ||
      event.error === "language-not-supported"
    ) {
      shouldRestart = false;
      isRecording = false;
      recognitionState = "idle";
      updateRecordingUi();
      stopTimer();
      stopRecordingWatchdog();
      stopAudioMeter();
    }
  };

  instance.onend = () => {
    recognition = null;
    if (shouldRestart && isRecording) {
      window.setTimeout(() => {
        try {
          recognition = createRecognition();
          recognition.start();
        } catch {
          shouldRestart = false;
          isRecording = false;
          recognitionState = "idle";
          updateRecordingUi();
          stopTimer();
          stopRecordingWatchdog();
          stopAudioMeter();
          elements.listenState.textContent = "听写已停止";
        }
      }, 220);
    }
  };

  return instance;
}

async function startAudioMeter() {
  if (!navigator.mediaDevices?.getUserMedia) {
    drawSyntheticWave();
    return;
  }

  try {
    audioStream = await getMicrophoneStream();
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(audioStream);
    source.connect(analyser);
    drawLiveWave();
    await loadMicrophoneDevices();
  } catch (error) {
    throw new Error(friendlyMicrophoneError(error));
  }
}

async function getMicrophoneStream() {
  const selectedDeviceId = elements.microphoneSelect.value;

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : true
    });
  } catch (error) {
    if (!selectedDeviceId) {
      throw error;
    }

    localStorage.removeItem(storageKeys.microphone);
    elements.microphoneSelect.value = "";
    showToast("选中的麦克风不可用，已切回系统默认");
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

function stopAudioMeter() {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  drawIdleWave();
}

function drawLiveWave() {
  const canvas = elements.waveCanvas;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  const draw = () => {
    analyser.getByteTimeDomainData(data);
    paintWave(ctx, canvas, data, true);
    animationFrame = requestAnimationFrame(draw);
  };

  draw();
}

function drawSyntheticWave() {
  const canvas = elements.waveCanvas;
  const ctx = canvas.getContext("2d");

  const draw = () => {
    const data = new Uint8Array(128);
    const time = Date.now() / 180;
    for (let i = 0; i < data.length; i += 1) {
      data[i] = 128 + Math.sin(i / 3 + time) * 24 + Math.sin(i / 11 + time) * 18;
    }
    paintWave(ctx, canvas, data, true);
    animationFrame = requestAnimationFrame(draw);
  };

  draw();
}

function drawIdleWave() {
  const canvas = elements.waveCanvas;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(90);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = 128 + Math.sin(i / 5) * 10;
  }
  paintWave(ctx, canvas, data, false);
}

function paintWave(ctx, canvas, data, active) {
  const width = canvas.width;
  const height = canvas.height;
  const center = height / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getCanvasColor("--panel-strong");
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = active ? 4 : 3;
  ctx.lineCap = "round";
  ctx.strokeStyle = active ? getCanvasColor("--accent") : getCanvasColor("--muted");
  ctx.beginPath();

  for (let i = 0; i < data.length; i += 1) {
    const x = (i / (data.length - 1)) * width;
    const y = center + ((data[i] - 128) / 128) * (height * 0.38);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.stroke();

  ctx.strokeStyle = active ? getCanvasColor("--warm") : getCanvasColor("--line");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, center);
  ctx.lineTo(width, center);
  ctx.stroke();
}

function getCanvasColor(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function updateRecordingUi() {
  const waitingForLocalWhisper =
    activeRecorder === "whisper" && localWhisper.available && !localWhisperReady;
  elements.recordButton.classList.toggle("is-recording", isRecording);
  elements.recordButton.disabled = isTranscribing || waitingForLocalWhisper;
  elements.recordButtonLabel.textContent = isTranscribing
    ? "转写中"
    : isRecording
      ? "暂停"
      : waitingForLocalWhisper
        ? "准备中"
        : "开始";
  elements.recordButtonIcon.innerHTML = `<i data-lucide="${
    isTranscribing || waitingForLocalWhisper ? "loader-circle" : isRecording ? "pause" : "mic"
  }"></i>`;
  if (window.lucide) window.lucide.createIcons();
}

function startRecordingWatchdog() {
  stopRecordingWatchdog();
  recordingWatchdogId = window.setTimeout(() => {
    if (!isRecording) return;

    if (recognitionState === "starting") {
      elements.listenState.textContent = "浏览器听写没有响应，请检查这个应用窗口的麦克风权限";
      showToast("浏览器听写没有响应，请检查这个应用窗口的麦克风权限");
      return;
    }

    if (recognitionState === "started") {
      elements.listenState.textContent = "听写已启动，等待麦克风声音";
    }
  }, 4500);
}

function stopRecordingWatchdog() {
  if (recordingWatchdogId) {
    window.clearTimeout(recordingWatchdogId);
    recordingWatchdogId = null;
  }
}

function startTimer() {
  stopTimer();
  timerId = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    elements.recordTimer.textContent = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }, 250);
}

function stopTimer() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }

  if (!isRecording) {
    elements.recordTimer.textContent = "00:00";
  }
}

async function preloadLocalWhisperModel() {
  if (!localWhisper.available) return;

  try {
    const response = await fetch("/api/local-whisper/preload", { method: "POST" });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "本地 Whisper 预加载失败");
    }

    if (payload.localWhisper) {
      updateLocalWhisperProgress(payload.localWhisper);
    }
  } catch (error) {
    localWhisperReady = false;
    updateRecordingUi();
    elements.listenState.textContent = error?.message || "本地 Whisper 预加载失败";
    showToast(error?.message || "本地 Whisper 预加载失败");
  }
}

async function loadLocalWhisperDevices() {
  const response = await fetch("/api/local-whisper/devices");
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "麦克风列表读取失败");
  }

  renderLocalWhisperMicrophoneOptions(payload.devices || []);
}

function updateLocalWhisperProgress(status) {
  if (!elements.engineStatus) return;

  elements.engineStatus.classList.remove("is-hidden");

  const progress = clampPercent(
    status.progress ?? (status.ready ? 100 : localWhisperReady ? 100 : 0)
  );
  localWhisperReady = Boolean(status.ready || progress >= 100);

  const model = status.model || status.defaultModel || localWhisper.defaultModel || "small";
  const device = status.device || localWhisper.device || "cuda";
  const computeType = status.computeType || localWhisper.computeType || "float16";
  const message =
    status.message ||
    (localWhisperReady
      ? `已加载 ${model} (${device}/${computeType})`
      : `正在准备 ${model} (${device}/${computeType})`);

  elements.engineStatusText.textContent = message;
  elements.engineStatusPercent.textContent = `${progress}%`;
  elements.engineProgressBar.style.width = `${progress}%`;
  elements.engineStatus.classList.toggle("is-ready", localWhisperReady);
  elements.engineStatus.classList.toggle("is-loading", !localWhisperReady);

  updateRecordingUi();
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function loadMicrophoneDevices(options = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    elements.microphoneSelect.disabled = true;
    elements.refreshDevicesButton.disabled = true;
    return;
  }

  let probeStream = null;
  if (options.requestPermission && navigator.mediaDevices.getUserMedia) {
    probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    renderMicrophoneOptions(devices.filter(device => device.kind === "audioinput"));
  } finally {
    if (probeStream) {
      probeStream.getTracks().forEach(track => track.stop());
    }
  }
}

function renderMicrophoneOptions(devices) {
  const savedDeviceId = localStorage.getItem(storageKeys.microphone) || "";
  const currentDeviceId = elements.microphoneSelect.value || savedDeviceId;
  const hasCurrent = devices.some(device => device.deviceId === currentDeviceId);

  elements.microphoneSelect.innerHTML = "";
  elements.microphoneSelect.append(new Option("系统默认麦克风", ""));

  devices.forEach((device, index) => {
    const label = device.label || `麦克风 ${index + 1}`;
    elements.microphoneSelect.append(new Option(label, device.deviceId));
  });

  elements.microphoneSelect.value = hasCurrent ? currentDeviceId : "";
  elements.microphoneSelect.disabled = devices.length === 0;

  if (!devices.length) {
    elements.listenState.textContent = "没有检测到麦克风";
  } else if (!hasCurrent && currentDeviceId) {
    localStorage.removeItem(storageKeys.microphone);
  }
}

function renderNativeMicrophoneOptions() {
  elements.microphoneSelect.innerHTML = "";
  elements.microphoneSelect.append(new Option("Windows 默认麦克风", ""));
  elements.microphoneSelect.value = "";
  elements.microphoneSelect.disabled = true;
  elements.refreshDevicesButton.disabled = false;
}

function renderLocalWhisperMicrophoneOptions(devices = []) {
  const savedDeviceId = localStorage.getItem(storageKeys.microphone) || "";
  const currentDeviceId = /^\d+$/.test(savedDeviceId)
    ? elements.microphoneSelect.value || savedDeviceId
    : "";
  const hasCurrent = devices.some(device => String(device.id) === currentDeviceId);

  elements.microphoneSelect.innerHTML = "";
  elements.microphoneSelect.append(new Option("系统默认麦克风", ""));
  devices.forEach(device => {
    const label = device.default ? `${device.name}（默认）` : device.name;
    elements.microphoneSelect.append(new Option(label, String(device.id)));
  });

  elements.microphoneSelect.value = hasCurrent ? currentDeviceId : "";
  elements.microphoneSelect.disabled = false;
  elements.refreshDevicesButton.disabled = false;
}

function translateLocalWhisperMessage(message) {
  const text = String(message || "").trim();

  if (!text) return "本地 Whisper 出错";
  if (text.includes("Local Whisper dependencies are missing")) {
    return "本地 Whisper 依赖未安装，请运行 scripts\\setup-local-whisper.ps1";
  }
  if (text.includes("Recording is too short")) {
    return "录音太短，请多说一点再停止";
  }

  return text;
}

function translateNativeSpeechMessage(message) {
  const text = String(message || "").trim();

  if (!text) return "系统听写出错";
  if (text.includes("No Windows speech recognizer")) {
    return "Windows 没有安装当前语言的系统听写引擎";
  }

  return text;
}

function friendlyMicrophoneError(error) {
  const name = error?.name || "";
  const messages = {
    NotAllowedError: "麦克风权限被拒绝，请在这个应用窗口或系统设置里允许麦克风",
    SecurityError: "麦克风权限被拒绝，请在这个应用窗口或系统设置里允许麦克风",
    NotFoundError: "没有检测到麦克风",
    DevicesNotFoundError: "没有检测到麦克风",
    NotReadableError: "麦克风被占用或无法启动",
    TrackStartError: "麦克风被占用或无法启动",
    OverconstrainedError: "选中的麦克风不可用",
    ConstraintNotSatisfiedError: "选中的麦克风不可用",
    AbortError: "麦克风启动被中断"
  };

  return messages[name] || error?.message || "麦克风启动失败";
}

async function refineTranscript() {
  const transcript = elements.transcriptInput.value.trim();
  if (!transcript) {
    showToast("先放一点口述内容进来");
    return;
  }

  persistAiSettings();
  const provider = getSelectedProvider();
  const apiKey = elements.apiKeyInput.value.trim();
  const model = elements.modelInput.value.trim() || provider.defaultModel || "deepseek-v4-flash";

  elements.refineButton.disabled = true;
  elements.refineButton.querySelector("span").textContent = "整理中";
  elements.modelChip.textContent = model;

  try {
    const headers = {
      "Content-Type": "application/json"
    };

    headers["x-ai-api-key"] = apiKey;

    const response = await fetch("/api/refine", {
      method: "POST",
      headers,
      body: JSON.stringify({
        transcript,
        mode: elements.modeSelect.value,
        density: elements.densitySelect.value,
        provider: provider.id,
        apiEndpoint: elements.apiEndpointInput.value.trim(),
        model
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "整理失败");
    }

    elements.resultOutput.value = payload.refined;
    elements.modelStatus.textContent = "整理完成";
    elements.modelChip.textContent = payload.model || model;
    addHistory({
      transcript,
      refined: payload.refined,
      mode: elements.modeSelect.value,
      density: elements.densitySelect.value,
      provider: provider.id,
      model: payload.model || model
    });
    showToast("整理好了");
  } catch (error) {
    elements.modelStatus.textContent = "整理失败";
    showToast(error?.message || "整理失败");
  } finally {
    elements.refineButton.disabled = false;
    elements.refineButton.querySelector("span").textContent = "整理";
  }
}

async function testModelConnection() {
  persistAiSettings();

  const provider = getSelectedProvider();
  const apiKey = elements.apiKeyInput.value.trim();
  const model = elements.modelInput.value.trim() || provider.defaultModel || "deepseek-v4-flash";

  if (provider.requiresKey && !apiKey) {
    showToast(`先粘贴 ${provider.label} API key`);
    elements.apiKeyInput.focus();
    return;
  }

  elements.connectButton.disabled = true;
  elements.connectButton.querySelector("span").textContent = "连接中";
  elements.modelStatus.textContent = `正在连接 ${provider.label}`;

  try {
    const response = await fetch("/api/test-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ai-api-key": apiKey
      },
      body: JSON.stringify({
        provider: provider.id,
        apiEndpoint: elements.apiEndpointInput.value.trim(),
        model
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "连接失败");
    }

    elements.modelStatus.textContent = `${provider.label} 已连接`;
    elements.modelChip.textContent = payload.model || model;
    showToast("连接成功");
  } catch (error) {
    elements.modelStatus.textContent = "连接失败";
    showToast(error?.message || "连接失败");
  } finally {
    elements.connectButton.disabled = false;
    elements.connectButton.querySelector("span").textContent = "连接";
  }
}

async function copyResult() {
  const text = elements.resultOutput.value.trim();
  if (!text) {
    showToast("没有可复制的内容");
    return;
  }

  await navigator.clipboard.writeText(text);
  showToast("已复制");
}

function downloadResult() {
  const text = elements.resultOutput.value.trim();
  if (!text) {
    showToast("没有可下载的内容");
    return;
  }

  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0")
  ].join("");

  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `voice-note-${stamp}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("已下载");
}

function addHistory(item) {
  history = [
    {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...item
    },
    ...history
  ].slice(0, 20);
  localStorage.setItem(storageKeys.history, JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  elements.historyCount.textContent = `${history.length} 条`;

  if (!history.length) {
    elements.historyList.innerHTML = `<div class="history-empty">暂无记录</div>`;
    return;
  }

  elements.historyList.innerHTML = "";

  for (const item of history) {
    const button = document.createElement("button");
    button.className = "history-item";
    button.type = "button";
    button.innerHTML = `
      <strong>${formatDate(item.createdAt)} · ${labelForMode(item.mode)}</strong>
      <p>${escapeHtml(item.refined)}</p>
    `;
    button.addEventListener("click", () => {
      elements.transcriptInput.value = item.transcript || "";
      elements.resultOutput.value = item.refined || "";
      elements.modeSelect.value = item.mode || "daily";
      elements.densitySelect.value = item.density || "balanced";
      if (item.provider && elements.providerSelect.querySelector(`option[value="${item.provider}"]`)) {
        elements.providerSelect.value = item.provider;
        localStorage.setItem(storageKeys.provider, item.provider);
        restoreProviderFields();
      }
      elements.modelInput.value = item.model || elements.modelInput.value;
      elements.modelChip.textContent = elements.modelInput.value;
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    elements.historyList.append(button);
  }
}

function clearHistory() {
  history = [];
  localStorage.removeItem(storageKeys.history);
  renderHistory();
  showToast("历史已清空");
}

function joinSpeech(existing, segment) {
  const base = existing.trim();
  const text = segment.trim();
  if (!base) return text;

  const lastChar = base.at(-1);
  const separator = /[。！？!?；;：:\n]$/.test(lastChar) ? "" : "。";
  return `${base}${separator}${text}`;
}

function configureAiSettings(health) {
  aiProviders = Array.isArray(health.providers) && health.providers.length
    ? health.providers
    : [
        {
          id: "deepseek",
          label: "DeepSeek",
          defaultModel: health.defaultModel || "deepseek-v4-flash",
          models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
          endpoint: "https://api.deepseek.com/chat/completions",
          requiresKey: true
        }
      ];

  elements.providerSelect.innerHTML = "";
  for (const provider of aiProviders) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    elements.providerSelect.append(option);
  }

  const savedProvider = localStorage.getItem(storageKeys.provider);
  const defaultProvider = health.defaultProvider || aiProviders[0]?.id || "deepseek";
  elements.providerSelect.value = aiProviders.some(provider => provider.id === savedProvider)
    ? savedProvider
    : defaultProvider;

  if (!elements.providerSelect.value && aiProviders[0]) {
    elements.providerSelect.value = aiProviders[0].id;
  }

  if (localStorage.getItem(storageKeys.rememberKey) !== "false") {
    localStorage.setItem(storageKeys.rememberKey, "true");
  }
  elements.rememberKeyInput.checked = localStorage.getItem(storageKeys.rememberKey) !== "false";

  restoreProviderFields(health);
}

function restoreProviderFields(health = {}) {
  const provider = getSelectedProvider();
  const providerId = provider.id;
  const savedModel = localStorage.getItem(modelStorageKey(providerId));
  const savedEndpoint = localStorage.getItem(apiEndpointStorageKey(providerId));
  const savedKey = localStorage.getItem(apiKeyStorageKey(providerId));
  const oldSavedKey = providerId === "deepseek" ? localStorage.getItem(storageKeys.apiKey) : "";

  elements.modelInput.value =
    savedModel || (providerId === health.defaultProvider ? health.defaultModel : "") ||
    provider.defaultModel ||
    "deepseek-v4-flash";
  elements.modelChip.textContent = elements.modelInput.value;
  elements.apiEndpointInput.value = savedEndpoint || provider.endpoint || "";
  elements.apiKeyInput.value = elements.rememberKeyInput.checked ? savedKey || oldSavedKey || "" : "";

  renderModelOptions(provider);
  persistAiSettings({ skipKey: !elements.rememberKeyInput.checked });
  elements.modelStatus.textContent = getProviderStatusText(provider);
}

function persistAiSettings(options = {}) {
  const provider = getSelectedProvider();
  const providerId = provider.id;

  localStorage.setItem(storageKeys.provider, providerId);
  localStorage.setItem(modelStorageKey(providerId), elements.modelInput.value.trim());
  localStorage.setItem(apiEndpointStorageKey(providerId), elements.apiEndpointInput.value.trim());

  if (!options.skipKey && elements.rememberKeyInput.checked) {
    localStorage.setItem(storageKeys.rememberKey, "true");
    localStorage.setItem(apiKeyStorageKey(providerId), elements.apiKeyInput.value.trim());
  }
}

function getSelectedProvider() {
  return (
    aiProviders.find(provider => provider.id === elements.providerSelect.value) ||
    aiProviders[0] || {
      id: "deepseek",
      label: "DeepSeek",
      defaultModel: "deepseek-v4-flash",
      endpoint: "https://api.deepseek.com/chat/completions",
      requiresKey: true,
      models: []
    }
  );
}

function renderModelOptions(provider) {
  elements.modelOptions.innerHTML = "";
  for (const model of provider.models || []) {
    const option = document.createElement("option");
    option.value = model;
    elements.modelOptions.append(option);
  }
}

function getProviderStatusText(provider) {
  if (!provider.requiresKey) return `${provider.label} 可直接使用`;
  if (provider.hasServerKey || elements.apiKeyInput.value.trim()) {
    return `${provider.label} 已配置`;
  }
  return "等待 API key";
}

function modelStorageKey(providerId) {
  return `${storageKeys.model}:${providerId}`;
}

function apiKeyStorageKey(providerId) {
  return `${storageKeys.apiKey}:${providerId}`;
}

function apiEndpointStorageKey(providerId) {
  return `${storageKeys.apiEndpoint}:${providerId}`;
}

function restoreTheme() {
  const theme = localStorage.getItem(storageKeys.theme);
  if (theme === "dark") {
    document.body.classList.add("dark");
  }
}

function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    storageKeys.theme,
    document.body.classList.contains("dark") ? "dark" : "light"
  );
  drawIdleWave();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2200);
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function labelForMode(mode) {
  return {
    daily: "个人",
    work: "工作",
    todo: "待办",
    formal: "正式"
  }[mode] || "记录";
}

function formatDate(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
