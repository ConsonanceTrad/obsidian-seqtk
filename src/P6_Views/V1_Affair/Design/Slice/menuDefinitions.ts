/**
 * design/menuDefinitions — 设计视图右键菜单声明切片
 *
 * 从 DesignView 拆出的全部菜单声明：行 / 框架行 / 状态圆点 / 左右栏空白，
 * 加上「打开菜单」的两个装配入口（showRowContextMenu / showRowStateMenu）。
 * 本切片只回答「长什么样、点了做什么」，真正的弹窗装配交给 BUILD_Menu。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读 view 上公开的状态
 *   （pipe / selectedFrameworkId / expandedLeft / expandedRight），不持有任何状态
 * - 动作一律转交对应切片（actions / navigation / inlineEdit / externalInfo / textEdit /
 *   templateActions / appendExisting），本文件不直接写数据面
 * - 组与组之间由装配器按 section 变化插分隔符，声明里不写分隔标记
 *
 * 功能增补指引:
 * - 新增一个菜单项 → 找到对应的 getXxxMenuDefinitions 追加声明；新增一类菜单 →
 *   加一个 export function，并在 Design.ts 的 buildActions 里接线
 */

import {
    BUILD_Menu,
    type MenuDefinition,
    type MenuDefinitions,
} from '../../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import {
    COLLAPSE_ITEM,
    EVIDENCE_ICONS,
    EXPAND_ITEM,
    ICON,
    SECTION,
    STATE_ICON,
} from '../../../../P7_Render/Composition/C3_RightClickMenu/MenuAppearance';
import { EVIDENCE_KINDS } from '../../../../P7_Render/Composition/C2_Tree/drag';
import { kindUsesState } from '../../../../P7_Render/Structure/S2_Modal/TransactionModals';
import {
    NODE_KIND,
    NODE_KIND_LABELS,
    NODE_STATE_LABELS,
    STATE_VALUES,
    getAllowedChildKinds,
    isFrameworkKind,
} from '../../../../P4_Nodes/NodeFacade';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeLineCtx } from '../../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import { archiveNode, openEdit, openNodeFile, setNodeState } from './actions';
import { saveAsTemplate, useTemplate } from './templateActions';
import { IS_RightCollapsed, changeParent, detachFromParent, setRightExpandAll, toggleExpandAll } from './navigation';
import { appendExistingInfo } from './appendExisting';
import { openBodyEdit, startCreateBlank, startCreateChild, startRename } from './inlineEdit';
import { addExternalSource, createTimestampDoc, manageExternalSources } from './externalInfo';
import { manageTags } from './tags';
import { copySubtreeAsText, editFrameworkContentAsText, editSubtreeAsText } from './textEdit';
import { buildFrameworkNode, buildNode, type TreeNode } from '../Tool/tree';
import { SYNC_FromFiles } from '../../../V0_Common/SyncFromFiles';
import type { TreeSide } from '../Core/DesignPanel';
import type { DesignView } from '../Core/Design';

// ============================================================
// 装配入口
// ============================================================

/** 状态圆点右键：完整状态菜单 */
export function showRowStateMenu(view: DesignView, nodeId: string, e: MouseEvent): void {
    const data = view.pipe.GET_Node(nodeId);
    if (!data) return;
    BUILD_Menu(getStateMenuDefinitions(view, buildNode(view.pipe, nodeId, data)), e);
}

/**
 * 行右键：左栏用框架菜单；右栏框架行用右向框架菜单，其余用节点行菜单
 *
 * `ctx` 由行渲染时算好，含**这一行所属的父**。凡涉及归属的动作都必须读它，不能拿
 * nodeId 回头去查上级 —— 多归属时「查到的第一个」未必是用户看着的这一条
 * （典型偏差：证据同时挂在框架与内部节点下，对内部节点断连却摘掉了框架那条）。
 */
export function showRowContextMenu(view: DesignView, ctx: NodeLineCtx, side: TreeSide, e: MouseEvent): void {
    const nodeId = ctx.nodeId;
    const data = view.pipe.GET_Node(nodeId);
    if (!data) return;
    if (side === 'left') {
        BUILD_Menu(getFrameMenuDefinitions(view, buildFrameworkNode(view.pipe, nodeId, data), ctx, 'left'), e);
        return;
    }
    const node = buildNode(view.pipe, nodeId, data);
    if (isFrameworkKind(data.kind)) BUILD_Menu(getFrameMenuDefinitions(view, node, ctx, 'right'), e);
    else BUILD_Menu(getRowMenuDefinitions(view, node, ctx, 'right'), e);
}

