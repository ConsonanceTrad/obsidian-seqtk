## 职责

可复用渲染组件库，包括：
- Struct —— 系列固定的结构，可以将其作为视图的一部分直接使用
- Composition —— 面板的组件，一般是视图中的某一部分

## 边界判据

- 用于大体 DOM 渲染效果
- 渲染之外实际的交互，即使需要写在这里，实际业务代码也必须使用可供引入处注入的结构，以防止业务逻辑和渲染逻辑的混用

## 组件化契约（Composition / Structure）

本层**完全接管**所辖区域的画面元素与元素建组 —— 元素怎么创建、怎么组装、行上打什么
`data-*` 标记，都在本层由组件自己完成；视图层不再手写这些元素。

- 组件只接 props、只发回调；回调参数只带**交互上下文**（如 `NodeLineCtx` 的
  `{ nodeId, parentId, depth }`）与原生事件，**不得回传 DOM 元素** —— 调用方不需要、
  也不应依赖组件内部的元素结构；
- 交互行为（展开 / 选中 / 拖拽落点判定 / 右键）写在组件或同目录的交互模块里；但
  **业务数据读写一律经注入的回调**（如 `NodeLineActions`），本层**不得** `import "obsidian"`、
  **不得**直接读写 NodeCache / DataPipe / 文件；
- 视觉契约：沿用既有 class（`.seqtk-row` / `.seqtk-frame-item` / `.seqtk-kind-badge` …），
  样式集中在 `styles.css`；
- antd 组件按需引入（如 `import { Table } from "antd"`），依赖 esbuild tree-shaking；
- 样式作用域限定在 `.seqtk-antd-root` 内（见 `styles.css`），
  **不得引入 `antd/dist/reset.css`**（会重置 Obsidian 宿主界面）；
- 目录与组件对应关系：
  - `Composition/` —— `C1_NodeLine`（节点行）、`C2_Tree`（节点树 / 树栏 + 引导线浮层）、
    `C3_RightClickMenu`、`C4_Tooltip`、`C5_Icon`
  - `Structure/` —— `S1_Container`、`S2_Modal`、`S3_Board`