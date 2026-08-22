// kimi-mem 用户画像自动学习：每积累 analysisInterval 条未学习 prompt 跑一次 LLM 分析
// 对齐 opencode-mem 的 src/services/user-memory-learning.ts（去掉了 opencode provider /
// validation / learning_paths / ai-cleanup 等依赖插件宿主的能力，LLM 走 capture 段同一 provider）
//
// 调用入口：capture-core.mjs 在 doCapture 完成后 fire-and-forget 调 maybeLearnProfile(cwd)
// 失败一律 logDebug，绝不抛出 / 阻塞捕获
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 兼容两种布局：release zip（daemon/ 在插件根内 → ../lib）和源码仓库（plugin/ 与 daemon/ 平级 → ../plugin/lib）
const commonPath = ["../lib/common.mjs", "../plugin/lib/common.mjs"]
  .map((p) => path.resolve(here, p))
  .find((p) => fs.existsSync(p));
const { loadConfig, logDebug, getUserEmail } = await import(
  pathToFileURL(commonPath).href
);

const dist = path.join(here, "opencode-mem", "dist");
const vend = (...segs) => import(pathToFileURL(path.join(dist, ...segs)).href);
// 注意：initConfig 会重建 CONFIG 对象，解构快照会失效，必须用命名空间访问（见 capture-core）
const configMod = await vend("config.js");
const { initConfig } = configMod;
const { userPromptManager } = await vend(
  "services",
  "user-prompt",
  "user-prompt-manager.js"
);
const { userProfileManager } = await vend(
  "services",
  "user-profile",
  "user-profile-manager.js"
);
const { getTags } = await vend("services", "tags.js");

// 镜像上游：同用户同时只跑一个学习周期
const learningLocks = new Map();

// capture-core 解析出的用户 email 持久化在 ~/.kimi-mem/user-email（daemon 重启恢复用）
function readPersistedEmail() {
  try {
    return fs
      .readFileSync(path.join(os.homedir(), ".kimi-mem", "user-email"), "utf8")
      .trim();
  } catch {
    return "";
  }
}

// 调试日志独立文件：捕获 / 注入 / 画像 三块分开查，互不干扰
const LOG_FILE = path.join(os.homedir(), ".kimi-mem", "profile-debug.log");
function logProfile(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const ts = new Date().toLocaleString("zh-CN", { hour12: false });
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {
    // 写日志失败不影响主流程
  }
}

// 系统提示：参考上游 analyzeUserProfile 的 systemPrompt（去掉 opencode-specific 措辞）
// 要求严格按 schema 输出 JSON；输出语言跟随用户 prompt（上游的 CRITICAL 规则）
function buildSystemPrompt(mode) {
  return `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts and ${mode} a comprehensive user profile.

CRITICAL: Detect the language used by the user in their prompts. You MUST output all descriptions, categories, and text in the SAME language as the user's prompts.

CRITICAL: All JSON string values MUST escape double quotes with backslash. Do NOT use unescaped quotation marks inside string values.

Output a single JSON object matching this schema:
{
  "preferences": [
    { "category": "<short snake_case or word>", "description": "<=120 chars, core semantics first", "confidence": 0.3-1, "evidence": ["prompt excerpt 1", "prompt excerpt 2"] }
  ],
  "patterns": [
    { "category": "<short>", "description": "<recurring topic or behavior>" }
  ],
  "workflows": [
    { "description": "<distinct, named recurring sequence>", "steps": ["step 1", "step 2", "step 3"] }
  ]
}

Output ONLY the JSON object inside a single \`\`\`json code block. No other prose.`;
}

