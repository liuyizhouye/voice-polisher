import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const nativeDictationScript = resolve(__dirname, "scripts", "native-dictation.ps1");
const localWhisperScript = resolve(__dirname, "scripts", "local-whisper-recorder.py");
const localPythonPath = resolve(__dirname, ".venv", "Scripts", "python.exe");

loadDotEnv(resolve(__dirname, ".env"));

const port = Number(process.env.PORT || 47831);
const host = process.env.HOST || "127.0.0.1";
const defaultModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const defaultWhisperModel = process.env.WHISPER_MODEL || "large-v3";
const defaultWhisperDevice = process.env.WHISPER_DEVICE || "cuda";
const defaultWhisperComputeType = process.env.WHISPER_COMPUTE_TYPE || "float16";
const deepseekEndpoint =
  process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
let nativeDictation = null;
const nativeSpeechClients = new Set();
let localWhisper = null;
const localWhisperClients = new Set();
let localWhisperShutdownTimer = null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const server = createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error"
    });
  });
});

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        hasServerKey: Boolean(process.env.DEEPSEEK_API_KEY),
        defaultModel,
        nativeSpeech: getNativeSpeechStatus(),
        localWhisper: getLocalWhisperStatus()
      });
    }

    if (req.method === "GET" && url.pathname === "/api/local-whisper/status") {
      return sendJson(res, 200, getLocalWhisperStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/local-whisper/devices") {
      return await handleLocalWhisperDevices(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/local-whisper/events") {
      return handleLocalWhisperEvents(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/local-whisper/preload") {
      return await handleLocalWhisperPreload(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/local-whisper/start") {
      return await handleLocalWhisperStart(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/local-whisper/stop") {
      stopLocalWhisperRecording();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/native-speech/status") {
      return sendJson(res, 200, getNativeSpeechStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/native-speech/events") {
      return handleNativeSpeechEvents(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/native-speech/start") {
      return await handleNativeSpeechStart(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/native-speech/stop") {
      stopNativeDictation();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/refine") {
      return await handleRefine(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/test-key") {
      return await handleTestKey(req, res);
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error"
    });
  }
}

let activePort = port;
server.on("error", error => {
  if (error.code === "EADDRINUSE" && activePort < port + 20) {
    activePort += 1;
    server.listen(activePort, host);
    return;
  }

  throw error;
});

server.listen(activePort, host, () => {
  console.log(`Voice Polisher running at http://${host}:${activePort}`);
  if (activePort !== port) {
    console.log(`Port ${port} was busy, so this session is using ${activePort}.`);
  }
});

process.on("SIGINT", () => {
  stopLocalWhisperWorker();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopLocalWhisperWorker();
  process.exit(0);
});

process.on("exit", () => {
  stopLocalWhisperWorker();
});

async function handleRefine(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
  }

  const transcript = String(body.transcript || "").trim();
  const mode = String(body.mode || "daily");
  const density = String(body.density || "balanced");
  const model = String(body.model || defaultModel).trim() || defaultModel;
  const apiKey = getApiKey(req, body);

  if (!transcript) {
    return sendJson(res, 400, { error: "没有可整理的口述内容。" });
  }

  if (transcript.length > 24000) {
    return sendJson(res, 413, { error: "内容太长，请分段整理。" });
  }

  if (shouldReturnLiteral(transcript)) {
    return sendJson(res, 200, {
      refined: transcript,
      model,
      guarded: true
    });
  }

  if (!apiKey) {
    return sendJson(res, 401, {
      error: "缺少 DeepSeek API key。请在 .env 中设置，或在页面设置里临时填写。"
    });
  }

  const response = await fetch(deepseekEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      thinking: { type: "disabled" },
      temperature: 0,
      max_tokens: getMaxTokensForTranscript(transcript),
      messages: buildMessages({ transcript, mode, density })
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return sendJson(res, response.status, {
      error:
        data?.error?.message ||
        data?.message ||
        `DeepSeek 请求失败，状态码 ${response.status}。`
    });
  }

  const refined = data?.choices?.[0]?.message?.content?.trim();

  if (!refined) {
    return sendJson(res, 502, { error: "DeepSeek 没有返回可用内容。" });
  }

  const guardedRefined = guardRefinedOutput(transcript, refined);

  return sendJson(res, 200, {
    refined: guardedRefined,
    model: data?.model || model,
    guarded: guardedRefined !== refined
  });
}

async function handleTestKey(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
  }

  const model = String(body.model || defaultModel).trim() || defaultModel;
  const apiKey = getApiKey(req, body);

  if (!apiKey) {
    return sendJson(res, 401, { error: "请先粘贴 DeepSeek API key。" });
  }

  const response = await fetch(deepseekEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      thinking: { type: "disabled" },
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: "system",
          content: "你是连通性测试助手，只回复 OK。"
        },
        {
          role: "user",
          content: "测试连接"
        }
      ]
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return sendJson(res, response.status, {
      error:
        data?.error?.message ||
        data?.message ||
        `DeepSeek 连接失败，状态码 ${response.status}。`
    });
  }

  return sendJson(res, 200, {
    ok: true,
    model: data?.model || model
  });
}

async function handleNativeSpeechStart(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
  }

  const culture = normalizeSpeechCulture(String(body.culture || "zh-CN"));

  if (!getNativeSpeechStatus().available) {
    return sendJson(res, 501, {
      error: "当前系统不支持本地听写。"
    });
  }

  if (nativeDictation?.process && !nativeDictation.process.killed) {
    return sendJson(res, 200, { ok: true, alreadyRunning: true });
  }

  startNativeDictation(culture);
  return sendJson(res, 200, { ok: true });
}

function handleNativeSpeechEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1000\n\n");

  nativeSpeechClients.add(res);
  sendNativeSpeechEvent({ type: "status", message: "系统听写通道已连接。" }, res);

  req.on("close", () => {
    nativeSpeechClients.delete(res);
  });
}

