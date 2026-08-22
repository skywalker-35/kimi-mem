// kimi-mem 插件公共库：配置、token、daemon 保活、项目 tag
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// daemon 目录默认解析：优先 PLUGIN_ROOT/daemon（release zip 布局，daemon 收在插件根内），
// 否则 PLUGIN_ROOT/../daemon（源码仓库布局，plugin/ 与 daemon/ 平级），
// 都不是则返回后者（会在 ensureDaemon 里报"找不到 daemon 入口"并在日志提示配置 daemonHome）
function defaultDaemonHome() {
  const inside = path.resolve(PLUGIN_ROOT, "daemon");
  if (fs.existsSync(path.join(inside, "start.mjs"))) return inside;
  return path.resolve(PLUGIN_ROOT, "..", "daemon");
}

const DEFAULTS = {
  port: 5757,
  // daemon 代码目录；见 defaultDaemonHome。还可在 kimi-mem.config.json 显式配置 daemonHome
  daemonHome: defaultDaemonHome(),
  inject: { enabled: true, maxResults: 5, minPromptLength: 8 },
  capture: {
    enabled: true,
    minIntervalSec: 120,
    provider: "openai-chat",
    // 默认按 OpenAI 官方约定；用其他 OpenAI 兼容服务（DeepSeek/火山方舟/MiniMax 等）
    // 时在配置里覆盖 apiUrl / apiKeyEnv / model 即可
    apiUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    // 模型名，必须在 kimi-mem.config.json 里配置自己的
    model: "",
    extraParams: { reasoning_effort: "low" },
    maxContextBytes: 60000,
    notify: true,
  },
  // 用户画像自动学习：每积累 analysisInterval 条未学习 prompt 触发一次 LLM 分析
  // 注入侧：在 <kimi-mem-context> 块里追加用户画像段（前提是已学到画像）
  profile: { enabled: true, analysisInterval: 10 },
};

let cachedConfig = null;
export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  };
  // 合并顺序：内置默认 < 插件目录配置（发布模板）< 用户级配置（私密值放这里）
  // 用户级配置 ~/.kimi-mem/kimi-mem.config.json 不进 git，适合放 daemonHome / model / bunPath 等本机私密值
  const repo = read(path.join(PLUGIN_ROOT, "kimi-mem.config.json"));
  const home = read(
    path.join(os.homedir(), ".kimi-mem", "kimi-mem.config.json")
  );
  const merge = (base, over) => ({ ...base, ...over });
  cachedConfig = {
    ...merge(DEFAULTS, repo),
    ...home,
    inject: merge(merge(DEFAULTS.inject, repo.inject ?? {}), home.inject ?? {}),
    capture: merge(
      merge(DEFAULTS.capture, repo.capture ?? {}),
      home.capture ?? {}
    ),
    profile: merge(
      merge(DEFAULTS.profile, repo.profile ?? {}),
      home.profile ?? {}
    ),
  };
  return cachedConfig;
}

export function apiBase() {
  return `http://127.0.0.1:${loadConfig().port}`;
}

// opencode-mem 的 WebServer 对所有 /api/* 请求强制校验该 token（防 CSRF）
export function readApiToken() {
  try {
    return fs
      .readFileSync(path.join(os.homedir(), ".opencode-mem", ".auth-token"), "utf8")
      .trim();
  } catch {
    return "";
  }
}