// 上下文（参考上游 buildUserAnalysisContext，去掉 validation task 和 size hint）
// 包含已有画像摘要做引导，避免类别名漂移
function buildAnalysisContext(prompts, existingProfile) {
  const base = `# User Profile Analysis

Analyze ${prompts.length} user prompts to ${existingProfile ? "update" : "create"} the user profile.
${existingProfile ? "The merge system will automatically connect your observations to existing profile entries — you only need to describe what you see in these recent prompts." : "Create a new user profile from scratch based on the prompts below."}

${existingProfile ? buildCategorySummary(existingProfile) : ""}
## Recent Prompts

${prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n\n")}

## Analysis Guidelines

Identify and ${existingProfile ? "report" : "create"}:

 1. **Preferences**
   - Code style, communication style, tool preferences
   - Assign confidence 0.3-1 based on evidence strength in these recent prompts
   - Include 1-3 example prompts as evidence
   - **Revealed preferences**: when the user chooses one approach over alternatives (e.g. picks simpler solution, skips certain steps), capture the choice as a lower-confidence preference (0.3-0.5). What the user does NOT do is also a signal.

 2. **Patterns**
   - Recurring topics, problem domains, technical interests seen in these prompts
   - Track frequency of occurrence

 3. **Workflows**
    - Distinct, named step sequences the user follows repeatedly
    - Each workflow should represent a DIFFERENT activity (different purpose, different steps)
    - Break down into 3-6 concrete, observable steps, NOT abstract phases
    - Do NOT repeat the same workflow every cycle — only output when you observe a NEW recurring sequence
    - Examples of distinct workflows: "debugging workflow", "code review workflow", "learning workflow", "refactoring workflow"

CRITICAL: Only output observations grounded in the RECENT PROMPTS above. Write descriptions in your own words — the system matches by embedding similarity, not exact wording. Do NOT output entries that lack evidence in recent prompts. Put the core semantics at the beginning of each description, keeping descriptions concise and specific (under 120 characters). Do NOT extract one-time debugging tasks, environment setup issues, or specific error investigations as preferences — these are transient events, not behavioral patterns.

## Few-Shot Examples

❌ Do NOT extract as preference:
- "User is debugging a NullPointerException in auth service" (one-time debugging task)
- "User installed Redis for the first time" (one-time setup event)
- "User ran npm audit fix" (routine maintenance, not a behavioral pattern)

✅ DO extract as preference:
- "User prefers functional programming style over OOP"
- "User consistently writes tests before implementation"
- "User asks for explanations before accepting code changes"

✅ DO extract as workflow (distinct, non-overlapping):
- Debugging workflow: "reproduce the error → check logs → grep source code → trace call chain → propose fix → verify fix"
- Code review workflow: "read the diff → check edge cases → verify consistency with existing patterns → report issues → suggest alternatives"
- Learning workflow: "ask for explanation → request examples → test understanding with a small task → apply to real problem"

❌ Do NOT extract as workflow:
- "User analyzes problems and verifies solutions" (too abstract — not a concrete step sequence)
- "User writes code and tests it" (too generic — covers everything)`;

  return base;
}

function buildCategorySummary(profileRow) {
  let data;
  try {
    data = JSON.parse(profileRow.profileData);
  } catch {
    return "";
  }
  const prefCats = [...new Set((data.preferences ?? []).map((p) => p.category))];
  const patCats = [...new Set((data.patterns ?? []).map((p) => p.category))];
  const catParts = [];
  if (prefCats.length > 0) {
    const catCounts = prefCats
      .map(
        (cat) =>
          `${cat} (${
            (data.preferences ?? []).filter((p) => p.category === cat).length
          })`
      )
      .join(", ");
    catParts.push(`Preference categories: ${catCounts}`);
  }
  if (patCats.length > 0) {
    const catCounts = patCats
      .map(
        (cat) =>
          `${cat} (${
            (data.patterns ?? []).filter((p) => p.category === cat).length
          })`
      )
      .join(", ");
    catParts.push(`Pattern categories: ${catCounts}`);
  }
  if (catParts.length === 0) return "";
  return (
    `## Existing Categories\nUse these exact category names when your observation fits:\n\n` +
    catParts.join("\n") +
    "\n"
  );
}

