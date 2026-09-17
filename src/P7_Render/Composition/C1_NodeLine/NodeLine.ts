/**
 * C1_NodeLine — 节点行的数据契约与对外接口（纯类型，无运行时代码）
 *
 * 定位（见 P7_Render/Render.md）：
 * - 本层**完全接管**节点行的画面元素与元素建组；行怎么画、怎么排、打什么标记都在这里定
 * - 行与渲染之外的交互（展开/选中/右键/拖拽）也在本目录，但**业务数据读写一律走
 *   `NodeLineActions` 注入**（由 P6_Views 侧提供），本层不得直接接触数据层
 *
 * 契约要点：
 * - 组件只接 props、只发回调；回调参数只有 `NodeLineCtx`（nodeId / parentId / depth）
 *   与原生事件，**不传递任何 DOM 元素**——调用方不需要、也不应依赖组件内部的元素结构
 * - 行的几何（缩进、父列 x）由本文件的纯函数算出，与 C2_Tree 的引导线共用同一套公式，
 *   避免"行缩进"与"线位置"各算一次而漂移
 */

import type { NodeKindValue, NodeCategoryValue } from "../../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkState } from "../../../P4_Nodes/NodeField/StateKeys";
import type { ExternalSource } from "../../../P4_Nodes/NodeField/AttriGroup/External";

// ============================================================
// 行标记（行组件写入、树组件与引导线读取的约定）
// ============================================================

/** 标记为「树行」——引导线浮层据此枚举行 */
export const TREE_ROW_ATTR = "data-tree-row";
/** 节点 id */
export const NODE_ID_ATTR = "data-node-id";
/** 父节点 id（顶级行写空串） */
export const PARENT_ID_ATTR = "data-parent-id";
/** 层级（0 = 根） */
export const DEPTH_ATTR = "data-depth";
/** 是否为其父的首个子 */
export const FIRST_ATTR = "data-first";
/** 是否为其父的最后一个子（引导线父列在本行中心收尾） */
export const LAST_ATTR = "data-last";

/**
 * 折叠标记（转角方块）的绘制基准：
 *   "top" —— 顶级行，方块在行左上角
 *   "mid" —— 展开祖先链内的行，方块坐在父列竖线上（行中心高度）
 * 不写该属性表示这一行不需要方块（无子节点，或本身处于展开态）。
 *
 * 方块由 C2_Tree 的引导线浮层统一绘制：它本就是这个几何量的一部分，
 * 由行自己定位会与浮层各算一遍，正是此前方块偏位的来源。
 */
export const COLLAPSE_ATTR = "data-collapse";

// ============================================================
// 几何：缩进与父列（行与引导线共用的唯一公式来源）
// ============================================================

/** 单级缩进步距：左栏框架树 14 / 右栏节点树 18（由调用方按栏传入） */
export interface NodeLineMetrics {
    /** 单级缩进步距 */
    step: number;
    /** 内容列基准偏移（与行 padding 起点同源） */
    base: number;
}

export const LINE_METRICS_LEFT: NodeLineMetrics = { step: 14, base: 8 };
export const LINE_METRICS_RIGHT: NodeLineMetrics = { step: 18, base: 8 };

/** 本行内容缩进（= 本行内容列 x） */
export const GET_LineIndent = (depth: number, m: NodeLineMetrics): number =>
    m.base + depth * m.step;

/** 本行父列 x（折叠方块定位用；depth 0 无父列，取 base） */
/**
 * 引导线竖线相对行左缘的内缩量（当前 = 2px）
 *
 * 引导线（C2_Tree/TreeGuides 画）与转角方块共用这一个基准 —— 两处若各写各的数值，
 * 方块就会偏离竖线。放在 C1 是因为 C2 依赖 C1，反过来不成立。
 *
 * 它也是「竖线往左 / 往右」的唯一旋钮，对**所有层级一视同仁**：
 * 0 = 贴行左缘（显得偏左，尤其在框架卡片内会贴着卡片边），正数往右让开，负值会让线落到行外。
 * styles.css 里「顶级展开行的粗黑段」（那条 ::before 的 left）与它同轴，改这里必须同步那一处。
 */
