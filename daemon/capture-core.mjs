// kimi-mem 捕获核心：从 Kimi Code 会话 wire.jsonl 提取增量对话，调 LLM 提炼记忆，写入 daemon
// 被 daemon sidecar（start.mjs）在进程内调用；也可独立测试：node capture-core.mjs <payload.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 兼容两种布局：release zip（daemon/ 在插件根内 → ../lib）和源码仓库（plugin/ 与 daemon/ 平级 → ../plugin/lib）
const commonPath = ["../lib/common.mjs", "../plugin/lib/common.mjs"]
  .map((p) => path.resolve(here, p))
  .find((p) => fs.existsSync(p));
const { loadConfig, logDebug, getUserEmail } = await import(
  pathToFileURL(commonPath).href
);
// 用户画像自动学习：捕获完成后异步触发，不阻塞捕获、不抛异常
const { maybeLearnProfile } = await import(
  pathToFileURL(path.join(here, "profile-learning.mjs")).href
);

// 直接用 vendor 模块在进程内写记忆（带 prompt 关联，Web UI 时间线才会成对显示）
const dist = path.join(here, "opencode-mem", "dist");
const vend = (...segs) => import(pathToFileURL(path.join(dist, ...segs)).href);
// 注意：vendor initConfig 每次调用都重建 CONFIG 对象（let 重赋值）。
// 解构出来的 const CONFIG 是当时的快照，initConfig 之后再改它是改旧对象，别人看不到。
// 必须用命名空间访问 configMod.CONFIG（live binding，永远拿到当前对象）
const configMod = await vend("config.js");
const { initConfig } = configMod;
const { memoryClient } = await vend("services", "client.js");
const { userPromptManager } = await vend(
  "services",
  "user-prompt",
  "user-prompt-manager.js"
);
const { getTags } = await vend("services", "tags.js");
// 隐私过滤（vendor 的 depth-counter 实现，比简单 regex 更安全）
const { stripPrivateContent, isFullyPrivate } = await vend("services", "privacy.js");

const STATE_DIR = path.join(os.homedir(), ".kimi-mem");
const CURSOR_FILE = path.join(STATE_DIR, "cursors.json");

function loadCursors() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCursors(c) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 2));
}