// ============================================================
// 菜单声明：本文件只回答「长什么样、点了做什么」，装配交给 BUILD_Menu
// ============================================================

/**
 * 追加信息子菜单（对象 / 条件 / 信息 / 状态）：空白菜单与行菜单共用，只是落点不同
 *
 * `onAppendExisting` 有值时末尾多一条「追加已有信息」：它不新建节点，而是把库里**已有**的
 * 证据节点挂到当前节点下（引用式，见 design/appendExisting）。两者同处一个子菜单，是因为
 * 它们回答的是同一个问题 ——「往这里补一条」，只是来源不同（新写一条 / 用现成的）。
 */
function evidenceSubmenuDefs(
    onPick: (kind: NodeKindValue) => void,
    onAppendExisting?: () => void,
): MenuDefinition[] {
    return [
        {
            name: '追加信息',
            icon: ICON.evidence,
            section: SECTION.main,
            items: [
                ...EVIDENCE_KINDS.map((kind) => ({
                    name: NODE_KIND_LABELS[kind],
                    icon: EVIDENCE_ICONS[kind],
                    action: () => onPick(kind),
                })),
                ...(onAppendExisting
                    ? [{
                        name: '追加已有信息',
                        icon: ICON.appendExisting,
                        action: () => onAppendExisting(),
                    }]
                    : []),
            ],
        },
    ];
}

/**
 * 「创建节点」子菜单：构思 / 清单 / 事件各一条，**按父类型过滤**
 *
 * 过滤用 getAllowedChildKinds（见 NodeChildAllow）：框架下三条都在，构想 / 方向 / 目标 /
 * 工序下只剩「新建事件」—— 事件本来就可以挂在任意一层。过滤后只剩一条时**直接平铺**，
 * 不再套一层只有一项的子菜单，那种壳只是让人多点一下。
 */
function createNodeSubmenuDefs(onPick: (kind: NodeKindValue) => void, parentKind?: NodeKindValue): MenuDefinition[] {
    const all = [
        { name: '新建构思', icon: ICON.newConcept, kind: NODE_KIND.CONCEPT as NodeKindValue },
        { name: '新建清单', icon: ICON.newCheck, kind: NODE_KIND.CHECK as NodeKindValue },
        { name: '新建事件', icon: ICON.newEvent, kind: NODE_KIND.EVENT as NodeKindValue },
    ];
    const allowed = parentKind ? getAllowedChildKinds(parentKind) : undefined;
    const picked = allowed ? all.filter((it) => allowed.includes(it.kind)) : all;
    if (picked.length === 0) return [];
    if (picked.length === 1) {
        const one = picked[0];
        return [{
            name: one.name,
            icon: one.icon,
            section: SECTION.main,
            action: () => onPick(one.kind),
        }];
    }
    return [{
        name: '创建节点',
        icon: ICON.createGroup,
        section: SECTION.main,
        items: picked.map((it) => ({
            name: it.name,
            icon: it.icon,
            action: () => onPick(it.kind),
        })),
    }];
}

/** 展开 / 收起：标题与图标随即将执行的行为变化（无子项的行不出现） */
function expandDefs(view: DesignView, node: TreeNode, side: TreeSide): MenuDefinition[] {
    if (node.children.length === 0) return [];
    const expanded = (side === 'right' ? view.expandedRight : view.expandedLeft).has(node.nodeId);
    return [
        {
            ...(expanded ? COLLAPSE_ITEM : EXPAND_ITEM),
            section: SECTION.main,
            action: () => toggleExpandAll(view, node, side),
        },
    ];
}

