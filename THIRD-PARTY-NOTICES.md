# Third-Party Notices

Myna 自身以 MIT License 发布，见 [LICENSE](LICENSE)。本文件列出 Myna 参考、内置或随发行包分发的第三方软件与它们的许可。

## 架构与交互参考（不随本项目分发源码）

以下 MIT 项目在设计阶段被阅读和参考；Myna 使用原生 ES module，不引入它们的运行时：

| 项目 | 许可 | 版权 |
|---|---|---|
| [jmfederico/pi-web](https://github.com/jmfederico/pi-web) | MIT | Copyright (c) 2026 Federico Jaramillo Martinez |
| deepseek-harness | MIT | Copyright (c) 2026 DeepSeek |

如果后续引入其中任何源码，必须在该文件补充对应的版权声明，并保留原始许可文本。

## 运行时依赖

| 组件 | 版本 | 许可 | 版权 / 来源 |
|---|---|---|---|
| [pi coding agent](https://github.com/earendil-works/pi) | 1.5.0 | MIT | Copyright (c) 2025 Mario Zechner |
| [Electron](https://www.electronjs.org/) | 45.x | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| [shiki](https://shiki.style/) | 4.6.0 | MIT | Copyright (c) 2021 Pine Wu; Anthony Fu |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2023 Arjun Barrett |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | Apache-2.0 | Copyright Mozilla Foundation |

## 构建与打包工具（不进入运行时）

| 组件 | 许可 |
|---|---|
| [electron-builder](https://www.electron.build/) | MIT |
| [rcedit](https://github.com/electron/rcedit) | MIT |

## 许可文本位置

- 安装版：`resources/pi/LICENSE`（内置 pi）、`resources/app/THIRD-PARTY-NOTICES.md`、`resources/app/node_modules/*/LICENSE`（shiki / fflate / pdfjs-dist）、Electron 自带 `LICENSE` 与 `LICENSES.chromium.html`。
- 便携版：`Myna/resources/app/...` 与 `Myna/resources/app/node_modules/@earendil-works/pi-coding-agent/LICENSE`。
- 源码运行：依赖的许可文本位于 `node_modules/<package>/LICENSE`。

构建脚本会把 pi 与 pdfjs-dist 的 LICENSE 一并复制进发行包；新增运行时依赖时，请同时更新本文件、`README.md` 的依赖说明和 `scripts/check-syntax.mjs` 的依赖白名单。
