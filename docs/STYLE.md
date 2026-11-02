# pi-mini 视觉契约（Codex）

> 基准：本机 `OpenAI.Codex 26.1027` 的 renderer CSS（`app.asar` 解包到 `C:\Users\Luke\projects\codex-real`）。
> 交叉验证：`Suk1u/codex-clone` 的拆解与 `codex-ui-kit@0.1.2`（MIT）。
> 本文件只定「视觉」，技术契约见 `docs/ARCHITECTURE.md`。

## 0. 来源与置信度

| 标记 | 来源 | 置信度 |
|---|---|---|
| `[R]` | 真机 renderer CSS 变量 | 高 |
| `[T]` | codex-clone 的逐帧拆解（含录屏采样） | 高 |
| `[K]` | codex-ui-kit（MIT，独立实现） | 中高 |
| `[C]` | codex-clone 的 CSS 实现 | 中（仅作结构参考） |

冲突裁决：`[R]` > `[T]` > `[K]` > `[C]`。两份来源矛盾的项在文末单列。

## 1. 基础 token（直接落 `styles/base.css`）

```css
:root {
  /* spacing & radius  [R] spacing:4px, radius-xl-base:12px */
  --spacing: 4px;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 20px;
  --radius-composer: 25px; /* [K] 1.5625rem */

  /* neutral ramp [R] 25 档，取本机 light 列 */
  --gray-0: #ffffff;
  --gray-25: #fcfcfc;
  --gray-50: #f9f9f9;
  --gray-75: #f3f3f3;
  --gray-100: #ededed;
  --gray-150: #dfdfdf;
  --gray-200: #cdcdcd;
  --gray-250: #b9b9b9;
  --gray-300: #afafaf;
  --gray-350: #9f9f9f;
  --gray-400: #8f8f8f;
  --gray-450: #767676;
  --gray-550: #4f4f4f;
  --gray-600: #414141;
  --gray-700: #303030;
  --gray-800: #212121;
  --gray-900: #181818;
  --gray-1000: #0d0d0d;

  /* semantic [R] */
  --bg: #ffffff;
  --surface-2: #f9f9f9;
  --side: #f3f3f3;
  --chrome: #ececec;
  --text: #1a1c1f;
  --dim: rgba(26, 28, 31, 0.65);   /* text-secondary */
  --faint: rgba(26, 28, 31, 0.5);  /* text-tertiary */
  --line: rgba(26, 28, 31, 0.08);  /* border */
  --line-strong: rgba(26, 28, 31, 0.12); /* border-heavy */
  --hover: rgba(26, 28, 31, 0.045);
  --sel: rgba(26, 28, 31, 0.075);
  --link: #2b7fd4;
  --accent-soft: rgba(43, 127, 212, 0.12);
  --err: #c0342b;
  --code-bg: #f6f6f6;
  --send-bg: #1a1c1f;

  /* elevation [R] */
  --shadow-composer: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 2px 8px 0 rgba(0, 0, 0, 0.04),
    0 4px 40px 8px rgba(0, 0, 0, 0.024);
  --shadow-menu: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 8px 16px -4px rgba(0, 0, 0, 0.12);
  --shadow-surface: 0 1px 2px rgba(0, 0, 0, 0.05), 0 0 0 0.5px rgba(0, 0, 0, 0.06);

  /* type [R] */
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable Text", system-ui, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
  --text-body: 14px;
  --leading-body: 22px;
  --text-sm: 12px;
  --text-xs: 11px;
  --weight-shell: 445;

  /* layout [T] */
  --sidebar-width: 274px;
  --titlebar-height: 46px;
  --thread-max-width: 768px;
  --thread-inset-top: 33px;
  --thread-inset-x: 24px;
  --thread-inset-bottom: 32px;
  --turn-gap: 12px;
  --user-turn-gap: 34px;
  --composer-control: 28px;
  --composer-bottom-inset: 16px;
}
```

## 2. 组件规格

