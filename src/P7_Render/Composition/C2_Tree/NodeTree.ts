/**
 * C2_Tree — 节点树的数据契约与对外接口（纯类型，无运行时代码）
 *
 * 定位（见 P7_Render/Render.md）：
 * - 本组件**完全接管**树的画面元素与元素建组：递归结构、行与行的排布、行上的树标记、
 *   引导线浮层，全部由本目录决定；视图层不再手写任何元素
 * - 左栏「框架树」与右栏「节点树」是同一组件的两份 props（步距、栏位 class、拖拽语义
 *   由调用方差分），不再各写一套渲染逻辑
 *
 * 契约要点：
 * - `TreeNodeItem.children` 只在**该行展开时**由调用方填充，折叠时给空数组 ——
 *   组件因此不需要知道 `expandedIds`，树的重建完全由调用方「注入数据」决定
 * - 行的首/末子（`line.isFirst` / `line.isLast`）也由调用方算好：这两个标记供引导线
 *   判断父列竖线的起止，属于「注入数据」而非组件内部状态
 */

import type { NodeKindValue } from "../../../P4_Nodes/NodeKind/NodeKind";
import type {
    NodeLineData,
    NodeLineActions,
    NodeLineMetrics,
    NodeLineHost,
} from "../C1_NodeLine/NodeLine";

/** 树的一个节点：一行渲染数据 + 其（按展开状态填充的）子节点 */
export interface TreeNodeItem {
    /** 该行的渲染数据（isFirst / isLast / expanded 等由调用方算好） */
    line: NodeLineData;
    /** 子节点；展开时填充，折叠时为空数组 */
    children: TreeNodeItem[];
}

/**
 * 行内新建态：在 `parentId` 的子列表末尾插入「附加行」（类型预览/下拉 + 名称输入）
 *
 * 归树而非行：附加行是行**之外**的兄弟节点，行组件只产出一个 div，放不下它。
 */
export interface NodeInlineCreating {
    /** 父节点 id；空串表示根级列表末尾 */
    parentId: string;
    /** 该父节点允许的子类型（多于一个时渲染类型下拉） */
    kinds: NodeKindValue[];
    /** 当前选中的类型 */
    kind: NodeKindValue;
    /** 附加行所在层级（= 父层级 + 1，用于缩进对齐） */
    depth: number;
    /** 连续输入：提交后保留附加行（同父级/类型/层级），便于逐条录入 */
    repeat?: boolean;
    /**
     * 保留附加行时用来换 key 的序号（每次提交后 +1）
     *
     * 附加行被保留时 React 会复用同一个组件实例，而组件内部的「本次提交已完成」保护位
     * 与输入框里残留的值都还在 —— 第二次录入会被自己拦掉。换 key 即换实例，两者一起归零。
     */
    seq?: number;
}

/** 行内正文编辑态：在 `nodeId` 那一行下方渲染覆盖式 textarea */
export interface NodeInlineBody {
    nodeId: string;
    /** 初始正文 */
    value: string;
}

/** 树级动作 = 行级动作 + 树才有的行内新建 / 正文编辑 */
export interface NodeTreeActions extends NodeLineActions {
    /** 行内新建提交（Enter）；name 已 trim，空值由组件拦下 */
    onCreateCommit?: (parentId: string, kind: NodeKindValue, name: string) => void;
    /** 行内新建取消（Esc / 失焦） */
    onCreateCancel?: (parentId: string) => void;
    /** 行内新建切换类型 */
    onCreateKindChange?: (parentId: string, kind: NodeKindValue) => void;
    /** 切换连续输入（提交后保留附加行） */
    onCreateRepeatChange?: (parentId: string, repeat: boolean) => void;
    /** 正文编辑提交（Ctrl+Enter / 失焦） */
    onBodyCommit?: (nodeId: string, body: string) => void;
    /** 正文编辑取消（Esc） */
    onBodyCancel?: (nodeId: string) => void;
}

/** 节点树组件的 props */
export interface NodeTreeProps {
    /** 根级行（左栏为顶级框架，右栏为选中框架的直接子节点） */
    items: TreeNodeItem[];
    /** 缩进步距与基准（左栏 LINE_METRICS_LEFT / 右栏 LINE_METRICS_RIGHT） */
    metrics: NodeLineMetrics;
    /** 交互回调（全部由调用方注入；未提供的交互静默） */
    actions?: NodeTreeActions;
    /** 宿主能力（setTooltip / setIcon，由调用方注入给每一行） */
    host?: NodeLineHost;
    /** 行基础 class：左栏 `seqtk-frame-item` / 右栏 `seqtk-row` */
    rowClass?: string;
    /** 树容器附加 class（左右栏视觉差异） */
    className?: string;
    /** 空态文案（items 为空时渲染）；不传则不渲染空态 */
    emptyText?: string;
    /** 是否绘制引导线浮层（默认绘制） */
    guides?: boolean;
    /**
     * 根级行的父 id（左栏 / 总览为空串，右栏是当前框架 id）。
     *
     * `NodeInlineCreating.parentId` 与它相等时，附加行插在**根列表末尾** ——
     * 右栏的根不是空串（它的根级行挂在框架下），所以判据不能用 ""。
     */
    rootParentId?: string;
    /** 行内新建态（在指定父节点的子列表末尾插入附加行） */
    creating?: NodeInlineCreating | null;
    /** 行内正文编辑态（在指定行下方渲染 textarea） */
    bodyEditing?: NodeInlineBody | null;
}

/** 树是否为空（调用方判断是否需要渲染空态时复用） */
export const IS_EmptyTree = (items: TreeNodeItem[]): boolean => items.length === 0;
