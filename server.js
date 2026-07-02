import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");

loadDotEnv(resolve(__dirname, ".env"));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const defaultModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const deepseekEndpoint =
  process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
        defaultModel
      });
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
      temperature: 0.25,
      max_tokens: 4096,
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

  return sendJson(res, 200, {
    refined,
    model: data?.model || model
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

function buildMessages({ transcript, mode, density }) {
  const modeNames = {
    daily: "个人日记或自我记录",
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
        "你是一个中文口述整理助手。你的任务是把用户随口说出的内容整理成他真正想表达的话。",
        "规则：",
        "1. 删除重复、停顿词、口头禅、绕远的话和无意义补充。",
        "2. 保留事实、数字、人物、时间、情绪、判断、原因、结论和行动项。",
        "3. 不编造信息，不添加用户没有表达过的新观点。",
        "4. 如果原文信息不完整，用自然中文保留不确定性。",
        "5. 输出只给整理后的正文，不要解释你的处理过程。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `整理场景：${modeNames[mode] || modeNames.daily}`,
        `详略要求：${densityRules[density] || densityRules.balanced}`,
        "",
        "原始口述：",
        transcript
      ].join("\n")
    }
  ];
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
