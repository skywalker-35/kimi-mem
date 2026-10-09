# kimi-mem 对上游 opencode-mem 的补丁清单

本目录是 [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem) 的内嵌副本（vendor fork），基于上游 `v2.29.2`（`9871b6b`）。kimi-mem 对上游源码的修改**仅有 Web UI 品牌替换一处**，其余全部为零改动。

## `src/services/tags.ts` 的 `windowsHide` 补丁 —— 已上游化，v2.27.0 起不再需要

历史背景：kimi-mem 的 daemon 以无控制台后台进程方式拉起，上游旧版 `execFileSync`/`execSync("git ...")` 缺 `windowsHide: true`，Windows 上每次调用都会弹 `git.exe` 黑窗。kimi-mem 曾对此打本地补丁。

上游 v2.27.0 已合入等价修复（PR #324 "fix(tags): hide git console window on Windows"），`runGit` 内 `execFileSync` 自带 `windowsHide: true`（v2.29.2 约 129 行）。**升级上游时无需再重放此补丁**，只需确认该选项仍在。

## Web UI 品牌替换（kimi-mem 皮肤）

**位置**：`web/index.html` 的 `<title>`，以及 `web/src/lib/i18n/translations.ts` 五种语言（en/zh/ar/tr/nl）的 `title` / `brand`。

**改动**：

- `OpenCode Memory Explorer` → `Kimi Memory Explorer`（en/zh/nl 的 title 与 index.html）
- 阿拉伯语 title `مستكشف ذاكرة OpenCode` → `مستكشف ذاكرة Kimi`；土耳其语 title `OpenCode Hafıza Gezgini` → `Kimi Hafıza Gezgini`
- `brand: "opencode-mem"` → `brand: "kimi-mem"`（侧边栏品牌文字，共 5 处）

**不改的**：`localStorage` key（`opencode-mem-lang` 等）、`/opencode-mem-icon.png` 图标文件、`x-opencode-mem-token` 请求头——这些是内部协议标识，改了会破坏兼容。

**升级上游时重放方法**：拉取上游新版后，在 `web/index.html` 和 `web/src/lib/i18n/translations.ts` 中按上面的字符串对照表替换（注意新增语言也要一并替换），然后重建：

```bash
cd daemon/opencode-mem
bun install
bun x tsc
cd web && bun install && bun run build   # 产物输出到 ../dist/web
```
