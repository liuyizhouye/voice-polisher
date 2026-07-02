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
  transcriptInput: $("#transcriptInput"),
  interimText: $("#interimText"),
  modeSelect: $("#modeSelect"),
  densitySelect: $("#densitySelect"),
  languageSelect: $("#languageSelect"),
  modelInput: $("#modelInput"),
  modelStatus: $("#modelStatus"),
  modelChip: $("#modelChip"),
  apiKeyInput: $("#apiKeyInput"),
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
  microphone: "voice-polisher-microphone",
  theme: "voice-polisher-theme"
};

let recognition = null;
let recognitionState = "idle";
let isRecording = false;
let shouldRestart = false;
let timerId = null;
let recordingWatchdogId = null;
let startedAt = 0;
let audioContext = null;
let audioStream = null;
let analyser = null;
let animationFrame = 0;
let history = loadJson(storageKeys.history, []);

init();

async function init() {
  restoreTheme();
  restoreKey();
  bindEvents();
  renderHistory();
  drawIdleWave();
  await loadMicrophoneDevices().catch(() => {
    elements.listenState.textContent = "麦克风待授权";
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }

  if (!SpeechRecognition) {
    elements.supportStatus.textContent = "当前浏览器不支持听写";
    elements.listenState.textContent = "可直接输入文本";
    elements.recordButton.disabled = true;
  } else {
    elements.supportStatus.textContent = "听写可用";
  }

  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    elements.modelInput.value = health.defaultModel || "deepseek-v4-flash";
    elements.modelChip.textContent = elements.modelInput.value;
    elements.modelStatus.textContent = health.hasServerKey ? "DeepSeek 已配置" : "等待 API key";
  } catch {
    elements.modelStatus.textContent = "本地服务未响应";
  }
}

function bindEvents() {
  elements.recordButton.addEventListener("click", () => {
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
    localStorage.setItem(storageKeys.microphone, elements.microphoneSelect.value);
    if (isRecording) {
      stopRecording();
      window.setTimeout(startRecording, 350);
      return;
    }
    elements.listenState.textContent = "麦克风已选择";
  });

  elements.refreshDevicesButton.addEventListener("click", async () => {
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

  elements.modelInput.addEventListener("input", () => {
    elements.modelChip.textContent = elements.modelInput.value.trim() || "deepseek-v4-flash";
    elements.modelStatus.textContent = "等待连接";
  });

  elements.connectButton.addEventListener("click", testDeepSeekConnection);
  elements.refineButton.addEventListener("click", refineTranscript);
  elements.copyButton.addEventListener("click", copyResult);
  elements.downloadButton.addEventListener("click", downloadResult);
  elements.clearHistoryButton.addEventListener("click", clearHistory);
  elements.themeButton.addEventListener("click", toggleTheme);

  elements.rememberKeyInput.addEventListener("change", () => {
    if (!elements.rememberKeyInput.checked) {
      localStorage.removeItem(storageKeys.apiKey);
      localStorage.setItem(storageKeys.rememberKey, "false");
      showToast("已取消保存 API key");
    } else {
      localStorage.setItem(storageKeys.rememberKey, "true");
      persistKeyIfNeeded();
    }
  });

  elements.apiKeyInput.addEventListener("input", persistKeyIfNeeded);
  elements.apiKeyInput.addEventListener("input", () => {
    elements.modelStatus.textContent = "等待连接";
  });

  window.addEventListener("resize", () => {
    if (!isRecording) drawIdleWave();
  });
}

async function startRecording() {
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
      "not-allowed": "麦克风权限被拒绝，请在浏览器或系统设置里允许麦克风",
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
  elements.recordButton.classList.toggle("is-recording", isRecording);
  elements.recordButtonLabel.textContent = isRecording ? "暂停" : "开始";
  elements.recordButtonIcon.innerHTML = `<i data-lucide="${isRecording ? "pause" : "mic"}"></i>`;
  if (window.lucide) window.lucide.createIcons();
}

function startRecordingWatchdog() {
  stopRecordingWatchdog();
  recordingWatchdogId = window.setTimeout(() => {
    if (!isRecording) return;

    if (recognitionState === "starting") {
      elements.listenState.textContent = "浏览器听写没有响应，请检查麦克风权限";
      showToast("浏览器听写没有响应，请检查麦克风权限");
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

function friendlyMicrophoneError(error) {
  const name = error?.name || "";
  const messages = {
    NotAllowedError: "麦克风权限被拒绝，请在浏览器或系统设置里允许麦克风",
    SecurityError: "麦克风权限被拒绝，请在浏览器或系统设置里允许麦克风",
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

  persistKeyIfNeeded();
  const apiKey = elements.apiKeyInput.value.trim();
  const model = elements.modelInput.value.trim() || "deepseek-v4-flash";

  elements.refineButton.disabled = true;
  elements.refineButton.querySelector("span").textContent = "整理中";
  elements.modelChip.textContent = model;

  try {
    const headers = {
      "Content-Type": "application/json"
    };

    if (apiKey) {
      headers["x-deepseek-api-key"] = apiKey;
    }

    const response = await fetch("/api/refine", {
      method: "POST",
      headers,
      body: JSON.stringify({
        transcript,
        mode: elements.modeSelect.value,
        density: elements.densitySelect.value,
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

async function testDeepSeekConnection() {
  persistKeyIfNeeded();

  const apiKey = elements.apiKeyInput.value.trim();
  const model = elements.modelInput.value.trim() || "deepseek-v4-flash";

  if (!apiKey) {
    showToast("先粘贴 DeepSeek API key");
    elements.apiKeyInput.focus();
    return;
  }

  elements.connectButton.disabled = true;
  elements.connectButton.querySelector("span").textContent = "连接中";
  elements.modelStatus.textContent = "正在连接 DeepSeek";

  try {
    const response = await fetch("/api/test-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-deepseek-api-key": apiKey
      },
      body: JSON.stringify({ model })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "连接失败");
    }

    elements.modelStatus.textContent = "DeepSeek 已连接";
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

function restoreKey() {
  const remember = localStorage.getItem(storageKeys.rememberKey) === "true";
  elements.rememberKeyInput.checked = remember;

  if (remember) {
    elements.apiKeyInput.value = localStorage.getItem(storageKeys.apiKey) || "";
  }
}

function persistKeyIfNeeded() {
  if (!elements.rememberKeyInput.checked) return;

  localStorage.setItem(storageKeys.rememberKey, "true");
  localStorage.setItem(storageKeys.apiKey, elements.apiKeyInput.value.trim());
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