/** 行内追加子项：左栏是子框架；右栏按该行允许的子类型（目标固定为工序，事件另有入口） */
function newChildDefs(view: DesignView, node: TreeNode, ctx: NodeLineCtx, side: TreeSide): MenuDefinition[] {
    const kind = node.data.kind;
    // 事件走「新建事件」那条独立入口，这里排掉它，免得同一行菜单里两条路通向同一个动作
    const kinds = side === 'left'
        ? [NODE_KIND.TRANS]
        : getAllowedChildKinds(kind).filter((k) => k !== NODE_KIND.EVENT);
    if (kinds.length === 0) return [];
    const allowed = kind === NODE_KIND.TARGET ? [NODE_KIND.PROCESS] : kinds;
    return [
        {
            name: side === 'right' ? '追加子项' : '追加子框架',
            icon: ICON.newChild,
            section: SECTION.main,
            // 新建落到 ctx.parentId 下 —— 正是这一行显示时所属的那个父
            action: () => startCreateChild(view, ctx, side, allowed),
        },
    ];
}

/** 右栏框架行的行内新建入口（不开模态框）：与空白处同一个「创建节点」子菜单 */
function rightCreateDefs(view: DesignView, node: TreeNode, ctx: NodeLineCtx): MenuDefinition[] {
    return createNodeSubmenuDefs(
        (kind) => startCreateChild(view, ctx, 'right', [kind]),
        node.data.kind,
    );
}

/** 模板操作组：存为模板 / 使用模板 */
function templateDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    return [
        {
            name: '存为模板',
            icon: ICON.saveAsTemplate,
            section: SECTION.template,
            action: () => void saveAsTemplate(view, node.nodeId),
        },
        {
            name: '使用模板',
            icon: ICON.useTemplate,
            section: SECTION.template,
            action: () => useTemplate(view, node.nodeId),
        },
    ];
}

/** 左栏空白右键：新建框架 + 从磁盘刷新 */
export function getLeftBlankMenuDefinitions(view: DesignView): MenuDefinitions {
    return [
        {
            name: '新建框架',
            icon: ICON.newFramework,
            section: SECTION.main,
            action: () => startCreateBlank(view, NODE_KIND.TRANS, 'left'),
        },
        {
            name: '从磁盘刷新',
            icon: ICON.syncFromFiles,
            section: SECTION.refresh,
            action: () => void SYNC_FromFiles(view.pipe),
        },
    ];
}

/** 右栏空白右键：创建节点（子菜单）+ 追加信息 + 批量编辑 + 整栏展开收起 + 模板功能 + 从磁盘刷新 */
export function getRightBlankMenuDefinitions(view: DesignView): MenuDefinitions {
    const parentId = view.selectedFrameworkId ?? undefined;
    const parentData = parentId ? view.pipe.GET_Node(parentId) : undefined;
    /**
     * 空白处没有行可依附，模板动作以**打开的框架本身**为目标
     * （与框架卡片右键的模板动作同一个对象）；未打开框架时整项不出。
     */
    const templateTarget = parentId && parentData
        ? buildFrameworkNode(view.pipe, parentId, parentData)
        : undefined;
    return [
        // 形态与「追加信息」「模板功能」一致：三个「新建 X」收在一条子菜单里，
        // 空白处右键一眼能看完（框架行的行右键用的是同一个构造函数）
        ...createNodeSubmenuDefs((kind) => startCreateBlank(view, kind, 'right', parentId)),
        // 空白处的「追加已有信息」同样落到打开的框架下；没有打开框架时 parentId 为空，该项不出
        ...evidenceSubmenuDefs(
            (kind) => startCreateBlank(view, kind, 'right', parentId),
            parentId ? () => appendExistingInfo(view, parentId) : undefined,
        ),
        // 根可多个（框架自身那行藏起来），应对框架内元素较多的情况
        ...(parentId
            ? [
                  // 整栏展开 / 收起：空白处才有的「看全 / 收回」入口（行级那条只管单行子树）。
                  // 与行上一致，是**一项随状态切换**：已全部收起时给「全部展开」，否则给「全部收起」——
                  // 并排两条会让每次都要先看一眼才知道该点哪个
                  ...(() => {
                      const collapsed = IS_RightCollapsed(view);
                      return [{
                          name: collapsed ? '全部展开' : '全部收起',
                          icon: collapsed ? ICON.expandAll : ICON.collapseAll,
                          section: SECTION.main,
                          action: () => setRightExpandAll(view, collapsed),
                      }];
                  })(),
                  {
                      name: '批量编辑',
                      icon: ICON.editFrameworkContent,
                      section: SECTION.main,
                      action: () => editFrameworkContentAsText(view, parentId),
                  },
              ]
            : []),
        ...(templateTarget
            ? [
                  {
                      name: '模板功能',
                      icon: ICON.templateGroup,
                      section: SECTION.tools,
                      items: templateDefs(view, templateTarget),
                  },
              ]
            : []),
        {
            name: '从磁盘刷新',
            icon: ICON.syncFromFiles,
            section: SECTION.refresh,
            action: () => void SYNC_FromFiles(view.pipe),
        },
    ];
}

