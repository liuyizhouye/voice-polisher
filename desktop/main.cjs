const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const host = "127.0.0.1";
const preferredPort = 47831;

let mainWindow = null;
let appUrl = null;
let serverModule = null;
let isClosingServer = false;
const isSmokeTest = process.argv.includes("--smoke-test");

app.setAppUserModelId("local.voice-polisher");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(startDesktopApp).catch(error => {
    showStartupError(error);
    app.quit();
  });
}

ipcMain.handle("voice-polisher:save-note", async (_event, payload = {}) => {
  const content = String(payload.content || "");
  if (!content.trim()) {
    return { ok: false, error: "没有可保存的内容。" };
  }

  const suggestedName = sanitizeFileName(payload.suggestedName || "voice-note.md");
  const defaultPath = path.join(app.getPath("documents"), suggestedName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存口述整理",
    defaultPath,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Text", extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  await fs.promises.writeFile(result.filePath, content, "utf8");
  return { ok: true, filePath: result.filePath };
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", event => {
  if (!serverModule?.closeServer || isClosingServer) {
    return;
  }

  event.preventDefault();
  isClosingServer = true;
  serverModule.closeServer().finally(() => {
    serverModule = null;
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startDesktopApp().catch(showStartupError);
  }
});

async function startDesktopApp() {
  if (mainWindow) {
    focusMainWindow();
    return;
  }

  writeLog(`starting packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}`);

  if (!isSmokeTest) {
    createMainWindow();
  }

  const port = await findAvailablePort();
  process.env.PORT = String(port);
  process.env.HOST = host;
  process.env.VOICE_POLISHER_DESKTOP = "1";

  const appRoot = getAppRoot();
  const projectDir = getProjectDir(appRoot);
  process.env.VOICE_POLISHER_PROJECT_DIR = projectDir;
  writeLog(`appRoot=${appRoot}`);
  writeLog(`projectDir=${projectDir}`);

  serverModule = await import(pathToFileURL(path.join(appRoot, "server.js")).href);
  const serverInfo = serverModule.serverReady
    ? await serverModule.serverReady
    : { url: `http://${host}:${port}` };

  await waitForServer(serverInfo.url);
  writeLog(`server ready at ${serverInfo.url}`);

  if (isSmokeTest) {
    console.log(`Desktop smoke test passed: ${serverInfo.url}`);
    app.quit();
    return;
  }

  appUrl = serverInfo.url;
  mainWindow.loadURL(serverInfo.url);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: "口述整理台",
    backgroundColor: "#f5f6f4",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 1200);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalIfNeeded(targetUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", event => {
    const targetUrl = event.url;
    if (targetUrl.startsWith("data:")) {
      return;
    }

    if (!appUrl || !targetUrl.startsWith(appUrl)) {
      event.preventDefault();
      openExternalIfNeeded(targetUrl);
    }
  });

  mainWindow.loadURL(getLoadingPageUrl());
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function getAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app");
  }

  return path.resolve(__dirname, "..");
}

function getProjectDir(appRoot) {
  const configuredDir = process.env.VOICE_POLISHER_PROJECT_DIR;
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  const starts = uniquePaths(
    [
      appRoot,
      process.cwd(),
      path.dirname(process.execPath),
      process.resourcesPath,
      path.resolve(appRoot, "..", "..", ".."),
      path.resolve(appRoot, "..", "..", "..", "..")
    ].filter(Boolean)
  );

  for (const start of starts) {
    const projectDir = findUp(start, candidate =>
      fileExists(path.join(candidate, "launcher.ps1")) &&
      fileExists(path.join(candidate, "requirements-whisper.txt"))
    );
    if (projectDir) return projectDir;
  }

  for (const start of starts) {
    const projectDir = findUp(start, candidate =>
      fileExists(path.join(candidate, "requirements-whisper.txt")) &&
      fileExists(path.join(candidate, ".env.example"))
    );
    if (projectDir) return projectDir;
  }

  return appRoot;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findUp(startDir, predicate) {
  let current = path.resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    if (predicate(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths
    .map(value => path.resolve(value))
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function openExternalIfNeeded(targetUrl) {
  if (/^https?:\/\//i.test(targetUrl)) {
    shell.openExternal(targetUrl);
  }
}

function findAvailablePort() {
  const checks = [];
  for (let port = preferredPort; port <= preferredPort + 20; port += 1) {
    checks.push(port);
  }

  return checks.reduce(
    (promise, port) =>
      promise.catch(async () => {
        const available = await isPortAvailable(port);
        if (!available) {
          throw new Error("Port unavailable");
        }
        return port;
      }),
    Promise.reject(new Error("Start search"))
  );
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Try again until the local server finishes binding.
    }

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  throw new Error("口述整理台本地服务启动超时。");
}

function getLoadingPageUrl() {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>口述整理台</title>
    <style>
      html, body {
        height: 100%;
        margin: 0;
        font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
        background: #f5f6f4;
        color: #173c3a;
      }
      body {
        display: grid;
        place-items: center;
      }
      main {
        width: min(420px, calc(100vw - 48px));
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
        font-weight: 700;
      }
      p {
        margin: 0;
        color: #52615f;
        font-size: 15px;
      }
      .bar {
        height: 6px;
        overflow: hidden;
        margin-top: 28px;
        border-radius: 999px;
        background: #dfe7e4;
      }
      .bar::before {
        content: "";
        display: block;
        width: 38%;
        height: 100%;
        border-radius: inherit;
        background: #1f7a6b;
        animation: slide 1.1s ease-in-out infinite;
      }
      @keyframes slide {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(280%); }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>口述整理台</h1>
      <p>正在启动本地桌面应用...</p>
      <div class="bar" aria-hidden="true"></div>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function writeLog(message) {
  try {
    const logDir = path.join(
      process.env.LOCALAPPDATA || process.cwd(),
      "VoicePolisher",
      "logs"
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "desktop.log"),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch {
    // Logging must never block app startup.
  }
}

function showStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  writeLog(`startup error: ${message}\n${error?.stack || ""}`);
  dialog.showErrorBox("口述整理台启动失败", message);
}

function sanitizeFileName(value) {
  const cleaned = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const fileName = cleaned || "voice-note.md";
  return fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`;
}
