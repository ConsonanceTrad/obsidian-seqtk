## 职责

- 渲染各视图本身、向 Pipe 套接层请求和传递操作数据
- 将渲染进行注册和拆分，使重复渲染组件体验一致

## 边界判据

放这里：
- 视图内私有渲染
- 专有命令注册
- 布局组装事件

不放这里：

- 需要被多个视图使用的结构或组件
- 与文件或缓存数据不经过套接层的直接操作和读取

## 渲染与逻辑分离契约（React + antd）

视图层自本次迁移起采用 React 19 + antd 6 渲染，**逻辑与渲染分文件**：

| 文件 | 职责 | 禁止 |
| --- | --- | --- |
| `Xxx.ts` | ItemView 子类：`@AutoView` / `@AutoRegister` 声明、生命周期、数据订阅编排、命令、状态持有 | 出现 JSX 字面量 |
| `XxxPanel.tsx` | 该视图专属的 React 树：只接收 props、只发出回调 | `import "obsidian"`、直接访问 NodeCache / DataPipe、发起写操作 |

> 命名注意：两者**不得同名**。esbuild 的 `resolveExtensions` 中 `.tsx` 优先于 `.ts`，
> 若存在 `Log.ts` 与 `Log.tsx` 同名配对，`import "./Log"` 会静默解析到 `.tsx`。

- 视图类继承 `src/P0_UI/ViewBase.ts` 的 `ReactViewBase`，只实现 `renderPanel()`；
  该方法内用 `createElement(Panel)` 组装，不写 JSX 字面量，视图类因此保持 `.ts`；
- 挂载 / 卸载由 `ReactViewBase` 统一管理，**子类不得重写 `onOpen` / `onClose`**；
- 数据经 `src/P0_UI/useStore.ts` 的 `useStore(store)` 订阅 `SimpleStore` 进入组件，
  **不引入任何状态管理库**；
- 视图专属渲染留在本层；跨视图复用的组件下沉到 `P7_Render`。

数据流（零新增设施，全部复用现有层）：

    P5_Data/SimpleStore ──useStore──▶ P7_Render 组件
            ▲                                │
       DataPipe / Queue ◀──── 回调 props ────┘

## 视图的职责边界（组件化后）

跨视图复用的画面元素与元素建组**全部下沉到 `P7_Render`**（节点行 → `C1_NodeLine`，
节点树 → `C2_Tree`）。视图层只做五件事：

1. **装配**：把组件放进视图容器（`renderPanel()` 返回的 React 树）；
2. **注册**：视图类与命令的注册（`@AutoView` / `@AutoRegister` / `registerCommands`）；
3. **微调**：向组件传入视图特化的 props（栏位 class、步距、选中态、是否显示某按钮）；
4. **数据注入**：订阅数据层 → 用纯函数构建视图模型 → 以 props 注入组件；
5. **交互数据传递**：接住组件回调（`NodeLineActions` 等），在其中调用数据层写入。

因此视图类里**不应再出现** `createEl` / `createDiv` / `addClass` 这类元素创建代码 ——
它们要么变成「构建视图模型」的纯函数，要么变成「注入给组件的回调」。

## 视图的切片约定（新增视图一律照此组织）

视图类只保留「装配 / 注册 / 微调 / 数据注入 / 交互转发」，其余**按功能切片**放进该视图目录下的子目录
（事务设计 → `V1_Affair/Design/`），**一个切片一个文件**。禁止把新功能继续堆进视图类 ——
堆到几百行之后，菜单、拖拽、数据写、会话恢复会全部绞在一个类里，只能靠通读全文才能改动一处。

| 位置 | 放什么 | 禁止 |
| --- | --- | --- |
| `Xxx.ts` | 视图壳：声明、生命周期、状态字段、`buildActions()` 逐项转发 | 菜单声明、数据写操作、拖拽判定、成段方法体 |
| `<视图>/<切片区>/*.ts` | 一类职责一个文件：状态构建 / 会话 / 数据动作 / 导航 / 行内编辑 / 文本编辑 / 菜单声明 / 拖拽事件 / 外部资源… | 为拿视图实例而 `import` 视图类做运行时依赖 |

切片的三条契约（不可破）：

1. **以 view 为第一参数**：`export function doSomething(view: DesignView, ...)`。视图壳侧只留一行转发；
   同一份行为因此也能被没有视图实例的宿主复用（如被委托的框架树）。
2. **只 `import type` 视图类**：切片的运行时依赖全部由参数传入，避免 `视图壳 ⇄ 切片` 的循环依赖。
3. **切片要读的视图成员改 public 并标注**：注释写「切片协作可见」，说明是哪个切片在何时读写；
   视图对外仍只暴露既有入口（`metas` / `create` / `registerCommands` / `FLUSH_Session` / `refresh*`）。

判据：视图类超过约 400 行，或一段逻辑能用「动词 + 名词」说清（构建状态、执行一个动作、声明一份菜单），
就该切片。**新功能一律加进切片或新切片，不回填视图壳。**

现有落地样例：`V1_Affair/Design/Core/Design.ts`（装配壳，约 400 行）+ `V1_Affair/Design/`（tree / viewModel /
viewState / session / actions / navigation / inlineEdit / textEdit / externalInfo /
menuDefinitions / templateActions / drag / dragHandlers）。

