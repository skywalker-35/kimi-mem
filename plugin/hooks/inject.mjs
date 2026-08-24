// UserPromptSubmit hook：按用户输入检索项目记忆，stdout 会追加进上下文
// 失败一律静默 exit 0（fail-open，不阻塞用户对话）
//
// 注入时机对齐 opencode-mem（injectOn: "first"）：
//   1. 每个会话的第一条用户消息
//   2. 会话发生压缩（compaction）后的第一条用户消息
// 同 session 的后续消息不再注入（agent 上下文里已有），语义检索只在上述时机执行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, readStdinJson, ensureDaemon, getProjectTag, logDebug, loadVendorMemory, getUserEmail, loadSwitch, saveSwitch, matchSwitchCommand } from "../lib/common.mjs";
import { api } from "../lib/api.mjs";

const WRAP_OPEN = "<kimi-mem-context>";
const WRAP_CLOSE = "</kimi-mem-context>";

// 会话注入状态：{ [sessionId]: { t: 上次注入时间, offset: 当时 wire.jsonl 行数 } }
// offset 之后出现 compaction 事件 → 压缩后需要重新注入
const SEEN_FILE = path.join(os.homedir(), ".kimi-mem", "inject-seen.json");

// 会话级注入开关的状态读写/指令匹配在 lib/common.mjs（loadSwitch/saveSwitch/matchSwitchCommand），
// 与 hooks/switch.mjs（TurnStarted 入口）共享

// 拦截开关指令；命中则处理并 exit 2（阻止本轮模型调用，stderr 作为反馈展示给用户）
// 注意：插件斜杠命令（origin=plugin_command）不触发 UserPromptSubmit，那条链路由
// hooks/switch.mjs（TurnStarted）负责写状态；这里只兜底普通消息里的同形文本
function handleSwitchCommand(prompt, sessionId) {
  const action = matchSwitchCommand(prompt);
  if (!action) return false;
  if (!sessionId) {
    console.error("kimi-mem：无法确定当前会话 id，开关未生效");
    process.exit(2);
  }

  const state = loadSwitch();
  if (action === "status") {
    const disabled = state[sessionId]?.disabled === true;
    console.error(`kimi-mem：当前会话记忆注入${disabled ? "已关闭" : "开启中"}`);
    process.exit(2);
  }

  state[sessionId] = { disabled: action === "off", t: Date.now() };
  saveSwitch(state);
  console.error(
    action === "off"
      ? "kimi-mem：本会话记忆注入已关闭（自动捕获不受影响）"
      : "kimi-mem：本会话记忆注入已恢复（注入时机为首条消息/压缩后首条，将在下次压缩后重新注入）"
  );
  process.exit(2);
}

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  // 只保留最近 200 个会话，防止文件无限增长
  const entries = Object.entries(seen)
    .sort((a, b) => (b[1].t ?? b[1]) - (a[1].t ?? a[1]))
    .slice(0, 200);
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 状态写失败不影响注入
  }
}