// 在 $KIMI_CODE_HOME/sessions/*/session_xxx/agents/main/wire.jsonl 中定位会话记录
function findWireFile(sessionId) {
  const home =
    process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  for (const wd of fs.readdirSync(root)) {
    const p = path.join(root, wd, sessionId, "agents", "main", "wire.jsonl");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 上游对齐：工具调用参数摘要截断到 100 字符
const MAX_TOOL_INPUT_LENGTH = 100;

// 从 wire.jsonl 里抽取用户输入、助手正文、工具调用；只取 time > sinceTime 的记录
// 注意：不能用行号 offset 当游标——Kimi Code 在新 turn 开始/压缩时会重写 wire.jsonl
// 导致行号漂移（实测新 turn 的 turn.prompt 落在旧 offset 之前），必须按时间戳过滤
function extractConversation(lines, sinceTime = 0) {
  const out = [];
  for (const line of lines) {
    if (
      !line.includes('"type":"turn.prompt"') &&
      !line.includes('"type":"content.part"') &&
      !line.includes('"type":"tool.call"')
    ) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.time === "number" && rec.time <= sinceTime) continue;
    if (rec.type === "turn.prompt" && rec.origin?.kind === "user") {
      const text = (rec.input ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (text.trim()) out.push({ role: "用户", text: stripPrivateContent(text) });
    } else if (
      rec.type === "context.append_loop_event" &&
      rec.event?.type === "content.part" &&
      rec.event.part?.type === "text"
    ) {
      const text = rec.event.part.text ?? "";
      if (text.trim()) out.push({ role: "助手", text: stripPrivateContent(text) });
    } else if (
      rec.type === "context.append_loop_event" &&
      rec.event?.type === "tool.call"
    ) {
      const name = rec.event?.name ?? "unknown";
      const args = rec.event?.args;
      let input = "";
      if (args && typeof args === "object") {
        const parts = [];
        for (const [k, v] of Object.entries(args)) {
          parts.push(`${k}: ${JSON.stringify(v)}`);
        }
        input = parts.join(", ");
      } else if (typeof args === "string") {
        input = args;
      }
      if (input.length > MAX_TOOL_INPUT_LENGTH) {
        input = input.slice(0, MAX_TOOL_INPUT_LENGTH) + "...";
      }
      out.push({ role: "工具", text: input ? `${name}(${input})` : name });
    }
  }
  return out;
}

const SYSTEM_PROMPT = `你是一个软件项目的技术记忆记录员。从给定的对话片段生成一条简洁的技术摘要（对齐 opencode-mem 的单摘要机制）。

规则：
1. 只记录技术性工作：代码、bug、功能、架构决策、关键配置、踩坑教训、用户明确表达的偏好
2. 非技术内容（寒暄、闲聊、无结论的讨论）返回 type="skip"
3. 不要元评论或行为分析
4. 包含具体文件名、函数名、技术选型等细节
5. 生成 2-4 个英文技术标签
6. 用对话的主要语言（通常是中文）撰写摘要

摘要格式（markdown）：
## 请求
[1-2 句：用户要做什么]

## 结果
[1-3 句：实际完成了什么，包含文件/函数/关键技术点]

只输出一个 JSON 代码块，格式：
\`\`\`json
{"summary": "## 请求\\n...\\n\\n## 结果\\n...", "type": "fact", "tags": ["..."]}
\`\`\`
type 取其一：fact / decision / problem-solution / gotcha / preference。
如果没有值得记录的内容，输出 {"type": "skip", "summary": "", "tags": []}。不要输出任何其他文字。`;

// 调 LLM 提炼记忆。provider: openai-chat（OpenAI 兼容，如火山方舟 ep 端点）/ minimax（Anthropic 兼容）
// 返回三种状态：ok（含摘要）/ skip（LLM 判定无内容）/ error（HTTP/超时/解析失败，由 doCapture 重试）
async function extractWithLLM(context, cfg) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    return { status: "error", error: `env ${cfg.apiKeyEnv} 未设置` };
  }
  const headers = { "Content-Type": "application/json" };
  let url, body, pick;
  if (cfg.provider === "minimax") {
    url = `${cfg.apiUrl}/anthropic/v1/messages`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: cfg.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    };
    pick = (data) =>
      (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } else {
    // openai-chat：OpenAI Chat Completions 兼容
    url = `${cfg.apiUrl}/chat/completions`;
    headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: context },
      ],
      ...(cfg.extraParams ?? {}), // 如 reasoning_effort；不发 temperature（部分模型拒绝）
    };
    pick = (data) => data.choices?.[0]?.message?.content ?? "";
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return { status: "error", error: `fetch 失败: ${err?.message ?? err}` };
  }
  if (!res.ok) {
    return {
      status: "error",
      error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    };
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { status: "error", error: `响应 JSON 解析失败: ${err?.message ?? err}` };
  }
  const text = pick(data);
  const match = text.match(/\{[\s\S]*"summary"[\s\S]*\}/);
  if (!match) {
    return { status: "error", error: "LLM 输出中未找到 summary JSON 代码块" };
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.type === "skip") return { status: "skip" };
    if (!parsed.summary) return { status: "error", error: "summary 字段为空" };
    return {
      status: "ok",
      summary: String(parsed.summary),
      type: String(parsed.type ?? "fact"),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t) => String(t).toLowerCase().trim())
        : [],
    };
  } catch (err) {
    return { status: "error", error: `LLM 输出 JSON 解析失败: ${err?.message ?? err}` };
  }
}

// 串行队列：同一会话并发的 Stop/SessionEnd 只跑一个
const queue = new Map();

