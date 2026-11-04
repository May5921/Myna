# myna 视觉契约

> 本文件定义 myna 的视觉方向和可复用 token；技术契约见 `docs/ARCHITECTURE.md`。
> 外部产品只用于理解成熟交互的边界，不作为界面外观规范。

## 视觉方向

- **安静中性**：大面积中性色，颜色只表达状态、焦点和错误。
- **回合优先**：用户先看到当前回合是否在运行、思考、调用工具或已完成。
- **工具可追溯**：工具调用、结果、diff 和错误在同一条消息流中保持连续。
- **轻量壳**：设置、菜单和右栏服务于 pi 会话，不把桌面壳做成另一套产品。
- **myna 签名**：细窄 turn rail、无 assistant 气泡的正文流、低对比工具行和底部 composer 共同形成识别度。

## 0. 设计依据

| 标记 | 来源 | 置信度 |
|---|---|---|
| `[P]` | pi TUI / pi RPC 的真实语义 | 高 |
| `[M]` | myna 当前渲染测量与回归截图 | 高 |
| `[R]` | 外部产品的通用交互研究 | 仅作参考 |

冲突裁决：`[P]` > `[M]` > `[R]`。pi 的真实能力边界优先于外观偏好。

## 1. 基础 token（直接落 `styles/base.css`）

```css
:root {
  /* spacing & radius  [M] spacing:4px, radius-xl-base:12px */
  --spacing: 4px;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-3xl: 20px;
  --radius-composer: 25px;

  /* neutral ramp [M] */
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

  /* semantic */
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
  --link: #55468f;
  --accent-soft: rgba(85, 70, 143, 0.14);
  --err: #c0342b;
  --code-bg: #f6f6f6;
  --send-bg: #1a1c1f;

  /* elevation */
  --shadow-composer: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 2px 8px 0 rgba(0, 0, 0, 0.04),
    0 4px 40px 8px rgba(0, 0, 0, 0.024);
  --shadow-menu: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 8px 16px -4px rgba(0, 0, 0, 0.12);
  --shadow-surface: 0 1px 2px rgba(0, 0, 0, 0.05), 0 0 0 0.5px rgba(0, 0, 0, 0.06);

  /* type */
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable Text", system-ui, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
  --text-body: 14px;
  --leading-body: 22px;
  --text-sm: 12px;
  --text-xs: 11px;
  --weight-shell: 445;

  /* layout */
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
- 工具行：可折叠、默认收起。收起态**不是卡片**：无边框、无背景，只有一行 26px 的灰色工作记录（图标 + 工具名 + 参数 + 耗时）；展开后才有 `--surface-2` 浅色块与分隔线，内层不再叠第二层底色
- 过程折叠：一轮结束后，该轮的思考与工具调用统一收进一个 `.proc` 折叠块，摘要行为「过程 · N 次思考 · M 个工具 · 用时」；最终回答正文留在折叠块之外，按 Codex 的阅读顺序「结论在前、过程可追溯」
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

### 右栏（抽屉）
- 无标题行：tab 条就是上边，控件（视图菜单 / 全屏 / 关闭）排在 tab 条末端
- 宽度：默认 300，下限 260，上限 `min(560, 50vw)`（`--rp-w` 同时驱动面板宽和主区让位）
- 拖宽：`pointerdown` 不抢焦点（鼠标拖宽不得打断文件树/预览里的键盘位置）；双击复位；方向键 16px、`Home`/`End` 到两端、`Enter` 复位
- 拖动时左缘 1px 描边加亮到 2px，`body.rp-resizing` 期间禁用过渡和选中，松手才落盘
- 窄窗（`innerWidth < 768`）：打开右栏自动全屏；全屏退出时收起右栏；窗口变宽不自动重新打开
- 收起时焦点归还开关按钮，不留焦点在 `aria-hidden` 子树里
- 全屏时隐藏拖宽手柄（宽度 100%，没有可拖余量）

### 空状态
- 居中：logo + 一句主文案 + 建议 chip；不放大字号，保持 14/22 节奏

## 3. 硬规则

1. 组件 CSS 只能使用第 1 节的变量；**禁止写裸十六进制**（token 块除外）
2. 阴影只允许 `--shadow-composer` / `--shadow-menu` / `--shadow-surface` 三个
3. 不做彩色填充；强调色只有 `--link` 和 `--accent-soft`
4. 新功能自注入 CSS，类名前缀（如 `.sug-` / `.smeta-` / `.json-`），不改 `base.css`
5. 深色模式必须与浅色保持同一层级关系；只切换 token，不在组件里写第二套结构
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
3. `.row` / `.box` / `.hint` / `.time` 宽度 → 768px（当前 640px 是错的；实测按 DSH 聊天列宽取 748px，见 `--thread-max-width`）
4. `.user` 气泡 → `--side` + 1px `--line` + 16px
5. 弹层按第 2 节「菜单」重写（当前 `input-trigger.js` 的 CSS）
6. 工具行 → 收起态无框单行 26px；展开态 `--surface-2`（已完成）
