# kimi-mem

把 [opencode-mem](https://github.com/tickernelz/opencode-mem) 的记忆能力移植到 Kimi Code（方案 A：薄封装；vendor 仅有一处 Windows 补丁，见"关键事实"）。

## 架构

```
Kimi Code 插件（plugin/）
├── hooks/inject.mjs         UserPromptSubmit → 检索相关记忆注入上下文
├── hooks/capture.mjs        Stop/SessionEnd → POST 给 daemon sidecar 后立即退出
├── mcp-server.mjs           memory_search / add / list / forget / profile / export / import / list_shards / migrate
├── commands/inject.md       斜杠命令 /kimi-mem:inject off|on|status（会话级注入开关）
└── skills/kimi-mem/         使用规范

daemon/
├── start.mjs                独立启动 opencode-mem WebServer + sidecar(5768)（必须用 bun）
├── capture-core.mjs         捕获核心：wire.jsonl 增量 → LLM 提炼 → 进程内写 vendor 模块
├── run-hidden.vbs / toast.ps1  Windows toast 通知链路
└── opencode-mem/            上游源码 + 构建产物（vendor；分支 kimi-windows-hide 上有一处补丁，见下）
```

## 关键事实

- **端口 5757**（避开 opencode-mem 自己的 4747/4750）；Web UI: http://127.0.0.1:5757
- **sidecar 捕获接口 5768**（`POST /capture`，需 token）：hooks 只发 HTTP 请求，捕获在 daemon 进程内异步执行，不 spawn 子进程（避免终端退出时弹控制台窗口）
- **存储与 opencode-mem 共享** `~/.opencode-mem/data`，两边记忆互通；API token 在 `~/.opencode-mem/.auth-token`（所有 /api/* 请求必须带 `x-opencode-mem-token` 头）
- **daemon 必须用 bun 跑**：web-server 的 node:http 适配层对带 body 的 POST 会提前销毁 socket（上游 bug，`server.unref()` + req close 事件）；Node 下 GET 正常、POST 空响应。注意 spawn 时如果 bun 只有 .cmd shim（无 bun.exe 真实二进制）会解析不到，必须指向真实 exe 路径（可用 config.bunPath 或 KIMI_MEM_BUN 环境变量指定）
- hooks 检测到 daemon 未运行会自动拉起（ensureDaemon）
- auto-capture 提炼走火山方舟 EP 端点（`provider: openai-chat`，模型为本机私有 EP ID（= deepseek-v4-flash），`ARK_EP_API_KEY` 环境变量，`reasoning_effort: low`），实测端到端约 14s；配置见 `plugin/kimi-mem.config.json` 的 `capture` 段（也支持 `provider: minimax` 走 Anthropic 兼容端点）
- **记忆必须带 prompt 关联写入**（`userPromptManager.savePrompt` + `memoryClient.addMemory({promptId})` + `linkMemoryToPrompt`）：上游 Web UI 时间线把 linked pairs 排在最前、standalone 排在最后，纯 API 写入的记忆会被埋到几百页之后。capture-core 因此直接用 vendor 模块进程内写入，不走 HTTP API
- **捕获产出对齐上游（2026-08-22 起）**：一次捕获 = 一条 markdown 摘要（`## 请求` / `## 结果` 两段 + 末尾 `Tags:` 行），一条记忆配一条 prompt 一对一链接；LLM 判定非技术内容返回 `type="skip"` 不写入。此前是"一次捕获拆 0~5 条记忆 + 同条 prompt 复制多份（续 N）"，时间线冗余，已废弃
- 捕获完成后发 Windows toast 通知（`daemon/toast.ps1`，WinRT），经 `daemon/run-hidden.vbs`（wscript，GUI 子系统）中转调用——Bun 下 spawn 的 windowsHide 不可靠，直接 spawn powershell 会闪控制台窗口。注意 vbs 拼命令行时 **exe 不能加引号**（cmd/shell.Run 会报"不是内部或外部命令"），只给含空格的参数加引号。toast.ps1 每次执行写日志到 `~/.kimi-mem/toast.log`（shown/ERROR），排查通知问题先看它。`capture.notify: false` 可关
- **捕获时连闪多个控制台窗口的根因（2026-08-22 修复）**：不是 toast，而是 vendor `src/services/tags.ts` 的 5 处 `execSync("git ...")`（算项目标签用）没加 `windowsHide`——daemon 是 detached 无控制台进程，拉起控制台程序 git.exe 时 Windows 被迫新建窗口，5 条命令连闪 5 次。补丁：vendor 切到 `kimi-windows-hide` 分支，5 处 execSync 加 `windowsHide: true` 后 `bun x tsc` 重建（**不要跑完整 `bun run build`**，它会 `rm -rf dist` 并重建 web 前端；只跑 tsc 可保留 dist/web 资产）。toast 链路另加了 `-WindowStyle Hidden -NonInteractive` 作双保险
- **直接关终端窗口不会触发 SessionEnd hook**：非常规退出时该会话末尾内容抓不到；但游标不推进，下次同会话任意 Stop/SessionEnd 会补抓。防抖跳过、空内容、LLM 0 条这些静默分支都已写 debug.log，排查先看日志
- **捕获游标是时间戳不是行号**（`~/.kimi-mem/cursors.json` 的 `lastTime`）：Kimi Code 在新 turn 开始/压缩时会重写 wire.jsonl 导致行号漂移（实测新 turn 的 turn.prompt 落在旧 offset 之前，会漏抓），必须按记录的 `time` 字段过滤。旧 offset 格式自动迁移（lastTime = 上次捕获完成时间）
- **LLM 失败重试 + 游标保护**：提炼失败（HTTP/超时/解析错误）指数退避重试 3 次（2s/4s），全部失败则**不推进游标**，内容留待下次捕获；只有 ok/skip 才推进
- **隐私过滤**（复用 vendor `dist/services/privacy.js`）：`<private>...</private>` 内容在进入 LLM 上下文前、摘要写入前、MCP memory_add 前都会被剥离为 `[REDACTED]`；纯私密内容拒绝写入
- **捕获上下文含工具调用**：`tool.call` 记录以 `工具名(参数摘要)` 形式进上下文，参数截断 100 字符（对齐上游）
- 捕获防抖：Stop 事件 120s 内只捕一次（静默跳过的内容保留到下次）；SessionEnd 强制捕一次
- 注入策略（对齐 opencode-mem 的 `injectOn: "first"`）：只在**每个会话的第一条消息**和**压缩（compaction）后的第一条消息**注入（语义检索 + 最近 3 条兜底），同会话后续消息不注入。状态存 `~/.kimi-mem/inject-seen.json`（每会话记录上次注入时的 wire.jsonl 行数，之后出现 `full_compaction.complete`/`context.apply_compaction` 事件即视为压缩），滚动保留 200 个会话。hook 每次调用现读文件，改动无需重装或 /reload
- **用户画像自动学习 + 注入**（2026-08-22 起，对齐上游 `user-memory-learning.ts`）：daemon 在 capture-core 完成后 fire-and-forget 调 `daemon/profile-learning.mjs` 的 `maybeLearnProfile(cwd)`——每积累 `profile.analysisInterval`（默认 10）条未学习 prompt 跑一次 LLM 分析（复用 capture 段的 provider/apiUrl/apiKeyEnv/model），拼出 `# User Profile Analysis` 上下文（含已有画像摘要做引导）调 LLM 拿 `{preferences, patterns, workflows}`，再调 vendor `userProfileManager.mergeProfileData` + `updateProfile`（嵌入用 embedding 匹配已有条目，置信度衰减/Beta-Bernoulli/changelog 由 manager 内部处理），最后 `markMultipleAsUserLearningCaptured` 标已分析。注入侧：在 `<kimi-mem-context>` 末尾追加 `<user_profile>...</user_profile>` 段（调用 vendor `getUserProfileContext(userId)`，纯 DB 查询、不触发 embedding 加载），userId 通过 `git -C <payload.cwd> config user.email` 解析（不依赖 hook 进程 cwd——vendor `getUserTagInfo()` 用的 `execSync("git config ...")` 在插件目录下会拿到 undefined）。每用户并发保护；失败一律 logDebug 不阻塞捕获。配置 `profile.enabled: false` 全关。日志 `~/.kimi-mem/profile-debug.log`（独立文件，便于和 capture/inject 的 debug.log 区分）。调 `GET /api/user-profile?userId=<email>`（需 `x-opencode-mem-token` 头）可看画像内容
- 捕获耗时说明：SessionEnd 后 LLM 提炼（60KB 上下文上限）约 20~60s + 逐条 embedding 写入，通知弹出即全部完成。调 `capture.maxContextBytes` 可提速
- 会话记录来源：`$KIMI_CODE_HOME/sessions/*/session_*/agents/main/wire.jsonl` 中的 `turn.prompt`（用户）和 `content.part`/`text`（助手）
- **vendor `initConfig` 会重建 CONFIG 对象**（`let CONFIG` 重赋值）：`const { CONFIG } = await import(...)` 解构拿到的是快照，initConfig 之后再改它改的是旧对象，别人看不到——一律用命名空间访问 `configMod.CONFIG`（live binding）。这条同时是 Web UI 用户画像页 "No profile found" 的根因：`/api/user-profile` 默认 userId 走 vendor `getTags(process.cwd())`，其 `getGitEmail` 依赖进程 cwd 跑 `git config user.email`，daemon 的 cwd 不在用户项目里（且用户只有仓库级 git email，无 --global）→ 解析成 unknown。修复：capture-core 每次捕获用 `getUserEmail(cwd)`（`git -C <cwd>`）解析真实 email 写入 `configMod.CONFIG.userEmailOverride` 并持久化到 `~/.kimi-mem/user-email`；start.mjs 启动时恢复；profile-learning 在自己的 initConfig 后重新应用
- debug 日志：`~/.kimi-mem/debug.log`（捕获/注入/通知）、`~/.kimi-mem/profile-debug.log`（画像学习），均本地时区
- **会话级注入开关**（2026-08-24）：`/kimi-mem:inject off|on|status`。机制：插件清单 `commands` 字段注册命令，body 首行嵌机读标记 `KIMI_MEM_INJECT_SWITCH:$ARGUMENTS`。**关键事实：插件斜杠命令提交（wire 里 `origin.kind=plugin_command`）不触发 UserPromptSubmit**（实测：两次命令提交 debug.log 无任何 inject fired 记录，普通消息才触发），所以状态写入走 `hooks/switch.mjs`（TurnStarted，每个 turn 都触发且 payload 带 prompt，含插件命令展开后的 body）；TurnStarted 是观察型事件不能阻塞模型调用，命令 body 本身兼作模型可见的确认文案。inject.mjs（UserPromptSubmit）仍保留同形文本拦截（exit 2 阻断），兜底普通消息路径；注入前检查 `~/.kimi-mem/inject-switch.json`（`{sessionId:{disabled,t}}`，留 200 条），disabled 会话在 ensureDaemon 之前直接 return。只影响注入，capture 不受影响。匹配逻辑/状态读写共享在 lib/common.mjs（matchSwitchCommand/loadSwitch/saveSwitch）；动作只取开头第一个英文单词（支持 `/kimi-mem:inject off, 顺便提问…` 的组合用法，body 指示模型先回状态行再回答后续问题）；确认文案由 hook 侧写 `~/.kimi-mem/inject-switch-last.json` 的 statusText 供模型原样转述（模型拿不到自己的 session id，不能让它猜状态文件里最近一条——那条可能属于别的会话）。踩过的坑：拦截正则最初用 `\b` 锚定参数，**空参数（用户直接敲 `/kimi-mem:inject`）时无词边界导致匹配失败穿透到模型**；初版动作取 `(\S*)` 会把 `off,` 整体捕获导致降级 status
- **`/plugins install` 报 EBUSY（rename managed\kimi-mem 失败）的根因**：插件 hook 由 CLI 以插件根目录为 cwd 启动，ensureDaemon spawn bun 时未指定 cwd，daemon 继承了 managed 副本目录作为工作目录，Windows 下目录被占用无法 rename。规避：直接 cp 改动文件到 `F:\.kimi-code\plugins\managed\kimi-mem\` 对应位置（Node 不锁已加载文件）再 `/plugins reload`；或先 kill daemon（bun 进程，下次 hook 自动拉起）再走官方 install

## 安装

```
/plugins install <本仓库路径>/plugin
/reload
```

## 升级上游

```
cd daemon/opencode-mem && git pull && bun install && bun run build && cd web && bun install && bun run build
```

升级前先记下 `kimi-windows-hide` 分支的补丁（tags.ts 的 5 处 `windowsHide: true`），pull 后在新代码上重放，否则捕获时闪控制台窗口的问题会回来。

然后重启 daemon（kill 后任意 hook 会自动拉起新实例）。
