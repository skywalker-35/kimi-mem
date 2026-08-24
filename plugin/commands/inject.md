---
description: 开关当前会话的 kimi-mem 记忆注入（off/on/status），不影响自动捕获
---
KIMI_MEM_INJECT_SWITCH:$ARGUMENTS

这是 kimi-mem 会话级注入开关命令，状态已由插件 hook 在本轮开始时持久化。请按以下两步处理：

1. 用 Read 工具读取 ~/.kimi-mem/inject-switch-last.json，把其中的 statusText 字段**原样**作为回复的第一行（不要自行判断状态）。读不到文件就回复 "kimi-mem：开关状态未知（hook 未生效，请 /plugins reload 或开新会话后重试）"。
2. `$ARGUMENTS` 中第一个词是开关动作（off/on/status）；如果后面还有其他内容，那是用户的实际问题，在状态行之后**正常回答**它。没有额外内容则到此为止。