async function handleLocalWhisperDevices(req, res) {
  const status = getLocalWhisperStatus();
  if (!status.available) {
    return sendJson(res, 501, {
      error: "本地 Whisper 环境未安装。请先运行 scripts\\setup-local-whisper.ps1。"
    });
  }

  try {
    const payload = await runLocalWhisperUtility(["--list-devices"]);
    return sendJson(res, 200, { devices: payload.devices || [] });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "麦克风列表读取失败。"
    });
  }
}

async function handleLocalWhisperPreload(req, res) {
  const status = getLocalWhisperStatus();
  if (!status.available) {
    return sendJson(res, 501, {
      error: "本地 Whisper 环境未安装。请先运行 scripts\\setup-local-whisper.ps1。"
    });
  }

  ensureLocalWhisperWorker();
  return sendJson(res, 200, { ok: true, localWhisper: getLocalWhisperStatus() });
}

async function handleLocalWhisperStart(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
  }

  const status = getLocalWhisperStatus();
  if (!status.available) {
    return sendJson(res, 501, {
      error: "本地 Whisper 环境未安装。请先运行 scripts\\setup-local-whisper.ps1。"
    });
  }

  const worker = ensureLocalWhisperWorker();
  if (!worker.ready) {
    return sendJson(res, 409, {
      error: "本地 Whisper 模型还在下载/加载，请等进度条完成。",
      localWhisper: getLocalWhisperStatus()
    });
  }

  if (worker.recording || worker.transcribing) {
    return sendJson(res, 409, { error: "本地 Whisper 正在录音或转写。" });
  }

  sendLocalWhisperCommand({
    type: "record",
    language: normalizeWhisperLanguage(String(body.language || "zh-CN")),
    inputDevice: body.inputDevice ?? null
  });
  return sendJson(res, 200, { ok: true });
}

function handleLocalWhisperEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1000\n\n");

  clearLocalWhisperShutdownTimer();
  localWhisperClients.add(res);
  sendLocalWhisperEvent(
    {
      type: "status",
      message: "本地 Whisper 通道已连接。",
      localWhisper: getLocalWhisperStatus()
    },
    res
  );

  if (localWhisper?.lastEvent) {
    sendLocalWhisperEvent(localWhisper.lastEvent, res);
  }

  req.on("close", () => {
    localWhisperClients.delete(res);
    scheduleLocalWhisperShutdownIfIdle();
  });
}