// 调 LLM 提炼画像。复用 capture-core 的 provider 段配置（OpenAI 兼容 / minimax）
// 返回归一化后的 profileData 形状；失败返回 null
async function callProfileLLM(systemPrompt, context, cfg) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    logProfile(`LLM skip: env ${cfg.apiKeyEnv} 未设置`);
    return null;
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
      system: systemPrompt,
      messages: [{ role: "user", content: context }],
    };
    pick = (data) =>
      (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
  } else {
    url = `${cfg.apiUrl}/chat/completions`;
    headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: context },
      ],
      ...(cfg.extraParams ?? {}),
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
    logProfile(`LLM fetch failed: ${err?.message ?? err}`);
    return null;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    logProfile(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
    return null;
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    logProfile(`LLM JSON parse failed: ${err?.message ?? err}`);
    return null;
  }
  const text = pick(data);
  const match = text.match(/\{[\s\S]*"preferences"[\s\S]*\}/);
  if (!match) {
    logProfile(
      `LLM output no preferences JSON block (text head: ${text.slice(0, 200)})`
    );
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    logProfile(`LLM JSON parse failed: ${err?.message ?? err}`);
    return null;
  }
  // 形状归一化：LLM 可能漏字段或类型错
  if (!Array.isArray(parsed.preferences)) parsed.preferences = [];
  if (!Array.isArray(parsed.patterns)) parsed.patterns = [];
  if (!Array.isArray(parsed.workflows)) parsed.workflows = [];
  parsed.preferences = parsed.preferences
    .filter((p) => p && typeof p.description === "string" && p.description.trim())
    .map((p) => ({
      category: String(p.category ?? "_").slice(0, 64),
      description: String(p.description).slice(0, 200),
      confidence:
        typeof p.confidence === "number"
          ? Math.min(1, Math.max(0, p.confidence))
          : 0.5,
      evidence: Array.isArray(p.evidence)
        ? p.evidence
            .filter((e) => typeof e === "string")
            .slice(0, 3)
            .map((e) => e.slice(0, 200))
        : [],
    }));
  parsed.patterns = parsed.patterns
    .filter((p) => p && typeof p.description === "string" && p.description.trim())
    .map((p) => ({
      category: String(p.category ?? "_").slice(0, 64),
      description: String(p.description).slice(0, 200),
    }));
  parsed.workflows = parsed.workflows
    .filter((w) => w && typeof w.description === "string" && w.description.trim())
    .map((w) => ({
      description: String(w.description).slice(0, 200),
      steps: Array.isArray(w.steps)
        ? w.steps
            .filter((s) => typeof s === "string")
            .slice(0, 6)
            .map((s) => s.slice(0, 200))
        : [],
    }));
  return parsed;
}

