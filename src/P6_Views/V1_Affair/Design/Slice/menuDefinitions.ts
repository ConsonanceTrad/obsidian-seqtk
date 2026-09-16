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
 *   templateActions），本文件不直接写数据面
 * - 组与组之间由装配器按 section 变化插分隔符，声明里不写分隔标记
 *
 * 功能增补指引:
 * - 新增一个菜单项 → 找到对应的 getXxxMenuDefinitions 追加声明；新增一类菜单 →
 *   加一个 export function，并在 Design.ts 的 buildActions 里接线
 */

import { Notice } from 'obsidian';
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
import { changeParent, toggleExpandAll } from './navigation';
import { openBodyEdit, startCreateBlank, startCreateChild, startRename } from './inlineEdit';
import { addExternalSource, createTimestampDoc, manageExternalSources } from './externalInfo';
import { copySubtreeAsText, editFrameworkContentAsText, editSubtreeAsText } from './textEdit';
import { buildFrameworkNode, buildNode, type TreeNode } from '../Tool/tree';
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

/** 行右键：左栏用框架菜单；右栏框架行用右向框架菜单，其余用节点行菜单 */
export function showRowContextMenu(view: DesignView, nodeId: string, side: TreeSide, e: MouseEvent): void {
    const data = view.pipe.GET_Node(nodeId);
    if (!data) return;
    if (side === 'left') {
        BUILD_Menu(getFrameMenuDefinitions(view, buildFrameworkNode(view.pipe, nodeId, data), e, 'left'), e);
        return;
    }
    const node = buildNode(view.pipe, nodeId, data);
    if (isFrameworkKind(data.kind)) BUILD_Menu(getFrameMenuDefinitions(view, node, e, 'right'), e);
    else BUILD_Menu(getRowMenuDefinitions(view, node, e, 'right'), e);
}

// ============================================================
// 菜单声明：本文件只回答「长什么样、点了做什么」，装配交给 BUILD_Menu
// ============================================================

/** 行内交互上下文（层级取自行上的 data-depth：行内新建据此落到正确父级） */
function ctxFromEvent(e: MouseEvent, node: TreeNode): NodeLineCtx {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
    return {
        nodeId: node.nodeId,
        parentId: node.data.parent ?? '',
        depth: Number(row?.dataset.depth ?? '0'),
    };
}

/** 追加信息子菜单（对象 / 条件 / 信息 / 状态）：空白菜单与行菜单共用，只是落点不同 */
function evidenceSubmenuDefs(onPick: (kind: NodeKindValue) => void): MenuDefinition[] {
    return [
        {
            name: '追加信息',
            icon: ICON.evidence,
            section: SECTION.main,
            items: EVIDENCE_KINDS.map((kind) => ({
                name: NODE_KIND_LABELS[kind],
                icon: EVIDENCE_ICONS[kind],
                action: () => onPick(kind),
            })),
        },
    ];
}

/** 从磁盘刷新（左右栏空白菜单共用） */
async function syncFromFiles(view: DesignView): Promise<void> {
    if (!view.pipe.isInitialized) {
        new Notice('查询缓存尚未就绪，请稍候');
        return;
    }
    await view.pipe.SYNC_FromFiles();
    new Notice('已从磁盘刷新');
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

/** 行内追加子项：左栏是子框架；右栏按该行允许的子类型（目标固定为工序） */
function newChildDefs(view: DesignView, node: TreeNode, e: MouseEvent, side: TreeSide): MenuDefinition[] {
    const kind = node.data.kind;
    const kinds = side === 'left' ? [NODE_KIND.TRANS] : getAllowedChildKinds(kind);
    if (kinds.length === 0) return [];
    const allowed = kind === NODE_KIND.TARGET ? [NODE_KIND.PROCESS] : kinds;
    return [
        {
            name: side === 'right' ? '追加子项' : '追加子框架',
            icon: ICON.newChild,
            section: SECTION.main,
            action: () => startCreateChild(view, ctxFromEvent(e, node), side, allowed),
        },
    ];
}

/** 右栏框架行的行内新建入口（不开模态框） */
function rightCreateDefs(view: DesignView, node: TreeNode, e: MouseEvent): MenuDefinition[] {
    const create = (name: string, icon: string, kind: NodeKindValue): MenuDefinition => ({
        name,
        icon,
        section: SECTION.main,
        action: () => startCreateChild(view, ctxFromEvent(e, node), 'right', [kind]),
    });
    return [
        create('新建构思', ICON.newConcept, NODE_KIND.CONCEPT),
        create('新建清单', ICON.newCheck, NODE_KIND.CHECK),
        create('新建事件', ICON.newEvent, NODE_KIND.EVENT),
    ];
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
            action: () => void syncFromFiles(view),
        },
    ];
}