/**
 * 框架行右键：展开/收起 + 行内新建 + 重命名 + 时间规则 + 模板 + 归档
 *
 * 「追加子项」只在左栏出现（在那一栏它叫「追加子框架」）：右栏的框架卡片已经给了
 * 「创建节点」子菜单（新建构思 / 清单 / 事件）三个明确入口，再挂一条「按允许类型新建」的
 * 泛化项，只会让人在几个入口之间犹豫该点哪个。
 */
function getFrameMenuDefinitions(
    view: DesignView,
    node: TreeNode,
    ctx: NodeLineCtx,
    side: TreeSide,
): MenuDefinitions {
    const addEvidence = (kind: NodeKindValue): void =>
        startCreateChild(view, ctx, side, [kind]);
    return [
        ...expandDefs(view, node, side),
        ...(side === 'left' ? newChildDefs(view, node, ctx, side) : []),
        ...(side === 'right' ? rightCreateDefs(view, node, ctx) : []),
        ...(side === 'right'
            ? evidenceSubmenuDefs(addEvidence, () => appendExistingInfo(view, node.nodeId))
            : []),
        {
            name: '重命名',
            icon: ICON.rename,
            section: SECTION.main,
            action: () => startRename(view, node.nodeId, side),
        },
        {
            name: '时间规则',
            icon: ICON.editAttrs,
            section: SECTION.main,
            action: () => openEdit(view, node.nodeId),
        },
        {
            // 框架卡片这一项编辑的是它的**内容**（框架自身那行不出现、根可多个），
            // 与右栏空白处那条「批量编辑」是同一个入口
            name: '批量编辑',
            icon: ICON.batchEdit,
            section: SECTION.main,
            action: () => editFrameworkContentAsText(view, node.nodeId),
        },
        {
            name: '管理标签',
            icon: 'tags',
            section: SECTION.main,
            action: () => manageTags(view, node.nodeId),
        },
        ...templateDefs(view, node),
        {
            name: '归档框架',
            icon: ICON.archive,
            section: SECTION.danger,
            warning: true,
            action: () => archiveNode(view, node.nodeId),
        },
    ];
}

/**
 * 普通节点行右键：分四组 —— 结构 + 编辑 / 归属 · 命名 · 复制 · 打开 / 工具（模板、外部信息）/ 归档
 *
 * 组与组之间由装配器按 section 变化插分隔符，声明里不写分隔标记。
 * 归档独立成组：它是破坏性操作，单独隔一道线与上面的日常项分开，免得手滑点到。
 */