// 主入口：cwd 是触发本次学习的项目目录（来自 capture 事件）
// 失败永不抛出；返回 {ran, ...} 便于上层调试
export async function maybeLearnProfile(cwd) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    logProfile(`config load failed: ${err}`);
    return { ran: false, reason: "config" };
  }
  if (!cfg.profile?.enabled) {
    return { ran: false, reason: "disabled" };
  }
  const interval = Math.max(
    1,
    Number(cfg.profile.analysisInterval ?? 10) | 0
  );
  // daemon 进程内 vendor 模块已 init 过；这里兜底再 init 一次（多 cwd 场景）
  try {
    initConfig(cwd);
    // initConfig 会重建 CONFIG 对象，冲掉 capture-core 设置的 userEmailOverride
    // （Web UI 画像页默认 userId 依赖它），这里随即恢复（命名空间访问拿当前对象）
    if (!configMod.CONFIG.userEmailOverride) {
      const email = getUserEmail(cwd) || readPersistedEmail();
      if (email) configMod.CONFIG.userEmailOverride = email;
    }
  } catch (err) {
    logProfile(`initConfig failed: ${err}`);
    return { ran: false, reason: "init" };
  }

  let userId;
  try {
    // 不用 vendor getTags().user.userEmail：vendor 的 getGitEmail 依赖进程 cwd 跑
    // `git config user.email`，daemon 进程 cwd 不一定是项目目录，会拿不到（实测匿名跳过）。
    // getUserEmail 用 `git -C <cwd>` 显式指定项目目录，三处（daemon/hook/独立测试）行为一致
    userId = getUserEmail(cwd);
    if (!userId) {
      logProfile("skip: no user email (anonymous)");
      return { ran: false, reason: "no-user" };
    }
  } catch (err) {
    logProfile(`getUserEmail failed: ${err}`);
    return { ran: false, reason: "tags" };
  }

  // 同用户并发保护
  if (learningLocks.get(userId)) {
    return { ran: false, reason: "busy" };
  }
  learningLocks.set(userId, true);
  const release = () => learningLocks.delete(userId);

  let count;
  try {
    count = await userPromptManager.countUnanalyzedForUserLearning();
  } catch (err) {
    release();
    logProfile(`count failed: ${err}`);
    return { ran: false, reason: "count" };
  }
  if (count < interval) {
    release();
    return { ran: false, reason: "below-threshold", count, interval };
  }

  logProfile(
    `trigger user=${userId} cwd=${cwd} count=${count} interval=${interval}`
  );
  let prompts;
  try {
    prompts = await userPromptManager.getPromptsForUserLearning(interval);
  } catch (err) {
    release();
    logProfile(`getPrompts failed: ${err}`);
    return { ran: false, reason: "getPrompts" };
  }
  if (prompts.length === 0) {
    release();
    return { ran: false, reason: "no-prompts" };
  }

  let existing;
  try {
    existing = await userProfileManager.getActiveProfile(userId);
  } catch (err) {
    release();
    logProfile(`getActiveProfile failed: ${err}`);
    return { ran: false, reason: "getProfile" };
  }

  const sysPrompt = buildSystemPrompt(existing ? "update" : "create");
  const ctx = buildAnalysisContext(prompts, existing);
  const llmResult = await callProfileLLM(sysPrompt, ctx, cfg.capture);

  // 标记 prompts 已学习（无论 LLM 是否成功）—— 镜像上游"避免 token 燃尽"策略
  try {
    await userPromptManager.markMultipleAsUserLearningCaptured(
      prompts.map((p) => p.id)
    );
  } catch (err) {
    logProfile(`markMultipleAsUserLearningCaptured failed: ${err}`);
  }

  if (!llmResult) {
    release();
    logProfile(`no result from LLM; prompts marked to avoid retry loop`);
    return { ran: true, success: false, prompts: prompts.length };
  }

  // 写入画像
  try {
    if (existing) {
      const merged = await userProfileManager.mergeProfileData(
        JSON.parse(existing.profileData),
        llmResult,
        undefined,
        existing.id
      );
      const ok = await userProfileManager.updateProfile(
        existing.id,
        merged,
        prompts.length,
        `Auto-learned from ${prompts.length} prompts (prefs:${llmResult.preferences.length}, pats:${llmResult.patterns.length}, wfs:${llmResult.workflows.length})`
      );
      if (!ok) {
        logProfile(`updateProfile returned false (conflict)`);
        release();
        return { ran: true, success: false, prompts: prompts.length };
      }
      logProfile(
        `updated profile ${existing.id} (prefs:${llmResult.preferences.length}, pats:${llmResult.patterns.length}, wfs:${llmResult.workflows.length})`
      );
    } else {
      const tags = getTags(cwd);
      const newId = await userProfileManager.createProfile(
        userId,
        tags.user.displayName || "Unknown",
        tags.user.userName || userId,
        userId,
        llmResult,
        prompts.length
      );
      logProfile(
        `created profile ${newId} (prefs:${llmResult.preferences.length}, pats:${llmResult.patterns.length}, wfs:${llmResult.workflows.length})`
      );
    }
  } catch (err) {
    logProfile(`write profile failed: ${err?.stack ?? err}`);
    release();
    return { ran: true, success: false, prompts: prompts.length };
  }

  release();
  return {
    ran: true,
    success: true,
    prompts: prompts.length,
    prefs: llmResult.preferences.length,
    pats: llmResult.patterns.length,
    wfs: llmResult.workflows.length,
  };
}

// 独立测试入口：node profile-learning.mjs <cwd>
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const cwd = process.argv[2] || process.cwd();
  maybeLearnProfile(cwd).then((r) => {
    logDebug(`profile-learning standalone result: ${JSON.stringify(r)}`);
    process.exit(0);
  });
}