function ensureLocalWhisperWorker() {
  if (localWhisper?.process && !localWhisper.process.killed) {
    clearLocalWhisperShutdownTimer();
    return localWhisper;
  }

  return startLocalWhisperWorker();
}

function startLocalWhisperWorker() {
  const python = getLocalPythonPath();
  const child = spawn(
    python,
    [
      localWhisperScript,
      "--model",
      defaultWhisperModel,
      "--language",
      "zh",
      "--device",
      defaultWhisperDevice,
      "--compute-type",
      defaultWhisperComputeType
    ],
    {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const session = {
    process: child,
    buffer: "",
    model: defaultWhisperModel,
    device: defaultWhisperDevice,
    computeType: defaultWhisperComputeType,
    ready: false,
    loading: true,
    recording: false,
    transcribing: false,
    progress: 0,
    message: "正在启动本地 Whisper 引擎",
    lastEvent: null
  };
  localWhisper = session;
  sendLocalWhisperEvent({
    type: "progress",
    progress: 1,
    message: session.message,
    model: session.model,
    device: session.device,
    computeType: session.computeType
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    session.buffer += chunk;
    let newlineIndex = session.buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = session.buffer.slice(0, newlineIndex).trim();
      session.buffer = session.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          handleLocalWhisperWorkerEvent(session, JSON.parse(line));
        } catch {
          handleLocalWhisperWorkerEvent(session, { type: "status", message: line });
        }
      }
      newlineIndex = session.buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    const message = chunk.trim();
    if (message && !isIgnorableWhisperWarning(message)) {
      sendLocalWhisperEvent({ type: "warning", message });
    }
  });

  child.on("error", error => {
    handleLocalWhisperWorkerEvent(session, {
      type: "error",
      fatal: true,
      message: error instanceof Error ? error.message : "本地 Whisper 启动失败。"
    });
  });

  child.on("exit", (code, signal) => {
    if (localWhisper === session) {
      localWhisper = null;
    }
    sendLocalWhisperEvent({
      type: "workerStopped",
      code,
      signal
    });
  });

  return session;
}

function handleLocalWhisperWorkerEvent(session, event) {
  const type = event?.type;

  if (type === "progress") {
    session.loading = true;
    session.progress = clampProgress(event.progress);
    session.message = event.message || session.message;
    session.lastEvent = event;
  } else if (type === "ready") {
    session.ready = true;
    session.loading = false;
    session.progress = 100;
    session.message = event.message || "本地 Whisper 已就绪";
    session.lastEvent = event;
  } else if (type === "recording") {
    session.recording = true;
    session.transcribing = false;
  } else if (type === "transcribing") {
    session.recording = false;
    session.transcribing = true;
  } else if (type === "result" || type === "idle") {
    session.recording = false;
    session.transcribing = false;
  } else if (type === "error") {
    session.recording = false;
    session.transcribing = false;
    if (event.fatal) {
      session.ready = false;
      session.loading = false;
      session.message = event.message || "本地 Whisper 启动失败";
      session.lastEvent = event;
    }
  } else if (type === "devices") {
    session.devices = event.devices || [];
  }

  sendLocalWhisperEvent(event);
}

function isIgnorableWhisperWarning(message) {
  return (
    message.includes("HF_HUB_DISABLE_SYMLINKS_WARNING") ||
    message.includes("HF_TOKEN") ||
    message.includes("huggingface_hub") ||
    message.includes("file_download.py")
  );
}

function runLocalWhisperUtility(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(getLocalPythonPath(), [localWhisperScript, ...args], {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });

    child.on("error", rejectPromise);
    child.on("exit", code => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || "本地 Whisper 工具执行失败。"));
        return;
      }

      const line = stdout
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean)
        .at(-1);

      if (!line) {
        resolvePromise({});
        return;
      }

      try {
        resolvePromise(JSON.parse(line));
      } catch {
        rejectPromise(new Error(line));
      }
    });
  });
}

