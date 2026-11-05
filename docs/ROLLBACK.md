# 回滚与恢复

这份文档针对当前 Windows WIP 和已生成的 Myna 分发包。它不要求删除用户会话，也不把未提交改动当成可随意丢弃的临时文件。

## 当前基线

- 当前分支：`main`
- 当前 Git 基线：`origin/main`（本地核对时为 `4601fd2`）
- 当前工作区：包含未提交的产品 WIP；先保存差异，再做任何回退
- 当前分发目录：`dist/`、`dist-installer/`、`.installer-staging/`，均为构建产物，不是源码基线

## 保存当前 WIP

在需要切换实验方向或交给另一位开发者前，先在仓库外保存补丁和状态清单：

```powershell
git status --short > "$env:TEMP\myna-status.txt"
git diff --binary > "$env:TEMP\myna-wip.patch"
```

补丁只保存已跟踪文件的差异；新文件还需要单独复制或使用 Git 的 `--no-index` 归档。不要用 `git reset --hard`、`git checkout -- .` 或 `git clean -fd` 清理当前工作区。

## 源码回退

回退前先确认没有正在使用当前目录的 Electron 实例，检查根目录 `.dev-quiet`，并保留上面的补丁。源码回到稳定基线应通过新分支、临时副本或人工逐文件恢复完成；不要直接覆盖用户会话目录。

## 分发回退

- 安装包回退：从 GitHub Releases 选择上一版 `Myna-Setup-<version>.exe`，先核对对应 `.sha256`，再手动运行安装程序。
- 便携版回退：解压上一版 `Myna-<version>-win64.zip` 到新的目录，确认能启动后再替换快捷方式指向。
- 当前安装脚本不会在卸载时删除 `%USERPROFILE%\.pi\agent`，会话和 provider 配置应继续保留。
- 未签名包会触发 SmartScreen；`SHA256` 只证明下载内容完整，不代表发布者可信。

## 发布前停线条件

以下任一项未满足，都不要运行正式 `npm run release <version>`：

- 工作区干净，且目标版本已经在发布说明中确认
- `npm test`、`npm run check`、真实 Electron E2E 和 Windows 构建均通过
- 安装包与 zip 的版本、SHA256 文件和 Release 资产名称一致
- 已明确说明是否签名；未签名时不能宣传为可信发布
- 至少有一份可恢复的 WIP/提交记录，能回到发布前状态

`npm run release <version> -- --dry` 只做测试和语法检查，不会替代真实构建或发布审批。

正式发布脚本在写入目标版本后，如果流程以失败状态结束且版本提交尚未完成，会自动恢复发布前的 `package.json` 文本，并撤销本次脚本对该文件的暂存；成功提交后不会回滚已提交版本。
