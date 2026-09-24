# AgentFeed Web 设计规范（调度站 Design System）

> 全站唯一视觉与代码规范来源。新增页面 / 组件 / 样式前先读本文；令牌与组件类一律复用，禁止另起炉灶。

## 1. 设计语言

**工业调度风**：把知识流水线（收件 → 分拣 → 精炼 → 入库 → 发车）映射为调度面板的视觉隐喻。

| 维度 | 规范 |
| --- | --- |
| 结构色 | 墨黑 `--ink` 描边 + 白卡片，边框硬朗（`border-bottom: 2px solid` 分级标题） |
| 信号色 | 琥珀黄 `--accent` 只用于"需要注意"（选中 / 暂停 / 今日），不做装饰 |
| 状态八色 | `ok / run / wait / fail / skip / warn` + `accent / ink`，配 `.dot-*` 状态点 |
| 形状 | 全站 2px 锐角（`--r`），无大圆角、无渐变、无玻璃拟态 |
| 数据色 | 钢蓝 `--steel` 为条形图 / 进度 / 链接主色；模型堆叠柱用 `MODEL_COLORS` 固定序列 |
| 字体 | 中文无衬线 `--sans`（PingFang SC 系）；数字 / 编号 / 路径一律 `--mono` + `.mono` |
| 密度 | 默认行距 `--rowpad: 8px`；顶栏可切紧凑（`body.compact` → 4px） |

## 2. 设计令牌（`styles/main.css :root`）

唯一视觉常量来源，按语义分组：**表面**（bg / bg-2 / card / card-2 / hover / hover-2 / active-soft / border / track）· **文字**（ink / text-2 / text-3）· **状态**（ok / run / wait / fail / fail-ink / skip / warn）· **数据**（steel / accent / wikilink）· **形状**（r / rowpad）· **阴影**（shadow-1 / shadow-2）· **字体**（sans / mono）。

**硬规则**

1. 视图层禁止硬编码 hex / rgb 颜色——一律 `var(--token)`；例外仅限：领域/标签**用户数据色**（存 DB 的值）、图表调色板 `MODEL_COLORS`、阅读器注入 iframe 的独立纸张主题。
2. 新增视觉常量先在 `:root` 登记并写注释，再使用。
3. 圆角只用 `var(--r)`；虚线边框表示"提示 / 未生效"，实线墨边表示"结构 / 生效"。
4. 动效克制：hover/选中 `.15s`，抽屉/弹层 `.2s~.22s`；全局已按 `prefers-reduced-motion` 降级。

## 3. 组件类速查（`styles/main.css`）

| 分类 | 类名 |
| --- | --- |
| 框架 | `.content` `.view-head` `.plate` `.vtitle` `.vsub` `.vright` |
| 区块 | `.sect` `.sect-head` `.sq` `.stitle` `.sright` `.cap` |
| 按钮 | `.btn`（`primary / signal / danger / ghost / sm / xs / icon-btn`） |
| 输入 | `.inp` `.switch` `.stepper` `.search-wrap` |
| 选择 | `.chip`（`on / sub`） `.tabs` `.tab` `.ovtabs` |
| 状态 | `.dot` `.dot-*` `.stb` `.stb-del` `.tagchip` `.vbadge` |
| 表格 | `.rtable`（移动端自动转卡片，需写 `data-l` 属性） |
| 弹层 | `.modal-wrap / -mask / -head / -body / -foot` `.modal-text` `.star` `.notice` `.swatches` |
| 抽屉 | `.scrim` `.drawer*` `.kvgrid` `.pathbox` `.vchain` |
| 空态 | `.empty`（大空态） `.sect-empty`（区块内说明行） |
| 工具 | `.mono` `.muted` `.dim3` `.spacer` `.pad-body` `.td-acts` `.row-title` `.mark-ok` `.mark-warn` `.mark-fail` |

## 4. 代码组织规范

```
web/src/
├── styles/main.css      # 全部全局样式：令牌 → 原子类 → 组件类 → 视图区块（带 TOC 注释）
├── utils/format.ts      # 纯函数：fmtTime / fmtTimeRelative / fmtTokens / fmtSize / copyToClipboard
├── composables/ui.ts    # 有状态复用：useCopyToClipboard / useDebouncedWatch / useTrendChart / LLM_STATE_MAP
├── stores/useXStore.ts  # Pinia：命名固定 useXStore
├── views/X.vue          # 路由页：复杂视图拆子组件（如 components/domains/TagGovPanel.vue）
└── components/          # 按域分子目录；PascalCase .vue
```

**规则**

1. **DRY 优先**：格式化函数进 `utils/format.ts`，带状态的逻辑进 `composables/`，视图内禁止第三次出现同口径实现。
2. **注释说为什么**：业务口径、防坑点、埋点约定必须注释；纯翻译代码不注释。
3. **内联 style 白名单**：仅限一次性布局微调（宽度、margin 例外值）；出现 ≥2 次的模式必须提升为共享类。
4. **颜色即语义**：强调用 `mark-ok/mark-warn/mark-fail`，状态点用 `dot-*`，不要用内联 color 表达状态。
5. **TS**：单引号、无分号、两空格；模板事件处理函数 `onXxx` / 动作 `xxxOp` 与现有命名保持一致。

## 5. 签名层（辨识度锚点）

全站只允许以下四种"氛围"手法，新增氛围效果先评估是否与它们冲突：

| 签名元素 | 实现 | 语义 |
| --- | --- | --- |
| 蓝图网格底纹 | `body` 双向 1px 墨线渐变，28px 方格，alpha .035 | 知识流水线落在图纸上 |
| 顶栏队列信号条 | `.topbar::before` 顶缘 3px：运行=钢蓝 / `.paused`=琥珀 | 控制室总闸，暂停一眼可见 |
| 铭牌切角 | `.plate` / `.brand-plate` 右下 5px `clip-path` 斜切 | 工业吊牌语言 |
| 流程带活体 | `.flowband::after` 虚线轨道（传送带）；`.live` 时箭头 `nudge` 节拍；`.flowseg.st-run/.st-fail` 左轨着色 | 业务流向与异常无需读数即可见 |

动效纪律：状态点 `dot-run` 呼吸圈（2s）；入场 `.content > *` 依次上浮（40ms 错峰）；全部动效被全局 `prefers-reduced-motion` 降级覆盖。除上述清单外不加散点动效。

## 6. 可访问性

- 交互控件带 `aria-label` / `title`；开关用 `role="switch"` + `aria-checked`。
- 键盘可达：`:focus-visible` 全局钢蓝描边；Enter/Esc 语义（确认 / 取消）。
- 对比度：正文 ≥ 4.5:1（ink/text-2 已达标）；文字不依赖颜色单独传达（配文案或图标）。