function stopLocalWhisperRecording() {
  if (!localWhisper?.process) return;

  sendLocalWhisperCommand({ type: "stop" });
}

function sendLocalWhisperCommand(command) {
  if (!localWhisper?.process || localWhisper.process.killed) return false;
  if (!localWhisper.process.stdin.writable) return false;

  localWhisper.process.stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

function scheduleLocalWhisperShutdownIfIdle() {
  clearLocalWhisperShutdownTimer();

  localWhisperShutdownTimer = setTimeout(() => {
    if (localWhisperClients.size > 0) return;
    stopLocalWhisperWorker();
  }, 5000);
}

function clearLocalWhisperShutdownTimer() {
  if (localWhisperShutdownTimer) {
    clearTimeout(localWhisperShutdownTimer);
    localWhisperShutdownTimer = null;
  }
}

function stopLocalWhisperWorker() {
  if (!localWhisper?.process) return;

  const child = localWhisper.process;
  sendLocalWhisperCommand({ type: "shutdown" });

  setTimeout(() => {
    if (!child.killed) {
      child.kill();
    }
  }, 1800);
}

function sendLocalWhisperEvent(payload, target = null) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const clients = target ? [target] : localWhisperClients;

  for (const client of clients) {
    client.write(data);
  }
}

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function startNativeDictation(culture) {
  stopNativeDictation();

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      nativeDictationScript,
      "-Culture",
      culture
    ],
    {
      cwd: __dirname,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const dictationState = {
    process: child,
    buffer: ""
  };
  nativeDictation = dictationState;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    dictationState.buffer += chunk;
    let newlineIndex = dictationState.buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = dictationState.buffer.slice(0, newlineIndex).trim();
      dictationState.buffer = dictationState.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          sendNativeSpeechEvent(JSON.parse(line));
        } catch {
          sendNativeSpeechEvent({ type: "status", message: line });
        }
      }
      newlineIndex = dictationState.buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    const message = chunk.trim();
    if (message) {
      sendNativeSpeechEvent({ type: "error", message });
    }
  });

  child.on("error", error => {
    sendNativeSpeechEvent({
      type: "error",
      message: error instanceof Error ? error.message : "系统听写启动失败。"
    });
  });

  child.on("exit", (code, signal) => {
    sendNativeSpeechEvent({
      type: "stopped",
      code,
      signal
    });
    nativeDictation = null;
  });
}

function stopNativeDictation() {
  if (!nativeDictation?.process) return;

  const child = nativeDictation.process;
  nativeDictation = null;

  if (!child.killed) {
    child.kill();
  }
}

function sendNativeSpeechEvent(payload, target = null) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const clients = target ? [target] : nativeSpeechClients;

  for (const client of clients) {
    client.write(data);
  }
}

function getNativeSpeechStatus() {
  return {
    available: process.platform === "win32" && existsSync(nativeDictationScript),
    defaultCulture: "zh-CN",
    usesSystemMicrophone: true,
    running: Boolean(nativeDictation?.process && !nativeDictation.process.killed)
  };
}

function getLocalWhisperStatus() {
  const workerRunning = Boolean(localWhisper?.process && !localWhisper.process.killed);
  return {
    available: existsSync(localWhisperScript) && existsSync(getLocalPythonPath()),
    installed: existsSync(getLocalPythonPath()),
    defaultModel: defaultWhisperModel,
    device: defaultWhisperDevice,
    computeType: defaultWhisperComputeType,
    workerRunning,
    ready: Boolean(workerRunning && localWhisper.ready),
    loading: Boolean(workerRunning && localWhisper.loading),
    recording: Boolean(workerRunning && localWhisper.recording),
    transcribing: Boolean(workerRunning && localWhisper.transcribing),
    progress: workerRunning ? localWhisper.progress || 0 : 0,
    message: workerRunning ? localWhisper.message || "" : "",
    running: Boolean(workerRunning && localWhisper.recording)
  };
}

