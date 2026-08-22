# kimi-mem 对上游 opencode-mem 的补丁清单

本目录是 [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem) 的内嵌副本（vendor fork），基于上游 `main`（`eda6583`）。kimi-mem 对上游源码的修改**仅有以下一处文件**，其余全部为零改动：

## `src/services/tags.ts` — 5 处 `windowsHide: true` 补丁

**位置**：`getGitEmail` / `getGitUserName` 等函数中的 5 处 `execSync("git ...")` 调用（约 63、76、90、104、133 行）。

**问题**：kimi-mem 的 daemon 是以无控制台方式拉起的后台进程。上游这些 `execSync` 没有 `windowsHide: true`，在 Windows 上每次调用都会弹出 `git.exe` 控制台黑窗（表现为"会话结束时命令行窗口闪退/闪烁"）。

**修复**：给这 5 处 `execSync` 的 options 增加 `windowsHide: true`：

```ts
execSync("git config user.email", {
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true, // kimi-mem 补丁
});
```

**升级上游时重放方法**：拉取上游新版后，搜索 `src/services/tags.ts` 中所有 `execSync`，逐个补上 `windowsHide: true`（共 5 处），然后重新构建：

```bash
cd daemon/opencode-mem
bun install
bun x tsc
cd web && bun install && bun run build   # 产物输出到 ../dist/web
```

## Web UI 品牌替换（kimi-mem 皮肤）

**位置**：`web/index.html` 的 `<title>`，以及 `web/src/lib/i18n/translations.ts` 三处语言的 `title` / `brand`。

**改动**：

- `OpenCode Memory Explorer` → `Kimi Memory Explorer`（en/zh 的 title 与 index.html）
- 阿拉伯语 title 相应替换
- `brand: "opencode-mem"` → `brand: "kimi-mem"`（侧边栏品牌文字，共 3 处）

**不改的**：`localStorage` key（`opencode-mem-lang` 等）、`/opencode-mem-icon.png` 图标文件、`x-opencode-mem-token` 请求头——这些是内部协议标识，改了会破坏兼容。

**重放方法**：按上面的字符串对照表替换即可，然后 `cd web && bun run build` 重建 Web UI。