// Web UI 用户画像页的默认 userId 解析走 vendor getTags(process.cwd())，
// 其 getGitEmail 依赖进程 cwd 且用户只有仓库级 git email（无 --global），daemon 拿不到会显示
// "No profile found"。这里在每次捕获时用项目目录解析真实 email 并写入 vendor CONFIG override。
// 注意 vendor initConfig 会重建 CONFIG 对象（override 会被冲掉），所以：
// 1. 每个 initConfig 调用点后都要重新应用本函数
// 2. 解析结果持久化到 ~/.kimi-mem/user-email，daemon 重启后 start.mjs 直接恢复
function applyUserEmailOverride(cwd) {
  try {
    if (configMod.CONFIG.userEmailOverride) return;
    const email = getUserEmail(cwd);
    if (!email) return;
    configMod.CONFIG.userEmailOverride = email;
    fs.writeFileSync(path.join(STATE_DIR, "user-email"), email);
  } catch {
    // 设置失败不影响捕获
  }
}

// Windows 系统通知（经 wscript 中转：GUI 子系统零窗口，shell.Run(...,0) 隐藏 powershell）
// 直接 spawn powershell 在 Bun 下 windowsHide 不可靠，会闪控制台窗口
function notify(cfg, message) {
  if (!cfg.capture.notify) return;
  try {
    logDebug(`notify: 调用 wscript 通知：${message}`);
    const child = spawn(
      "wscript.exe",
      [
        "//B",
        path.join(here, "run-hidden.vbs"),
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(here, "toast.ps1"),
        "kimi-mem",
        message,
      ],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.on("error", (err) => logDebug(`notify spawn error: ${err}`));
    child.unref();
  } catch (err) {
    logDebug(`notify error: ${err}`);
  }
}

export function runCapture({ sessionId, cwd, event }) {
  logDebug(`capture: 收到请求 ${sessionId} event=${event}`);
  const prev = queue.get(sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => doCapture({ sessionId, cwd, event }))
    // 画像学习：fire-and-forget，每用户并发保护在 profile-learning 内部
    // 失败只写 profile-debug.log，不影响捕获主链
    .then(() =>
      maybeLearnProfile(cwd).catch((err) =>
        logDebug(`profile-learning outer error: ${err?.stack ?? err}`)
      )
    )
    .catch((err) => logDebug(`capture error: ${err?.stack ?? err}`));
  queue.set(sessionId, next);
  return next;
}

async function doCapture({ sessionId, cwd, event }) {
  const cfg = loadConfig();
  if (!cfg.capture.enabled) return;

  const cursors = loadCursors();
  const cur = cursors[sessionId] ?? { lastTime: 0, lastCapture: 0 };
  // 旧格式迁移：行号 offset 游标 → 时间戳游标（lastCapture 是上次捕获完成时间，安全上界）
  if (typeof cur.lastTime !== "number") cur.lastTime = cur.lastCapture ?? 0;

  // 防抖：Stop 事件距上次捕获不足间隔则跳过；SessionEnd 强制捕获
  const intervalMs = cfg.capture.minIntervalSec * 1000;
  if (event !== "SessionEnd" && Date.now() - cur.lastCapture < intervalMs) {
    logDebug(
      `capture: ${sessionId} 防抖跳过（距上次捕获 ${Math.round((Date.now() - cur.lastCapture) / 1000)}s < ${cfg.capture.minIntervalSec}s），内容保留待下次捕获`
    );
    return;
  }

  const wireFile = findWireFile(sessionId);
  if (!wireFile) {
    logDebug(`capture: 找不到 ${sessionId} 的 wire.jsonl`);
    return;
  }

  applyUserEmailOverride(cwd);

  const allLines = fs.readFileSync(wireFile, "utf8").split("\n");
  // 文件内最大时间戳（新游标位置），用 regex 避免整行 JSON.parse 的开销
  let maxTime = cur.lastTime;
  for (const line of allLines) {
    const m = line.match(/"time":(\d{10,})/);
    if (m) {
      const t = Number(m[1]);
      if (t > maxTime) maxTime = t;
    }
  }
  const conversation = extractConversation(allLines, cur.lastTime).filter(
    (m) => !m.text.includes("<kimi-mem-context>")
  );

  // 空内容：无 LLM 重试必要，直接推进游标避免反复扫描
  if (conversation.length === 0) {
    cursors[sessionId] = { ...cur, lastTime: maxTime };
    saveCursors(cursors);
    logDebug(`capture: ${sessionId} 无新增对话内容，跳过`);
    return;
  }

  // 按字节预算截取（保留最新部分）
  let bytes = 0;
  const kept = [];
  for (let i = conversation.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(conversation[i].text, "utf8") + 16;
    if (bytes + b > cfg.capture.maxContextBytes) break;
    bytes += b;
    kept.unshift(conversation[i]);
  }
  const context = kept
    .map((m) => `## ${m.role}\n${m.text.slice(0, 3000)}`)
    .join("\n\n");

  // LLM 提取含重试：仅 ok/skip 才推进游标；error 耗尽则保留内容等下次重试
  const MAX_ATTEMPTS = 3;
  let extracted;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    extracted = await extractWithLLM(context, cfg.capture);
    if (extracted.status !== "error") break;
    logDebug(
      `capture: LLM 提取失败 attempt ${attempt}/${MAX_ATTEMPTS}: ${extracted.error}`
    );
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
  }
  if (extracted.status === "error") {
    logDebug(
      `capture: ${sessionId} LLM 重试耗尽（${MAX_ATTEMPTS} 次），游标未推进，内容留待下次捕获`
    );
    return;
  }

  // ok 或 skip：可以推进游标
  cursors[sessionId] = { ...cur, lastTime: maxTime };

  if (extracted.status === "skip") {
    saveCursors(cursors);
    logDebug(`capture: ${sessionId} LLM 判定 skip（输入 ${kept.length} 条消息）`);
    return;
  }

  // 摘要私密过滤：写入前再 strip 一次，剥离后为空则拒绝写入
  const cleanSummary = stripPrivateContent(extracted.summary);
  if (isFullyPrivate(cleanSummary)) {
    saveCursors(cursors);
    logDebug(`capture: ${sessionId} 摘要完全为私密内容，跳过写入`);
    return;
  }
  if (cleanSummary.trim().length < 10) {
    saveCursors(cursors);
    logDebug(`capture: ${sessionId} LLM 摘要过短跳过（输入 ${kept.length} 条消息）`);
    return;
  }

  initConfig(cwd); // 独立运行时兜底；daemon 内已初始化过，重复调用只是重读配置
  applyUserEmailOverride(cwd);
  const tags = getTags(cwd);
  const containerTag = tags.project.tag;
  const projectName = tags.project.projectName ?? path.basename(cwd);
  // 时间线里与记忆成对显示的 prompt 文本：取捕获窗口里第一条用户输入
  const firstUserText =
    (kept.find((m) => m.role === "用户")?.text ?? "").slice(0, 300) ||
    `kimi-mem 会话捕获（${sessionId}）`;

  // 对齐上游：摘要末尾附 Tags 行，一条记忆配一条 prompt 记录并互相链接
  const summaryWithTags = extracted.tags.length
    ? `${cleanSummary.trim()}\n\nTags: ${extracted.tags.join(", ")}`
    : cleanSummary.trim();

  let saved = 0;
  try {
    const promptId = await userPromptManager.savePrompt(
      sessionId,
      `${sessionId}-kimi-${Date.now()}`,
      cwd,
      firstUserText
    );
    const result = await memoryClient.addMemory(summaryWithTags, containerTag, {
      source: "auto-capture",
      type: extracted.type,
      tags: extracted.tags,
      sessionID: sessionId,
      promptId,
      captureTimestamp: Date.now(),
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: cwd,
      projectName,
      gitRepoUrl: tags.project.gitRepoUrl,
    });
    if (result?.success && result.id) {
      await userPromptManager.linkMemoryToPrompt(promptId, result.id);
      await userPromptManager.markAsCaptured(promptId);
      saved = 1;
    } else {
      logDebug(`capture: addMemory 未成功 ${JSON.stringify(result)}`);
    }
  } catch (err) {
    logDebug(`capture: 写入失败 ${err}`);
  }

  cursors[sessionId].lastCapture = Date.now();
  saveCursors(cursors);
  logDebug(`capture: ${sessionId} 写入 ${saved} 条记忆`);
  if (saved > 0) {
    notify(cfg, `已捕获新记忆（${projectName}）`);
  }
}

// 独立测试入口：node capture-core.mjs <payload.json>
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  runCapture({
    sessionId: payload.session_id,
    cwd: payload.cwd,
    event: payload.hook_event_name,
  }).then(() => process.exit(0));
}
