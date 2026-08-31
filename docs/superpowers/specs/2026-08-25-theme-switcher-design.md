# 工作台主题切换（5 风格）设计

日期：2026-08-25
状态：已确认（用户从 10 套 demo 中选定）

## 背景与目标

工作台现为单一「奶油马卡龙」风格。新增主题切换能力：共 5 套风格，用户可在设置里选择并即时切换。

**核心约束：只换皮，不改任何布局与交互。**

## 选定风格（demo 中的编号）

| key | 名字 | demo 编号 | 说明 |
|---|---|---|---|
| `macaron` | 奶油马卡龙 | 01 | 现有版，默认主题 |
| `midnight` | 午夜琥珀 | 05 | 唯一暗色 |
| `peach` | 蜜桃汽水 | 07 | 清爽甜系 |
| `matcha` | 抹茶和风 | 08 | 日式侘寂 |
| `minimal` | 极简画布 | 10 | 黑白极简 |

## 技术方案

### 原理

现有 CSS 里颜色/圆角/阴影/字体已 95% 走 `:root` CSS 变量（约 413 处引用）。主题 = 一套变量覆盖：

```
body[data-theme="midnight"] { --cream:#211B13; --ink:#EFE5D2; ... }
```

切换 = 改 `<body>` 的 `data-theme` 属性，零重渲染、零布局变化。

### 变量集

从 demo（theme-demos/theme-demo.html 已验证的色板）移植五套变量组。需覆盖的变量分组：
- 背景/纸面：--cream / --cream-2 / --cream-3 / --paper / --paper-2
- 墨色三阶：--ink / --ink-2 / --ink-3
- 线条：--line / --line-2
- 六功能色 + 深色 + 底色（coral/matcha/lav/honey/rose/sky 各三档）
- 圆角：--radius-s / --radius / --radius-l / --pill
- 阴影：--shadow-s / --shadow
- 字体：--sans / --serif（墨韵用楷体、报刊用 Didot——本次 5 套中 matcha 用楷体标题）

### 硬编码色的收编（一次性小重构，属「换皮必需」）

现有 CSS 有少量硬编码色不随变量走，切主题时会残留奶油色。需收编为变量：
- `body` 背景的三团 radial-gradient 光斑 → `--bg-body`
- `.sidebar` 渐变 → `--sidebar-bg`
- `.btn-coral` / `.mini.pri` 渐变 → `--grad-btn`
- `.btn-lav` 渐变 → `--grad-btn-2`
- `.hero` 渐变 → `--grad-hero`
- `body::before` 噪点透明度 → `--noise-opacity`
- 滚动条 rgba、`.sb-logo` 渐变等零散处（grep 排查收编）

布局类属性（尺寸/间距/字体大小）**不动**。

### 暗色主题（midnight）的专属注意

- 现有内联样式中 `color:#fff` 出现在彩色渐变按钮上——midnight 下渐变仍深、字白，可接受；逐一核对
- `border:#fff`（头像）等白色硬编码在暗色下仍合理
- `.rev-card dim`、`.lesson-card` 等暗色沉淀区在 midnight 下的对比度核对

### 前端交互

- 入口：侧边栏「AI 配置」项旁不动，主题选择放**个人资料弹窗**（profileModal）内新增「外观」区块：5 个色板圆点选择器（同 demo 的 sw-chip 形态），点选即切
- 持久化：`localStorage wb_theme`，启动时 `<script>` 最早处读取并设置 `document.body.dataset.theme`（避免闪白，脚本置于 body 标签开始后的第一段内联脚本，或 HTML 里 body 直接带默认属性 + 启动脚本立即纠正）
- 默认 `macaron`；非法值回退 `macaron`

### 不做（YAGNI）

- 不做自定义色板/导入主题
- 不做按时间自动切换
- 不做手机版适配改动（主题对两端同时生效）

## 错误处理

- localStorage 读取失败/值非法 → 静默回退默认主题
- 主题变量缺失某项 → 回退到 :root 默认（CSS 天然继承，无需代码处理）

## 测试

前端无构建无单测（项目惯例）。验收 = 手动：
- 5 主题逐一切换：主页/选题池/素材库/拆解/标题/待办/日历/复盘 8 视觉检查无奶油色残留、文字对比度正常、弹窗（复盘/配置/个人资料）同样换皮
- 刷新后主题保持
- 布局零变化（切换前后同视窗截图对比，仅颜色差异）

## 文件改动

- `自媒体工作台.html`（唯一文件）：`<style>` 增 5 套主题变量组 + 硬编码收编；`<body data-theme>`；个人资料弹窗增外观选择器；启动脚本读 localStorage；双份同步（根目录 + release/WorkBuddy）