export async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function isDaemonUp() {
  try {
    const res = await fetch(`${apiBase()}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// daemon 未运行时后台拉起；最多等待 waitMs 直到健康
// 必须用 bun：web-server 的 Node http 适配层对带 body 的 POST 会提前断连（上游 bug）
// bun 解析顺序：config.bunPath > KIMI_MEM_BUN 环境变量 > 标准安装位置 > PATH 中的 bun
function resolveBun() {
  const cfg = loadConfig();
  const candidates = [
    cfg.bunPath,
    process.env.KIMI_MEM_BUN,
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
  ].filter(Boolean);
  // 都找不到时返回 "bun"，交给 spawn 走 PATH 解析（ENOENT 由调用方 error 事件处理）
  return candidates.find((p) => fs.existsSync(p)) ?? "bun";
}

export async function ensureDaemon(waitMs = 10000) {
  if (await isDaemonUp()) return true;
  const { daemonHome } = loadConfig();
  const entry = path.join(daemonHome, "start.mjs");
  const bun = resolveBun();
  if (!fs.existsSync(entry)) {
    logDebug(`ensureDaemon: 找不到 daemon 入口 ${entry}（请检查 daemonHome 配置）`);
    return false;
  }
  // 首次运行 bootstrap：release zip 不带 vendor node_modules（体积太大），
  // 检测到缺失就后台跑 bun install（依 bun.lock，幂等）。用锁文件防多 hook 并发重复安装；
  // 安装可能超过 hook 超时，故本次先返回 false，装完后下次 hook 会自动拉起 daemon
  const vendorDir = path.join(daemonHome, "opencode-mem");
  if (!fs.existsSync(path.join(vendorDir, "node_modules"))) {
    const lock = path.join(os.tmpdir(), "kimi-mem-bun-install.lock");
    const stale =
      !fs.existsSync(lock) ||
      Date.now() - fs.statSync(lock).mtimeMs > 10 * 60 * 1000;
    if (stale) {
      try {
        fs.writeFileSync(lock, String(Date.now()));
        const child = spawn(bun, ["install"], {
          cwd: vendorDir,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", (err) =>
          logDebug(`ensureDaemon bootstrap bun install error: ${err}`)
        );
        child.unref();
        logDebug("ensureDaemon: 首次运行，后台 bun install 安装 vendor 依赖中");
      } catch (err) {
        logDebug(`ensureDaemon bootstrap error: ${err}`);
      }
    }
    return false;
  }
  if (!fs.existsSync(path.join(vendorDir, "dist", "config.js"))) {
    logDebug(
      `ensureDaemon: vendor 未构建（缺 dist/），请在 ${vendorDir} 执行 bun install && bun x tsc，并在 web/ 下 bun install && bun run build`
    );
    return false;
  }
  // spawn 的 ENOENT 通过 error 事件异步抛出，不监听会让进程崩溃
  const spawned = await new Promise((resolve) => {
    const child = spawn(bun, [entry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => {
      logDebug(`ensureDaemon spawn error（bun=${bun}）: ${err}`);
      resolve(false);
    });
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
  if (!spawned) return false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonUp()) return true;
  }
  return false;
}

// 复用 opencode-mem 官方 tag 算法，保证写入的记忆落在同一个 shard
export async function getProjectTag(cwd) {
  const { daemonHome } = loadConfig();
  const tagsPath = path.join(
    daemonHome,
    "opencode-mem",
    "dist",
    "services",
    "tags.js"
  );
  const { getProjectTagInfo } = await import(pathToFileURL(tagsPath).href);
  return getProjectTagInfo(cwd).tag;
}

// 进程内直连 vendor dist 的模块；用于调 HTTP API 不覆盖的能力
// （export / import / listShards / migrate 这 4 个 mode 没有 HTTP 入口）
// 必须先调 initConfig(cwd) 才能用 memoryClient —— CONFIG 全局变量由它填充
// 也承载用户画像能力：getTags (取 userId) + getUserProfileContext (生成注入文本)
let vendorCache = null;
export async function loadVendorMemory(cwd) {
  if (vendorCache) {
    // initConfig 是同步函数，可以重入（重新加载项目级配置覆盖），不破坏缓存
    vendorCache.initConfig(cwd);
    return vendorCache;
  }
  const { daemonHome } = loadConfig();
  const dist = path.join(daemonHome, "opencode-mem", "dist");
  const vend = (...segs) =>
    import(pathToFileURL(path.join(dist, ...segs)).href);
  const { initConfig } = await vend("config.js");
  initConfig(cwd);
  const { memoryClient } = await vend("services", "client.js");
  const { stripPrivateContent, isFullyPrivate } = await vend(
    "services",
    "privacy.js"
  );
  // 用户画像：getTags 取 userId（userEmail）；getUserProfileContext 生成注入文本（纯 DB 查询，不触发 embedding）
  const { getTags } = await vend("services", "tags.js");
  const { getUserProfileContext } = await vend(
    "services",
    "user-profile",
    "profile-context.js"
  );
  vendorCache = {
    initConfig,
    memoryClient,
    stripPrivateContent,
    isFullyPrivate,
    getTags,
    getUserProfileContext,
  };
  return vendorCache;
}

export function logDebug(msg) {
  try {
    const dir = path.join(os.homedir(), ".kimi-mem");
    fs.mkdirSync(dir, { recursive: true });
    // 本地时区时间（东八区），别用 toISOString 的 UTC
    const ts = new Date().toLocaleString("zh-CN", { hour12: false });
    fs.appendFileSync(path.join(dir, "debug.log"), `[${ts}] ${msg}\n`);
  } catch {
    // 调试日志失败不影响主流程
  }
}

// 解析用户 email：直接对指定 cwd 跑 `git -C <cwd> config user.email`，不依赖 hook 进程 cwd
// vendor 的 getUserTagInfo() → getGitEmail() 用 execSync("git config user.email")，进程 cwd 不在
// 项目下时会拿到 undefined（注入钩子在插件目录下被 spawn，cwd != 用户项目）。
// 用 -C 显式指定项目根，对 hook / daemon / 独立测试都一致
export function getUserEmail(cwd) {
  try {
    const out = spawnSync("git", ["-C", cwd, "config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5000,
    });
    if (out.status === 0 && typeof out.stdout === "string") {
      const e = out.stdout.trim();
      if (e) return e;
    }
  } catch {
    // git 不在 PATH、不是仓库等
  }
  return null;
}
