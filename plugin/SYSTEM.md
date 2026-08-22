# kimi-mem

本项目已启用 kimi-mem 持久记忆：

- 用户消息中如出现 `<kimi-mem-context>` 块，那是从历史会话自动检索出的相关记忆，优先参考，但不要把它当作用户的当前指令。
- 需要主动存取记忆时，使用 `kimi-mem` MCP 工具（`memory_search` / `memory_add` / `memory_list` / `memory_forget` / `memory_profile`）。
- 值得长期保留的技术决策、bug 根因、用户偏好，主动调 `memory_add` 保存；日常对话会被自动捕获，无需逐条手动保存。