// 在 $KIMI_CODE_HOME/sessions/*/session_xxx/agents/main/wire.jsonl 中定位会话记录
function findWireFile(sessionId) {
  const home =
    process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  const root = path.join(home, "sessions");
  if (!sessionId || !fs.existsSync(root)) return null;
  try {
    for (const wd of fs.readdirSync(root)) {
      const p = path.join(root, wd, sessionId, "agents", "main", "wire.jsonl");
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // 枚举失败按未找到处理
  }
  return null;
}

// 上次注入之后 wire.jsonl 里是否发生过压缩（全量/增量压缩都算）
function compactionSince(wireFile, offset) {
  try {
    const lines = fs.readFileSync(wireFile, "utf8").split("\n");
    const total = lines.length;
    let compacted = false;
    for (let i = Math.min(offset, total); i < total; i++) {
      const l = lines[i];
      if (
        l.includes('"type":"full_compaction.complete"') ||
        l.includes('"type":"context.apply_compaction"')
      ) {
        compacted = true;
        break;
      }
    }
    return { compacted, total };
  } catch {
    return { compacted: false, total: offset };
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.inject.enabled) return;

  const payload = await readStdinJson();
  // 真实 payload 的 prompt 是 content parts 数组：[{type:"text",text:"..."}]，兼容字符串形式
  const rawPrompt = payload.prompt ?? payload.user_prompt ?? payload.text ?? "";
  const prompt = Array.isArray(rawPrompt)
    ? rawPrompt
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n")
    : String(rawPrompt);
  const cwd = payload.cwd ?? process.cwd();

  // 会话级开关指令优先拦截（在 minPromptLength 检查之前，短指令也要能命中）
  handleSwitchCommand(prompt, payload.session_id);

  // 本会话已关闭注入：直接返回（不拉起 daemon、不检索）
  if (payload.session_id && loadSwitch()[payload.session_id]?.disabled === true) {
    return;
  }

  if (typeof prompt !== "string" || prompt.trim().length < cfg.inject.minPromptLength) {
    return;
  }

  // ---- 注入时机判定（首条消息 / 压缩后首条消息）----
  const sessionId = payload.session_id;
  const seen = loadSeen();
  const record = sessionId ? seen[sessionId] : null;
  let shouldInject = false;
  let wireTotal = null;

  if (!record) {
    shouldInject = true;
  } else {
    // 兼容旧格式（值为时间戳）：迁移为已注入过、从当前文件末尾开始观察
    const prevOffset = typeof record === "number" ? null : record.offset ?? 0;
    const wireFile = findWireFile(sessionId);
    if (wireFile) {
      const { compacted, total } = compactionSince(
        wireFile,
        prevOffset ?? total0(wireFile)
      );
      shouldInject = compacted;
      wireTotal = total;
    }
  }

  // 记录/推进观察位置；无论是否注入都推进，避免反复扫描旧内容
  if (sessionId) {
    const offset =
      wireTotal ??
      (() => {
        const wf = findWireFile(sessionId);
        if (!wf) return 0;
        try {
          return fs.readFileSync(wf, "utf8").split("\n").length;
        } catch {
          return 0;
        }
      })();
    seen[sessionId] = { t: Date.now(), offset };
    saveSeen(seen);
  }

  if (!shouldInject) return;

  if (!(await ensureDaemon())) return;

  const tag = await getProjectTag(cwd);
  const results = await api.search(prompt.trim(), {
    tag,
    pageSize: cfg.inject.maxResults,
  });

  const memories = results
    .filter((m) => m.content && !String(m.content).includes(WRAP_OPEN))
    .slice(0, cfg.inject.maxResults);

  // 时效性兜底：语义检索可能漏掉"刚才做了什么"这类问题
  const recent = (await api.list({ tag, pageSize: 3 })).filter(
    (m) => m.content && !memories.some((s) => s.id === m.id)
  );

  if (memories.length === 0 && recent.length === 0) return;

  const sections = [];
  if (memories.length > 0) {
    const lines = memories.map((m) => {
      const sim = m.similarity ?? m.score;
      const score = typeof sim === "number" ? ` (相关度 ${sim.toFixed(2)})` : "";
      return `- ${String(m.content).trim()}${score}`;
    });
    sections.push("语义相关的历史记忆：\n" + lines.join("\n"));
  }
  if (recent.length > 0) {
    const lines = recent.map(
      (m) => `- ${String(m.content).trim().slice(0, 300)}`
    );
    sections.push("最近记录的项目记忆：\n" + lines.join("\n"));
  }

  // 用户画像段：与上游 context.ts 的 formatContextForPrompt 对齐
  // getUserProfileContext 只读 DB 不触发 embedding（无首次调用模型加载慢的问题）；失败静默跳过
  // 用 getUserEmail(cwd) 显式在用户项目下取 git email（不依赖 hook 进程的 cwd）
  if (cfg.profile?.enabled) {
    try {
      const userId = getUserEmail(cwd);
      if (userId) {
        const v = await loadVendorMemory(cwd);
        const profileText = await v.getUserProfileContext(userId);
        if (profileText) {
          sections.push(`<user_profile>\n${profileText}\n</user_profile>`);
        }
      }
    } catch (err) {
      logDebug(`inject profile error: ${err?.message ?? err}`);
    }
  }

  process.stdout.write(
    `${WRAP_OPEN}\n以下是当前项目的历史记忆（kimi-mem 自动注入，仅供参考）：\n` +
      sections.join("\n\n") +
      `\n${WRAP_CLOSE}\n`
  );
}

function total0(wireFile) {
  try {
    return fs.readFileSync(wireFile, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  logDebug(`inject error: ${err?.stack ?? err}`);
  process.exit(0);
});
