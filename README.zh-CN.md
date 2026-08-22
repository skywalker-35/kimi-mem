# kimi-mem

> [English](./README.md) | **中文（本页）**

[Kimi Code](https://www.kimi.com/) 的持久记忆插件 —— 把 [opencode-mem](https://github.com/tickernelz/opencode-mem) 的记忆能力完整移植到 Kimi Code。

自动捕获每次会话的工作摘要，存入本地向量数据库；下次开会话时自动注入相关历史记忆和你的用户画像，让 agent "记得"之前做过什么、你偏好怎么做事。

## 功能

- **自动捕获**：会话结束（或每轮对话结束）时，用 LLM 把本次工作提炼成一条摘要存入本地向量库（含工具调用上下文、失败自动重试、`private` 标记过滤）
- **自动注入**：新会话首条消息时，语义检索相关历史记忆 + 最近项目记忆，连同**用户画像**一起注入上下文
- **用户画像自动学习**：每积累 10 条 prompt 自动用 LLM 归纳你的偏好/习惯/工作流，持续演进
- **Web UI**：浏览/搜索/编辑记忆、时间线、用户画像（默认 `http://127.0.0.1:5757`）
- **MCP 工具**：9 个 `memory_*` 工具（search/add/list/export/import/migrate 等），agent 可主动存取记忆
- **Windows 系统通知**：捕获完成时弹 toast 通知
- **与 opencode-mem 共享存储**：记忆存在 `~/.opencode-mem/data`，和 OpenCode 侧的记忆互通

## 架构

```
Kimi Code
  │ hooks: UserPromptSubmit → plugin/hooks/inject.mjs   （注入记忆 + 画像）
  │ hooks: Stop / SessionEnd → plugin/hooks/capture.mjs （POST 到 sidecar）
  │ MCP: plugin/mcp-server.mjs                          （memory_* 工具）
  ▼
daemon（bun 进程，自研集成层）
  ├─ daemon/start.mjs          Web UI + HTTP API（:5757）+ 捕获 sidecar（:5758）
  ├─ daemon/capture-core.mjs   捕获核心：读会话记录 → LLM 提炼 → 写入向量库
  ├─ daemon/profile-learning.mjs  用户画像学习
  └─ daemon/opencode-mem/      上游源码内嵌副本（vendor，仅 1 个文件有补丁，见 PATCHES.md）
       └─ 本地 Turso/libSQL 向量库 + Web UI（存储与检索引擎）
```

对上游 opencode-mem 是**薄封装**（vendor 零改动，仅 5 处 Windows 兼容补丁，见 `daemon/opencode-mem/PATCHES.md`）；宿主集成层（hooks/capture/MCP/画像调度）为 Kimi Code 全新实现。

## 环境要求

- Windows（目前只在 Windows 上验证过）
- [Kimi Code](https://www.kimi.com/) CLI
- [Bun](https://bun.sh/)（daemon 必须用它运行）
- Node.js 18+（hooks 和 MCP server 用它运行）
- Git（用于解析项目 tag 和用户画像的 userId）
- 一个 OpenAI Chat 兼容的 LLM 端点（用于记忆提炼和画像学习，如火山引擎方舟、DeepSeek、MiniMax 等）

## 安装

### 方式一：Release zip（推荐，一条命令）

在 Kimi Code 中：

```
/plugins install https://github.com/skywalker-35/kimi-mem/releases/latest/download/kimi-mem.zip
```

然后：

1. 设置 API key 环境变量（与配置里 `apiKeyEnv` 对应，默认 `OPENAI_API_KEY`），例如 PowerShell：
   `[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "你的key", "User")`
2. 新建用户级配置 `~/.kimi-mem/kimi-mem.config.json`，填入你的 OpenAI 兼容端点和模型：
   ```json
   {
     "capture": {
       "apiUrl": "https://api.deepseek.com",
       "apiKeyEnv": "OPENAI_API_KEY",
       "model": "deepseek-v4-flash"
     }
   }
   ```
3. `/new` 或 `/reload` 使插件生效

任何 OpenAI Chat 兼容的服务都可以，常见配置速查：

| 服务商 | `apiUrl` | `model` 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.3-instant` 等 |
| 火山引擎方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 你的接入点 ID（`ep-xxxx`） |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-M3` 等 |

> 模型名以各服务商当前文档为准（如 DeepSeek 旧的 `deepseek-chat` 已于 2026-07 停用）。提炼任务量小，选便宜快速的模型即可。

首次触发捕获时会自动后台执行 `bun install` 安装 vendor 运行时依赖（约 1-2 分钟），完成后 daemon 自动拉起，访问 `http://127.0.0.1:5757` 确认 Web UI。

### 方式二：克隆源码（开发者）

```bash
# 1. 克隆并构建 vendor（opencode-mem 的存储引擎 + Web UI）
git clone https://github.com/skywalker-35/kimi-mem.git
cd kimi-mem/daemon/opencode-mem
bun install
bun x tsc
cd web && bun install && bun run build   # Web UI 产物输出到 ../dist/web

# 2. 配置（二选一）：
#    a. 编辑 plugin/kimi-mem.config.json 的 capture.model（模型/接入点 ID）、apiUrl、apiKeyEnv
#    b. 或放用户级配置 ~/.kimi-mem/kimi-mem.config.json（推荐，本机私密值不进 git）：
#       { "daemonHome": "<克隆路径>/daemon", "capture": { "model": "..." } }
#       ※ daemonHome 必填：本地安装会把插件复制到托管目录，仓库布局的自动探测会失效

# 3. 设置 API key 环境变量（与 apiKeyEnv 对应，默认 OPENAI_API_KEY）
#    PowerShell: [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "你的key", "User")
```

然后在 Kimi Code 中：

```
/plugins install <克隆路径>/plugin
/new        # 或 /reload，使插件生效
```

> 用户画像功能需要 git email 作为用户标识：在任意项目仓库设置过 `git config user.email`（仓库级即可）即可自动识别。

## 配置（plugin/kimi-mem.config.json）

| 键 | 说明 | 默认 |
|---|---|---|
| `port` | Web UI / API 端口（sidecar 捕获端口 = port+1） | `5757` |
| `daemonHome` | daemon 代码目录（含 `start.mjs`） | 仓库内 `plugin/` 的兄弟目录 `daemon/` |
| `bunPath` | bun 可执行文件路径（备选：`KIMI_MEM_BUN` 环境变量） | 自动探测 |
| `inject.enabled` / `maxResults` / `minPromptLength` | 注入开关 / 最多注入条数 / 短于该长度不触发检索 | `true` / `5` / `8` |
| `capture.enabled` | 自动捕获开关 | `true` |
| `capture.minIntervalSec` | 同一会话两次捕获的最小间隔 | `120` |
| `capture.provider` / `apiUrl` / `apiKeyEnv` / `model` | 提炼用 LLM（OpenAI Chat 兼容） | OpenAI 官方端点 + `OPENAI_API_KEY` |
| `capture.extraParams` | 附加请求参数（如 `reasoning_effort`） | — |
| `capture.notify` | 捕获完成弹 Windows 通知 | `true` |
| `profile.enabled` / `analysisInterval` | 画像学习开关 / 每积累多少条 prompt 学一次 | `true` / `10` |

另外 daemon 复用 opencode-mem 的配置文件 `~/.config/opencode/opencode-mem.jsonc`（存储路径等）。

**用户级覆盖配置**：`~/.kimi-mem/kimi-mem.config.json`（不存在则跳过）会深度合并覆盖插件目录里的配置，适合放本机私密值（`daemonHome`、`bunPath`、`capture.model` 等），这样仓库内的配置文件可以保持模板原样。合并顺序：内置默认 < 插件目录配置 < 用户级配置。

## 数据与隐私

- 所有记忆存在本地 `~/.opencode-mem/data`（Turso/libSQL 向量库），**与 opencode-mem 共享**——如果你同时用 OpenCode + opencode-mem，两边记忆互通
- 唯一出网的数据：捕获/画像学习时把会话摘要发送到你**自己配置**的 LLM 端点
- 日志在 `~/.kimi-mem/`（debug.log / profile-debug.log / cursors.json 等）

## 与 opencode-mem 的关系（数据共享与共存）

如果你同时是 OpenCode 用户、已经装了 opencode-mem：

- **数据库完全共享**：kimi-mem 刻意复用 opencode-mem 的默认存储（`~/.opencode-mem/data`）、配置文件（`~/.config/opencode/opencode-mem.jsonc`）、项目 tag 算法和认证 token。同一个项目在两边产生的记忆落在同一个 shard——OpenCode 里存的，Kimi Code 里能注入，反之亦然。装 kimi-mem 后历史记忆立刻可见，零迁移
- **进程相互独立**：两边 daemon 各开各的端口（opencode-mem 默认 4747，kimi-mem 默认 5757），互不干扰，可以只装其中一个，也可以同时跑
- **同时捕获会冲突吗**：两个 daemon 写同一个 SQLite/libSQL 本地库，理论上并发写存在瞬时锁竞争，但实际上——① 两边只会捕获各自工具的会话（opencode-mem 抓 OpenCode 会话，kimi-mem 抓 Kimi Code 会话），不会写入重复内容；② 写入都是短事务，撞上同一时刻的概率极低；③ 即便撞上，SQLite 事务是原子的，不会损坏数据，kimi-mem 侧还有捕获失败自动重试兜底。实测双 daemon 长期共存无异常
- **版本一致性提醒**：共享存储意味着两边最好跟随相近的上游版本。若未来 opencode-mem 升级改了存储格式或 tag 算法，请等 kimi-mem 同步升级后再混用（vendor 版本见 `daemon/opencode-mem/package.json`，当前基于上游 `eda6583`）

## 常见问题

- **改了 `plugin/` 下的代码不生效**：Kimi Code 会把插件复制到托管目录（`$KIMI_CODE_HOME/plugins/managed/kimi-mem/`），改完需要同步该目录；改 `daemon/` 下的代码则需重启 daemon
- **记忆没捕获**：看 `~/.kimi-mem/debug.log`；确认 daemon 在跑（访问 :5757）、API key 环境变量已设置且**重启过终端**
- **Web UI 画像页显示 No profile found**：画像按 git email 识别用户，先在你的项目仓库里 `git config user.email you@example.com`

## 致谢与许可

- 存储引擎、向量检索、Web UI、画像管理来自 [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem)（MIT），以 vendor 形式内嵌在 `daemon/opencode-mem/`，补丁清单见 `daemon/opencode-mem/PATCHES.md`
- 本项目自身代码以 [MIT](./LICENSE) 发布

开发过程中的踩坑记录（给维护者看的）：[docs/dev-notes.md](./docs/dev-notes.md)；发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)
