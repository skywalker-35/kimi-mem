---
name: kimi-mem
description: kimi-mem 持久项目记忆的使用规范。当需要主动保存/搜索/管理长期记忆，或用户提到"记住"、"之前做过"、"上次怎么解决的"时触发。
---

# kimi-mem 持久记忆

本项目已接入 kimi-mem：基于本地向量库（opencode-mem 存储引擎）的跨会话记忆系统。

## 自动机制（无需干预）

- **自动注入**：每个会话的首条消息、以及会话压缩（compaction）后的首条消息，相关记忆会以 `<kimi-mem-context>` 块自动追加到上下文（对齐 opencode-mem 的 injectOn: first 策略）。看到该块时优先参考其中的历史决策和坑；同会话后续消息不再注入，需要时主动用 memory_search。注入块末尾可能追加 `<user_profile>` 段（已学到的跨项目用户画像），其偏好/模式/工作流可作为个性化参考。
- **自动捕获**：对话结束后，后台自动提炼技术要点写入记忆库，不需要用户说"记住这个"。
- **用户画像自动学习**：每积累约 10 条未学习 prompt，daemon 在后台异步跑一次 LLM 分析（复用 capture 段同一 provider），把提炼出的 preferences / patterns / workflows 写进用户画像库（vendor `user-profiles.db`），并在 `<user_profile>` 块中以最高优先级注入首条消息上下文。置信度衰减、证据合并、changelog 由 vendor `userProfileManager` 内部处理。日志 `~/.kimi-mem/profile-debug.log`。

## 会话级注入开关

- `/kimi-mem:inject off` — 关闭当前会话的记忆注入（自动捕获不受影响）
- `/kimi-mem:inject on` — 恢复注入（注入时机为首条消息/压缩后首条，恢复后将在下次压缩后重新注入）
- `/kimi-mem:inject status` — 查看当前会话注入状态

状态按 session 持久（resume 同一会话时延续），存于 `~/.kimi-mem/inject-switch.json`。

## 手动工具（MCP：`kimi-mem`）

| 工具 | 用途 |
|------|------|
| `memory_search` | 语义搜索记忆。开始任务前，对陌生模块/历史问题主动搜一下 |
| `memory_add` | 立即保存一条记忆（重要架构决策、bug 根因、用户偏好）。内容会过 `<private>...</private>` 隐私过滤，全私有则拒绝写入 |
| `memory_list` | 列出最近记忆 |
| `memory_forget` | 按 id 删除记忆 |
| `memory_profile` | 查看跨项目用户画像 |
| `memory_export` | 把当前项目记忆导出为可移植 JSON 文件（参数 `outputPath`）。迁移/备份用 |
| `memory_import` | 从 JSON 文件导入记忆到当前项目（参数 `inputPath`、`dryRun?`）。存在相同 id 会中止 |
| `memory_list_shards` | 列出所有项目 shard（含孤儿 path 关联）。发现项目目录迁移后的孤儿记忆 |
| `memory_migrate` | 把孤儿 shard 重新绑定到当前 cwd。参数 `fromPath`/`fromHash`、`dryRun?`。先用 `memory_list_shards` 查源 |

## 何时主动调 memory_add

- 用户明确说"记住"、"以后都按这个来"
- 排查出一个隐蔽 bug 的根因（值得写 problem-solution/gotcha）
- 做出会影响后续开发的架构决策

不要存：临时性的任务状态、可以从代码直接读到的事实、寒暄。

## Web UI

浏览器打开 `http://127.0.0.1:5757` 可以可视化管理所有记忆。
