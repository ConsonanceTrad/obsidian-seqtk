## 职责

设置面板 UI 与设置配置文件的读写方式
展示什么是可变可调整的

## 边界判据

放这里：
- 设置内部 UI
- 设置持久化读写封装。

不放这里：

- "设置变更后的数据层反应"（重扫、队列 debounce 更新）→ `main.ts` 装配回调
- 其它任何业务 / 视图逻辑

## 子页面的特殊性（sub-page）

声明式设置项由框架渲染，样式与官方一致；**子页面里的命令式渲染没有这层保护** ——
自己造的 DOM 得自己守住与设置项一致的观感。同一个坑踩过三次，记在这里：

- **必须先改流向（最容易忘、也是踩了三次的那一步）**：`render` 拿到的是那条
  **setting-item**，它默认是 **横向 flex** —— 往里追加的多块内容会被并排成一行，表现就是
  「整页横向排列」。头一件事就是 `el.addClass('seqtk-settings-<页名>')`，并在 styles.css
  里给它 `display: block`。四个子页各有一个类：`.seqtk-settings-rules`（状态传播规则）、
  `.seqtk-settings-kind-labels`（类型外观）、`.seqtk-settings-hub`（中控台显示）、
  `.seqtk-settings-syntax`（语法指南）。
- **条目内部也纵向，且一个语法点一条**：一条 = 语法 / 名称一行 + 说明一行
  （`display: flex; flex-direction: column`）；不要在同一行里用分隔符并列多项
  （状态、`@field` 的取值、父字段白名单都要逐条展开）。
- **字体与颜色随官方**：说明用 `var(--font-ui-smaller)` + `var(--text-muted)`；代码片段用
  `var(--font-monospace)`。不要用正文色，更不要放大成标题。
- **优先用官方组件**：`new Setting(el).setName(...).setDesc(...)` 能表达的，就别手写 DOM；
  只有自定义控件（取色器、代码片段、可增删的表）才手写，并沿用官方行的字体与间距。
- **不会自动保存、也不会自动重画**：`render` 回调里改的值要自己落盘；结构变化要自己调
  `update()` —— 代价是整页 DOM 重建，焦点与滚动位置会丢（见 SettingsTab 的 `update()` 说明）。

现有四个子页可参照：状态传播规则（可增删的 Setting 行）、类型外观（Setting + 取色器）、
中控台显示（Setting + 开关）、语法指南（只读速查表，纵向 `.seqtk-syntax-row`）。