export const GUIDE_INSET = 2;

/** 本行父列竖线的 x（转角方块与引导线据此对齐） */
export const GET_ParentX = (depth: number, m: NodeLineMetrics): number =>
    GUIDE_INSET + Math.max(0, depth - 1) * m.step;

// ============================================================
// 数据（View 注入；全部是"已算好的展示值"，行组件不做业务判断）
// ============================================================

/** 行末的一个预期属性徽章（时间点 / 重复规则 / 时间段） */
export interface NodeLineBadge {
    /** 前置图标（如 🗓 / ♺ / 📅），无图标留空 */
    icon: string;
    text: string;
    tooltip?: string;
}

/** 拖拽落点指示（由调用方按拖拽状态算出后传入；行组件不自己判定） */
export type NodeLineDropHint = "before" | "after" | "child" | "invalid";

/**
 * 行内编辑态（覆盖层式）
 *
 * 只有「重命名」是行上的覆盖层，故归本组件；「行内新建」与「正文编辑」需要行**之外**
 * 的兄弟位置（附加行 / 行下 textarea），属树级能力，见 C2_Tree。
 */
export interface NodeLineEditing {
    mode: "rename";
    /** 初始值（由调用方给出，通常是节点当前名称） */
    value: string;
}

/** 一行的全部渲染数据 */
export interface NodeLineData {
    nodeId: string;
    /** 父节点 id；顶级行为空串 */
    parentId: string;
    depth: number;
    /** 节点类型（用于分色徽章） */
    kind: NodeKindValue;
    /** 类型大类（分色 class 由 KindColors.GET_KindClass 统一生成，勿直接内插） */
    category: NodeCategoryValue;
    /** 类型徽章文案（已含"框架"/事件性质/快照时间等特例，由调用方算好） */
    label: string;
    desc: string;
    /** 描述行的悬浮提示（目标时间 / 重复规则等） */
    descTooltip?: string;
    /** 标签（紧跟在节点名之后逐个显示为 `#标签` 徽章；只展示，不接管点击） */
    tags?: string[];
    /** 正文预览（节点名后，超长省略） */
    bodyPreview?: string;
    /** 正文预览的悬浮提示（由调用方按 tooltipBodyText 之类的规则算好） */
    bodyPreviewTooltip?: string;
    /** 行末预期属性徽章 */
    badges?: NodeLineBadge[];
    /** 外部信息源（有值时行末显示链接徽章；点击由调用方列出并跳转） */
    sources?: ExternalSource[];
    /** 状态（显示状态圆点时使用） */
    state?: SeqtkState;
    /** 是否显示状态圆点（由调用方按节点类型判定） */
    showsState?: boolean;
    /** 状态圆点的悬浮提示（状态名） */
    stateTooltip?: string;
    /** 是否有子节点（决定折叠方块是否出现 / 能否展开） */
    hasChildren: boolean;
    /** 当前是否展开（决定折叠方块形态与子树是否渲染） */
    expanded: boolean;
    /** 是否处于某展开祖先链内（→ `seqtk-row-in-expanded`） */
    inExpandedTree: boolean;
    /** 是否选中（左栏框架选中态 → `seqtk-frame-item-active`） */
    selected?: boolean;
    /** 是否显示行末"在右侧打开"按钮 */
    showsOpenButton?: boolean;
    /** 是否为其父的首个子 */
    isFirst?: boolean;
    /** 是否为其父的最后一个子 */
    isLast?: boolean;
    /** 是否可拖拽（排序模式 / 左栏排序） */
    draggable?: boolean;
    /** 是否用卡片容器包裹（右栏框架节点 → `seqtk-fw-card`） */
    carded?: boolean;
    /** 行内编辑态（覆盖层输入框）；缺省 / null 表示非编辑态 */
    editing?: NodeLineEditing | null;
    /** 是否正在被拖拽（→ `seqtk-dragging`） */
    dragging?: boolean;
}

