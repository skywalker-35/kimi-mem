// kimi-mem daemon：独立启动 opencode-mem 的 WebServer（存储 + Web UI + HTTP API）
// 用法: node start.mjs   （或 bun start.mjs）
// 配置: 复用 opencode-mem 的 ~/.config/opencode/opencode-mem.jsonc（存储共享）
// 端口: KIMI_MEM_PORT 环境变量，默认 5757（避开 opencode-mem 自己的 4747）
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "opencode-mem", "dist");
const imp = (...segs) => import(pathToFileURL(path.join(dist, ...segs)).href);

// initConfig 会重建 CONFIG 对象（let 重赋值），解构快照会失效；用命名空间访问拿当前对象
const configMod = await imp("config.js");
const { initConfig } = configMod;
const { ensureTursoReady } = await imp("services", "turso", "ready.js");
const { startWebServer } = await imp("services", "web-server.js");
const { WebAuth } = await imp("services", "web-auth.js");

initConfig(process.cwd());

// 用户画像的默认 userId 解析（/api/user-profile 不带参数时）走 vendor getTags(process.cwd())，
// 其 getGitEmail 用 `git config user.email` 依赖进程 cwd，daemon 的 cwd 不在用户项目里会拿不到，
// Web UI 用户画像页因此显示 "No profile found"。画像本来就是用户级（跨项目）的，
// 这里从 ~/.kimi-mem/user-email 恢复（由 capture-core 首次解析后写入；
// 配置文件里已设 userEmailOverride 则不覆盖）
if (!configMod.CONFIG.userEmailOverride) {
  try {
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const email = readFileSync(
      path.join(homedir(), ".kimi-mem", "user-email"),
      "utf8"
    ).trim();
    if (email) configMod.CONFIG.userEmailOverride = email;
  } catch {
    // 文件不存在就保持原行为（首次捕获后会有）
  }
}

// ── Turso 锁探测退避（方案 A）─────────────────────────────────────────────
// opencode-mem 插件（v2.2x+ Turso 引擎）与本 daemon 共享 ~/.opencode-mem/data，
// Windows 上 Turso 只允许单进程持有数据库所有权：谁先启动谁持锁，后到者初始化直接失败。
// 策略：锁空闲 → 正常初始化；锁被占 → 后台轮询等待，期间：
//   - WebServer(:5757) 暂不监听（未就绪语义与 README FAQ 的 ":5757 可访问" 判断一致）
//   - sidecar capture(:port+11) 照常接收，请求进内存队列，拿到锁后按序 flush
const RETRY_INTERVAL_MS = Number(process.env.KIMI_MEM_RETRY_MS ?? 30_000);
const CAPTURE_QUEUE_MAX = 200;

let tursoReady = false;
let serverRef = null; // shutdown 用；等待锁期间 WebServer 尚未启动
const captureQueue = [];

async function tryAcquireTurso() {
  try {
    await ensureTursoReady();
    tursoReady = true;
    return true;
  } catch (err) {
    const brief = String(err?.message ?? err).split("\n")[0].slice(0, 160);
    console.warn(`[kimi-mem] storage locked by another process: ${brief}`);
    return false;
  }
}

async function startWebServerWhenReady() {
  serverRef = await startWebServer({
    port: Number(process.env.KIMI_MEM_PORT ?? 5757),
    host: "127.0.0.1",
    enabled: true,
    auth: new WebAuth({
      password: configMod.CONFIG.webServerAuthPassword,
      username: configMod.CONFIG.webServerAuthUsername,
    }),
    apiToken: configMod.CONFIG.webServerApiToken,
  });
  console.log(`[kimi-mem] daemon ready at ${serverRef.getUrl()}`);
}

async function flushCaptureQueue() {
  while (captureQueue.length > 0) {
    const job = captureQueue.shift();
    try {
      await runCapture(job);
    } catch (err) {
      console.warn(
        `[kimi-mem] queued capture failed: ${String(err?.message ?? err).slice(0, 160)}`
      );
    }
  }
}

// ensureTursoReady 内部有 isReady/initPromise 守卫且失败时重置，可安全反复调用
async function pollUntilTursoReady() {
  while (!tursoReady) {
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    if (await tryAcquireTurso()) {
      console.log(
        "[kimi-mem] storage lock acquired; starting WebServer and flushing queued captures"
      );
      await startWebServerWhenReady();
      await flushCaptureQueue();
    }
  }
}

if (await tryAcquireTurso()) {
  await startWebServerWhenReady();
} else {
  console.warn(
    `[kimi-mem] entering retry loop every ${RETRY_INTERVAL_MS / 1000}s until the lock holder exits...`
  );
  pollUntilTursoReady(); // 后台轮询，不阻塞 sidecar 启动
}

// sidecar：接收 hooks 发来的捕获请求，在 daemon 进程内执行（隐藏后台，无窗口）
// POST /capture {session_id, cwd, event}，需要 x-opencode-mem-token 头
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const { runCapture } = await import(
  pathToFileURL(path.join(here, "capture-core.mjs")).href
);

// sidecar 固定在 base+11：上游 v2.25.0 起 WebServer 接管失败会按 base+1..base+10 回退端口，
// sidecar 若留在 base+1 会被回退的 WebServer 抢占，导致 capture 静默 404 丢失
const sidecarPort = Number(process.env.KIMI_MEM_PORT ?? 5757) + 11;
const sidecar = http.createServer((req, res) => {
  const token = readFileSync(
    path.join(homedir(), ".opencode-mem", ".auth-token"),
    "utf8"
  ).trim();
  if (req.headers["x-opencode-mem-token"] !== token) {
    res.writeHead(401).end('{"error":"unauthorized"}');
    return;
  }
  if (req.method === "POST" && req.url === "/capture") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { session_id, cwd, event } = JSON.parse(body);
        if (!session_id || !cwd) throw new Error("missing session_id/cwd");
        if (!tursoReady) {
          // 引擎等待锁中：入队暂存，拿到锁后按序 flush（超限丢最旧）
          if (captureQueue.length >= CAPTURE_QUEUE_MAX) captureQueue.shift();
          captureQueue.push({ sessionId: session_id, cwd, event });
          res.writeHead(202).end('{"accepted":true,"queued":true}');
          return;
        }
        runCapture({ sessionId: session_id, cwd, event });
        res.writeHead(202).end('{"accepted":true}');
      } catch {
        res.writeHead(400).end('{"error":"bad payload"}');
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res
      .writeHead(200)
      .end(
        JSON.stringify({
          status: "ok",
          tursoReady,
          queued: captureQueue.length,
        })
      );
    return;
  }
  res.writeHead(404).end();
});
sidecar.listen(sidecarPort, "127.0.0.1", () => {
  console.log(`[kimi-mem] sidecar capture endpoint on :${sidecarPort}`);
});

// web-server.ts 的 Node 路径对 server 调了 unref()，需要一个 ref 句柄保住事件循环
setInterval(() => {}, 1 << 30);

const shutdown = async () => {
  try {
    sidecar.close();
    await serverRef?.stop?.();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