/** 右栏空白右键：新建三类 + 追加信息 + 批量编辑 + 从磁盘刷新 */
export function getRightBlankMenuDefinitions(view: DesignView): MenuDefinitions {
    const parentId = view.selectedFrameworkId ?? undefined;
    return [
        {
            name: '新建构思',
            icon: ICON.newConcept,
            section: SECTION.main,
            action: () => startCreateBlank(view, NODE_KIND.CONCEPT, 'right', parentId),
        },
        {
            name: '新建清单',
            icon: ICON.newCheck,
            section: SECTION.main,
            action: () => startCreateBlank(view, NODE_KIND.CHECK, 'right', parentId),
        },
        {
            name: '新建事件',
            icon: ICON.newEvent,
            section: SECTION.main,
            action: () => startCreateBlank(view, NODE_KIND.EVENT, 'right', parentId),
        },
        ...evidenceSubmenuDefs((kind) => startCreateBlank(view, kind, 'right', parentId)),
        // 根可多个（框架自身那行藏起来），应对框架内元素较多的情况
        ...(parentId
            ? [
                  {
                      name: '批量编辑',
                      icon: ICON.editFrameworkContent,
                      section: SECTION.framework,
                      action: () => editFrameworkContentAsText(view, parentId),
                  },
              ]
            : []),
        {
            name: '从磁盘刷新',
            icon: ICON.syncFromFiles,
            section: SECTION.refresh,
            action: () => void syncFromFiles(view),
        },
    ];
}

/**
 * 框架行右键：展开/收起 + 行内新建 + 重命名 + 时间规则 + 模板 + 归档
 *
 * 「追加子项」只在左栏出现（在那一栏它叫「追加子框架」）：右栏的框架卡片已经给了
 * 「新建构思 / 新建清单 / 新建事件」三个明确入口，再挂一条「按允许类型新建」的泛化项，
 * 只会让人在几个入口之间犹豫该点哪个。
 */
function getFrameMenuDefinitions(
    view: DesignView,
    node: TreeNode,
    e: MouseEvent,
    side: TreeSide,
): MenuDefinitions {
    const addEvidence = (kind: NodeKindValue): void =>
        startCreateChild(view, ctxFromEvent(e, node), side, [kind]);
    return [
        ...expandDefs(view, node, side),
        ...(side === 'left' ? newChildDefs(view, node, e, side) : []),
        ...(side === 'right' ? rightCreateDefs(view, node, e) : []),
        ...(side === 'right' ? evidenceSubmenuDefs(addEvidence) : []),
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
        ...templateDefs(view, node),
        {
            name: '归档',
            icon: ICON.archive,
            section: SECTION.danger,
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
    e: MouseEvent,
    side: TreeSide,
): MenuDefinitions {
    const addEvidence = (kind: NodeKindValue): void =>
        startCreateChild(view, ctxFromEvent(e, node), side, [kind]);
    return [
        // ── 第一组：结构 + 编辑 ──
        ...expandDefs(view, node, side),
        ...newChildDefs(view, node, e, side),
        ...evidenceSubmenuDefs(addEvidence),
        ...stateDefs(view, node),
        {
            name: '编辑描述',
            icon: ICON.editDesc,
            section: SECTION.main,
            action: () => openBodyEdit(view, node.nodeId),
        },
        {
            name: '时间规则',
            icon: ICON.editAttrs,
            section: SECTION.main,
            action: () => openEdit(view, node.nodeId),
        },
        {
            name: '批量编辑',
            icon: ICON.batchEdit,
            section: SECTION.main,
            action: () => editSubtreeAsText(view, node.nodeId),
        },

        // ── 第二组：归属 · 命名 · 复制 · 打开 ──
        {
            name: '变更归属',
            icon: ICON.changeParent,
            section: SECTION.meta,
            action: () => changeParent(view, node.nodeId),
        },
        {
            name: '重命名',
            icon: ICON.rename,
            section: SECTION.meta,
            action: () => startRename(view, node.nodeId, side),
        },
        {
            name: '复制子树',
            icon: ICON.copyText,
            section: SECTION.meta,
            action: () => void copySubtreeAsText(view, node.nodeId),
        },
        {
            name: '打开文件',
            icon: ICON.openFile,
            section: SECTION.meta,
            action: () => void openNodeFile(view, node.nodeId),
        },

        // ── 第三组：工具（模板与外部信息各收成一个子菜单）──
        ...templateGroupDefs(view, node),
        ...externalInfoDefs(view, node),

        // ── 第四组：归档（破坏性操作，靠上一道分隔线隔开）──
        {
            name: '归档',
            icon: ICON.archive,
            section: SECTION.danger,
            warning: true,
            action: () => archiveNode(view, node.nodeId),
        },
    ];
}

/** 模板组：两个模板动作用一个子菜单收拢，少占一行 */
function templateGroupDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    return [
        {
            name: '模板使用',
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
                    name: '添加外部信息源',
                    icon: ICON.externalGroup,
                    action: () => addExternalSource(view, node.nodeId),
                },
                {
                    name: '创建关联时间戳',
                    icon: 'file-plus',
                    action: () => void createTimestampDoc(view, node.nodeId),
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

/** 状态更改子菜单：每态一个图标 + 当前状态打勾（该类型不带状态时整项不出） */
function stateDefs(view: DesignView, node: TreeNode): MenuDefinition[] {
    if (!kindUsesState(node.data.kind)) return [];
    const current = node.data.state ?? 'plan';
    return [
        {
            name: '状态更改',
            icon: ICON.changeState,
            section: SECTION.main,
            items: [...STATE_VALUES].map((s) => ({
                name: NODE_STATE_LABELS[s],
                icon: STATE_ICON[s],
                checked: current === s,
                action: () => setNodeState(view, node.nodeId, s),
            })),
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