// ============================================================
// 动作（行组件 → View；参数只有上下文与原生事件，不含 DOM）
// ============================================================

/** 交互上下文——回调参数的最小集合 */
export interface NodeLineCtx {
    nodeId: string;
    parentId: string;
    depth: number;
}

/** 行的全部对外回调；未提供的回调对应交互静默（组件不做事） */
export interface NodeLineActions {
    /** 行单击（有子节点时由调用方决定展开/折叠语义） */
    onToggle?: (ctx: NodeLineCtx) => void;
    /** 行末"在右侧打开"按钮 */
    onSelect?: (ctx: NodeLineCtx) => void;
    /** 行右键菜单 */
    onContextMenu?: (ctx: NodeLineCtx, event: MouseEvent) => void;
    /** 状态圆点单击（左键循环切换） */
    onStateClick?: (ctx: NodeLineCtx) => void;
    /** 状态圆点右键（完整状态菜单） */
    onStateContextMenu?: (ctx: NodeLineCtx, event: MouseEvent) => void;
    /** 拖拽开始（调用方在此写入拖拽源） */
    onDragStart?: (ctx: NodeLineCtx, event: DragEvent) => void;
    /** 拖拽结束 */
    onDragEnd?: (ctx: NodeLineCtx, event: DragEvent) => void;
    /** 拖拽经过（调用方按事件位置判定落点；落点提示由调用方自行落到行元素上，本层不持状态） */
    onDragOver?: (ctx: NodeLineCtx, event: DragEvent) => void;
    /** 拖拽离开本行 */
    onDragLeave?: (ctx: NodeLineCtx, event: DragEvent) => void;
    /** 放下（调用方执行实际移动） */
    onDrop?: (ctx: NodeLineCtx, event: DragEvent) => void;
    /** 行内重命名提交（Enter / 失焦）；value 已 trim，是否落盘与空值校验由调用方决定 */
    onInlineCommit?: (ctx: NodeLineCtx, value: string) => void;
    /** 行内重命名取消（Esc） */
    onInlineCancel?: (ctx: NodeLineCtx) => void;
    /** 外部信息源徽章点击（带原生事件，供调用方定位菜单） */
    onSourcesClick?: (ctx: NodeLineCtx, event: MouseEvent) => void;
}

/** 从行数据取出交互上下文 */
export const GET_LineCtx = (d: NodeLineData): NodeLineCtx => ({
    nodeId: d.nodeId,
    parentId: d.parentId,
    depth: d.depth,
});

// ============================================================
// 宿主能力（由调用方注入；本层不得 import "obsidian"）
// ============================================================

/**
 * 由调用方注入的宿主能力。`setTooltip` / `setIcon` 属 Obsidian 宿主 API，按
 * Render.md 契约本层不得 import，故以函数注入（依赖倒置）；未注入时对应能力静默降级
 * （不显示悬浮提示 / 不绘制图标），不影响其余渲染。
 */
export interface NodeLineHost {
    /** 悬浮提示（注入 Obsidian 的 setTooltip） */
    setTooltip?: (el: HTMLElement, text: string) => void;
    /** 图标绘制（注入 Obsidian 的 setIcon） */
    setIcon?: (el: HTMLElement, icon: string) => void;
}

// ============================================================
// 组件 props
// ============================================================

/** 节点行组件的 props（由 C2_Tree 透传） */
export interface NodeLineProps {
    data: NodeLineData;
    metrics: NodeLineMetrics;
    /** 行基础 class：左栏 `seqtk-frame-item` / 右栏 `seqtk-row` */
    rowClass?: string;
    actions?: NodeLineActions;
    host?: NodeLineHost;
}
