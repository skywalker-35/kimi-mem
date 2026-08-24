# kimi-mem Agent 规则

本仓库是 Kimi Code 插件。仓库结构、vendor 补丁规则、发布流程详见 `CONTRIBUTING.md`，开发踩坑记录见 `docs/dev-notes.md`。

## 改代码后必做（agent 视角）

- 改 `plugin/` 下任何文件：同步到受控副本 `$KIMI_CODE_HOME/plugins/managed/kimi-mem/`（实际路径 `F:\.kimi-code\plugins\managed\kimi-mem\`），并 diff 验证一致。`kimi.plugin.json` 改动需提示用户 `/plugins reload`
- 受控副本整目录 rename 会被运行中的 daemon 锁死（EBUSY），不要走 `/plugins install` 重装，直接 cp 单个文件
- 改 `daemon/`：提示用户重启 daemon（kill bun 进程后任意 hook 自动拉起）

## 发布 Release 时必做

- 版本号用 `pwsh scripts/bump-version.ps1 patch|minor|major` 同步修改 `plugin/package.json` 和 `plugin/kimi.plugin.json`
- 推送 commit 和 tag 后，CI 自动打包发 Release，但 **notes 只有一行对比链接，必须手动补写更新内容**：

  ```bash
  gh release edit vX.Y.Z --notes-file <说明文件>
  ```

- Release notes 用中文，包含：新增功能及用法、特性说明、升级方式（`/plugins install ...` + `/plugins reload`）