### 侧栏
- 宽 274px，背景 `--side`，右侧 1px `--line`（真机 hairline 0.5px，1x 屏用 1px）
- 行高 30–32px，圆角 8px，hover `--hover`，选中 `--sel`
- 分区标题 12px `--faint`；项目/会话名 `--text`，时间戳 `--faint`
- 字重 `--weight-shell`（445），图标 16px 线性

### 消息流
- 列宽 768px，左右 inset 24px，顶部 33px；正文 14/22
- 用户气泡：右对齐，最大 78%，背景 `--side`，1px `--line`，圆角 16px，padding 9px 14px
- 轮次间距 12px；用户轮前 34px
- 助手无气泡，直接排版；段落间距 11px，列表缩进 20px
- 工具行：保留 DSH 折叠交互，行高 28px，标题 12.5px mono，展开区背景 `--code-bg`
- diff：行号列 30px，新增 `#e6f4ea` / `#1a7f37`，删除 `#fdecec` / `#c0342b`

### 输入框（composer）
- 宽 768px（与消息列同宽），圆角 25px，1px `--line`，阴影 `--shadow-composer`
- 聚焦：边框 `--line-strong` + `0 0 0 3px var(--accent-soft)`
- 输入区 padding 12px 14px 4px；底栏 padding 2px 8px 8px
- 控件 28px；发送键 28px 圆形，背景 `--send-bg`，禁用降透明度
- 占位文案 14px `--faint`

### 菜单 / 弹层
- 圆角 12px，padding 5px，背景 `--bg`，1px `--line`，阴影 `--shadow-menu`
- 行高 30–32px，圆角 8px，字号 14px，padding 0 8px，hover `--hover`
- 分组标题 12px `--faint`，padding 6px 8px 4px
- 描述 12px `--faint`，右对齐；快捷键/来源标签 11px `--faint`
- 入场动画 110ms ease-out：`translateY(4px) scale(.985)` + 淡入；`prefers-reduced-motion` 关闭
- 打开时**不预选**任何行；只有指针移动或方向键后才出现高亮

### 空状态
- 居中：logo + 一句主文案 + 建议 chip；不放大字号，保持 14/22 节奏

## 3. 硬规则

1. 组件 CSS 只能使用第 1 节的变量；**禁止写裸十六进制**（token 块除外）
2. 阴影只允许 `--shadow-composer` / `--shadow-menu` / `--shadow-surface` 三个
3. 不做彩色填充；强调色只有 `--link` 和 `--accent-soft`
4. 新功能自注入 CSS，类名前缀（如 `.sug-` / `.smeta-` / `.json-`），不改 `base.css`
5. 深色模式**不做**（用户已明确否决）
6. 间距只用 4 的倍数；字号只用 11/12/12.5/14

## 4. 冲突与裁决

| 项 | 来源 A | 来源 B | 裁决 |
|---|---|---|---|
| 标题栏高 | `[R] --height-titlebar = 44px` | `[T]/[K] 46px` | 采用 **46px**（窗口 chrome 含 1px 边框），内容区 44px |
| 正文列宽 | `[R] --thread-content-max-width: 40rem/42rem（640/672）` | `[T]/[K] 768px` | 采用 **768px**（拆解按录屏实测），pi-mini 原 600px 作废 |
| 菜单行高 | `[C] 30px` | `[R] --app-menu-item-height = 40px（app 菜单）` | 弹层菜单用 **30–32px**；40px 是应用菜单栏，不适用 |
| 描边宽度 | `[R] .5px hairline` | 1x Windows | 用 **1px**，视觉等价，避免亚像素模糊 |
| 正文列 640/672 | 真机 token 变体 | — | 留给右栏展开态，pi-mini 不用 |

## 5. 待办（按此契约执行）

1. 重写 `styles/base.css` 的 `:root` 为第 1 节 token
2. `#app` 网格 → `44px 274px 1fr`；标题栏 46px
3. `.row` / `.box` / `.hint` / `.time` 宽度 → 768px（当前 640px 是错的）
4. `.user` 气泡 → `--side` + 1px `--line` + 16px
5. 弹层按第 2 节「菜单」重写（当前 `input-trigger.js` 的 CSS）
6. 工具行 24 → 28px，背景换 `--code-bg`