function getLocalPythonPath() {
  return process.env.WHISPER_PYTHON || localPythonPath;
}

function normalizeSpeechCulture(culture) {
  return {
    "zh-CN": "zh-CN",
    "zh-TW": "zh-CN",
    "en-US": "en-US"
  }[culture] || "zh-CN";
}

function normalizeWhisperLanguage(language) {
  return {
    "zh-CN": "zh",
    "zh-TW": "zh",
    "en-US": "en"
  }[language] || "zh";
}

function buildMessages({ transcript, mode, density }) {
  const modeNames = {
    daily: "普通口述记录",
    work: "工作记录",
    todo: "待办清单",
    formal: "正式表达"
  };

  const densityRules = {
    concise: "尽量短，只保留核心意思。",
    balanced: "适度整理，保留主要细节和语气。",
    complete: "整理成完整段落，保留事实、情绪、因果和行动项。"
  };

  return [
    {
      role: "system",
      content: [
        "你是一个中文口述忠实整理助手。你的任务是只整理用户已经说出的内容。",
        "这是忠实改写，不是续写、创作、补全、日记生成或内容生成。",
        "规则：",
        "1. 删除重复、停顿词、口头禅、绕远的话和无意义补充。",
        "2. 保留事实、数字、人物、时间、情绪、判断、原因、结论和行动项。",
        "3. 严禁编造原文没有出现的日期、地点、人物、事件、动作、情绪或细节。",
        "4. 如果原文只有数字、符号、乱码、单个词或信息不足，必须原样输出，不要解释。",
        "5. 如果原文信息不完整，用原文已有信息自然表达，不要补齐背景。",
        "6. 输出信息量不得超过原文；通常只做断句、去口头禅和轻微顺句。",
        "7. 输出只给整理后的正文，不要解释你的处理过程。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `整理场景：${modeNames[mode] || modeNames.daily}`,
        `详略要求：${densityRules[density] || densityRules.balanced}`,
        "",
        "只整理以下分隔符内的原始口述，不要使用任何外部上下文：",
        "<<<原始口述",
        transcript,
        "原始口述>>>"
      ].join("\n")
    }
  ];
}

function shouldReturnLiteral(transcript) {
  const compact = transcript.replace(/\s+/g, "");
  if (!compact) return true;

  const meaningfulCount = countMeaningfulChars(compact);
  const hasLetter = /\p{L}/u.test(compact);
  const onlyNumbersAndSymbols = /^[\p{N}\p{P}\p{S}]+$/u.test(compact);

  return (
    meaningfulCount <= 4 ||
    (!hasLetter && onlyNumbersAndSymbols) ||
    /^(.{1,3})\1{2,}$/u.test(compact)
  );
}

function guardRefinedOutput(transcript, refined) {
  if (isUnsafeExpansion(transcript, refined)) {
    return transcript;
  }

  return refined;
}

function isUnsafeExpansion(transcript, refined) {
  const inputLength = countMeaningfulChars(transcript);
  const outputLength = countMeaningfulChars(refined);

  if (inputLength <= 4) return refined.trim() !== transcript.trim();
  if (inputLength <= 12) return outputLength > inputLength + 20;
  if (inputLength <= 40) return outputLength > Math.max(inputLength * 4, inputLength + 60);

  return outputLength > Math.max(inputLength * 3, inputLength + 240);
}

function countMeaningfulChars(value) {
  return Array.from(String(value)).filter(char => /[\p{L}\p{N}]/u.test(char)).length;
}

function getMaxTokensForTranscript(transcript) {
  const length = countMeaningfulChars(transcript);
  return Math.min(4096, Math.max(64, Math.ceil(length * 3.2 + 80)));
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const ext = extname(filePath);
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy();
        rejectBody(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error("Invalid JSON"));
      }
    });
    req.on("error", rejectBody);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function getApiKey(req, body) {
  return (
    String(req.headers["x-deepseek-api-key"] || "").trim() ||
    String(body.apiKey || "").trim() ||
    process.env.DEEPSEEK_API_KEY
  );
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
