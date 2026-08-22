# CONTRIBUTING

欢迎贡献！提 Issue 或 PR 都可以。本文档主要面向维护者，记录发布流程和仓库结构约定。

## 仓库结构

- `plugin/` — Kimi Code 插件本体（hooks / MCP server / 配置模板 / skill）
- `daemon/` — 自研宿主集成层（捕获核心、画像学习、daemon 启动器）
- `daemon/opencode-mem/` — 上游 [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem) 的内嵌副本（vendor），补丁清单见 `daemon/opencode-mem/PATCHES.md`
- `scripts/` — 维护脚本（打包、版本 bump）
- `docs/dev-notes.md` — 开发踩坑记录

## 改代码后必做

- 改 `plugin/`：同步到受控副本 `$KIMI_CODE_HOME/plugins/managed/kimi-mem/`（`kimi.plugin.json` 改动需 `/plugins reload`）
- 改 `daemon/`：重启 daemon 生效
- 改 vendor：只改补丁清单里的内容，并更新 `PATCHES.md`；重建用 `bun x tsc` + `cd web && bun run build`

## 发布流程

版本号遵循语义化版本（semver），同时写在 `plugin/package.json` 和 `plugin/kimi.plugin.json`（`scripts/bump-version.ps1` 会同步改两个文件）：

```bash
pwsh scripts/bump-version.ps1 patch   # 修 bug：0.1.0 → 0.1.1（还有 minor / major）
git push origin main --follow-tags    # 推送 tag 后 CI 自动打包 zip 并发 GitHub Release
```

每个 Release 挂两个 zip：`kimi-mem-vX.Y.Z.zip`（存档用）和 `kimi-mem.zip`（固定文件名，README 的 `releases/latest/download/kimi-mem.zip` 安装链接永远指向最新版）。

CI 不可用时的手动兜底：

```bash
pwsh scripts/pack-release.ps1            # 本地打包，产物在 release/
gh release create vX.Y.Z release/kimi-mem-vX.Y.Z.zip release/kimi-mem.zip
```

Commit message 写清楚就相当于在写 changelog——Release notes 由 CI 的 `--generate-notes` 从 commit 提取。

## 升级上游 opencode-mem

拉取上游新版后，按 `daemon/opencode-mem/PATCHES.md` 重放补丁（tags.ts 5 处 `windowsHide` + Web UI 品牌替换），重建 vendor，并核对上游驱动层（`src/index.ts` 等）的改动是否需要同步到 `daemon/capture-core.mjs` / `daemon/profile-learning.mjs`。
