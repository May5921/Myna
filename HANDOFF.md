# myna 项目交接入口

myna 是 pi CLI 的 Electron GUI。当前产品只支持 pi，保留会话、流式消息、思考、工具卡、队列、右栏、归档、托盘、turn rail、设置和终端；不接 OpenCode 或 OMP，也不新增 pi TUI 没有的能力。

详细的当前状态、源码边界、验证证据和下一步请先读：

- [HANDOFF-FOR-CODEX.md](HANDOFF-FOR-CODEX.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STYLE.md](docs/STYLE.md)

## 开发约束

- 零构建、零新增运行时依赖；运行时依赖只有 Electron 和 shiki。
- 渲染层使用原生 ES module、`app://` 协议和 `window.pi`；不引入 React、Cordis 或远端脚本。
- pi 通过 `pi --mode rpc` 子进程接入；主进程只负责桥接和桌面壳。
- 修改正在运行的应用前先确认仓库根目录 `.dev-quiet`；不要擅自重载 Electron。
- 删除文件先送 Windows 回收站；改配置或安装依赖前先说明并备份。
- 不要擅自提交、推送或部署。

## 常用检查

```powershell
cd C:\Users\Luke\projects\pi-mini
npm test
npm run check
git diff --check
```

源码测试和语法检查不能替代 Electron 视觉回归或真实 pi reasoning 回合验证。当前工作区可能有未提交 WIP，状态结论以当前源码、命令输出和运行日志为准，不以旧截图或历史交接文字为准。

## 当前运行注意

- `.dev-quiet` 存在时，改文件不会自动重载当前 Electron。
- pi 子进程启动会清理格式非法的代理环境变量；合法的带协议代理会保留。
- pi RPC 的只读 `get_state` 探针已验证成功；没有发送模型 prompt。