function getRowMenuDefinitions(
    view: DesignView,
    node: TreeNode,
    ctx: NodeLineCtx,
    side: TreeSide,
): MenuDefinitions {
    // 行内新建的统一落点：新建的那个挂到 ctx.parentId 下（这一行此刻所属的父）
    const addChild = (kind: NodeKindValue): void =>
        startCreateChild(view, ctx, side, [kind]);
    return [
        // ── 第一组 ──
        ...newChildDefs(view, node, ctx, side),
        ...expandDefs(view, node, side),
        ...evidenceSubmenuDefs(addChild, () => appendExistingInfo(view, node.nodeId)),
        {
            name: '重命名',
            icon: ICON.rename,
            section: SECTION.main,
            action: () => startRename(view, node.nodeId, side),
        },
        {
            name: '批量编辑',
            icon: ICON.batchEdit,
            section: SECTION.main,
            action: () => editSubtreeAsText(view, node.nodeId),
        },
        {
            name: '复制子树',
            icon: ICON.copyText,
            section: SECTION.main,
            action: () => void copySubtreeAsText(view, node.nodeId),
        },
        // 属性相关的四个动作收成一个子菜单（见 attributeGroupDefs）：它们都是
        // 「改这个节点的某个属性」，平铺会把第一组撑得很长
        ...attributeGroupDefs(view, node),

        // ── 第二组 ──
        ...templateGroupDefs(view, node),
        ...externalInfoDefs(view, node),
        {
            name: '打开文件',
            icon: ICON.openFile,
            section: SECTION.tools,
            action: () => void openNodeFile(view, node.nodeId),
        },

        // ── 第三组：断连 / 归档（都动归属或存留，靠上一道分隔线隔开）──
        // 「断连」是**证据类型专属**：只有证据会被引用到多处（多归属），结构节点该用
        // 「变更归属」移动、用「归档」下架，再给它们一个「只摘链、内容留下」的入口只会混淆。
        // 摘的是**这一行此刻所属的那个父**（ctx.parentId），不是查询得来的第一个上级 ——
        // 多归属时两者可能不是同一条链（见 showRowContextMenu 的说明）。
        ...(ctx.parentId && EVIDENCE_KINDS.includes(node.data.kind)
            ? [{
                name: '断连',
                icon: ICON.detach,
                section: SECTION.danger,
                action: () => detachFromParent(view, node.nodeId, ctx.parentId),
            }]
            : []),
        {
            name: '归档节点',
            icon: ICON.archive,
            section: SECTION.danger,
            warning: true,
            action: () => archiveNode(view, node.nodeId),
        },
    ];
}

/**
 * 属性更改组：归属 / 标签 / 时间 / 描述
 *
 * 四个动作都是「改这个节点的某个属性」，平铺进第一组会把菜单撑得很长；收成一个子菜单后，
 * 日常入口（结构、重命名、批量编辑）仍留在一眼可见的位置。子项不写 section ——
 * 组内不再分组（分隔符规则见 BUILD_Menu）。
 */
function attributeGroupDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    const nodeId = node.nodeId;
    return [
        {
            name: '属性更改',
            icon: ICON.editAttrs,
            section: SECTION.main,
            items: [
                {
                    name: '变更归属',
                    icon: ICON.changeParent,
                    action: () => changeParent(view, nodeId),
                },
                {
                    name: '管理标签',
                    icon: 'tags',
                    action: () => manageTags(view, nodeId),
                },
                {
                    name: '时间设置',
                    icon: ICON.editAttrs,
                    action: () => openEdit(view, nodeId),
                },
                {
                    name: '编辑正文',
                    icon: ICON.editDesc,
                    action: () => openBodyEdit(view, nodeId),
                },
            ],
        },
    ];
}

/** 模板组：两个模板动作用一个子菜单收拢，少占一行 */
function templateGroupDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    return [
        {
            name: '模板功能',
            icon: ICON.templateGroup,
            section: SECTION.tools,
            items: templateDefs(view, node),
        },
    ];
}

/** 外部信息组：挂一条外部链接、创建关联时间戳文档，或整理已有条目 */
function externalInfoDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    return [
        {
            name: '外部信息',
            icon: ICON.externalGroup,
            section: SECTION.tools,
            items: [
                {
                    name: '关联库内文件或 URL',
                    icon: ICON.externalGroup,
                    action: () => addExternalSource(view, node.nodeId),
                },
                {
                    name: '快速创建关联时间戳',
                    icon: 'file-plus',
                    action: () => void createTimestampDoc(view, node.nodeId, false),
                },
                {
                    name: '创建并打开关联时间戳',
                    icon: 'external-link',
                    action: () => void createTimestampDoc(view, node.nodeId, true),
                },
                {
                    name: '管理外部信息源',
                    icon: 'list-ordered',
                    action: () => manageExternalSources(view, node.nodeId),
                },
            ],
        },
    ];
}

/** 状态圆点右键：完整状态菜单（单击状态圆点本身是循环切换，不经过此菜单） */
function getStateMenuDefinitions(view: DesignView, node: TreeNode): MenuDefinitions {
    const current = node.data.state ?? 'plan';
    return [...STATE_VALUES].map((s) => ({
        name: NODE_STATE_LABELS[s],
        icon: STATE_ICON[s],
        checked: current === s,
        section: SECTION.main,
        action: () => setNodeState(view, node.nodeId, s),
    }));
}
