/**
 * TemplateView — 模板模式（模板库管理视图）
 *
 * 双栏布局：
 * - 左栏：模板框架列表
 * - 右栏：选中模板框架 → 管理模板单元
 *   - 工具栏：新建模板单元 / 新建子模板框架
 *   - 模板单元树（可含子树）递归展示；顶层单元提供 应用 / 编辑 / 删除（级联子树）
 *
 * 模板语义：
 * - 模板单元 = 模板框架（NODE_KIND.TEMP）的 follows 直属子树（普通节点承载），
 *   desc/body 可含 {{框架名}} 占位，应用时替换为被使用框架的名称；
 * - 创建模板的主入口已并入事务设计右键「存为模板」，本视图聚焦模板库整理与管理。
 *
 * 逻辑与渲染分离：本文件只负责注册、数据读取、状态重算与操作，渲染在 TemplatePanel.tsx。
 * 数据流：pipe.SUB_ActiveView → 本类(重算+扁平化) → SimpleStore<TemplateState> → Panel(useStore)
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：读写一律经 **DataPipe**，不再直连
 * nodeCache / fileManager / operationQueue。
 */

import { createElement, type ReactNode } from "react";
import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { GET_AllowedChildKinds } from "../../P4_Nodes/NodeKind/NodeChildAllow";
import { cloneSubtree, TEMPLATE_FRAMEWORK_NAME_TOKEN } from "../../P2_Tools/Parse/TempParse";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { SelectFrameworkModal } from "../../P7_Render/Structure/S2_Modal/TemplateModals";
import { TransactionCreateModal } from "../../P7_Render/Structure/S2_Modal/TransactionModals";
import { TemplatePanel, type TemplateFrameworkRow, type TemplateState, type TemplateUnitRow } from "./TemplatePanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../P3_Settings/Settings";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../P4_Nodes/Node";
import type { SeqtkState } from "../../P4_Nodes/NodeField/StateKeys";

export const VIEW_TYPE_TEMPLATE = 'seqtk-template';

/** 新建模板单元时可选的节点类型 */
const UNIT_KINDS: NodeKindValue[] = [
    NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.ITEM, NODE_KIND.EVENT,
    NODE_KIND.FACTOR, NODE_KIND.REQUEST, NODE_KIND.CLUE, NODE_KIND.SNAPSHOT,
];

@AutoView()
@AutoRegister()
export class TemplateView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_TEMPLATE, title: '模板模式', icon: 'copy', description: '模板库管理：整理模板单元（含子树结构）、编辑占位并应用到目标框架；创建模板请在事务设计右键「存为模板」。', category: '事务设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): TemplateView {
        return new TemplateView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-template',
            name: '打开模板模式',
            callback: () => plugin.activateView(VIEW_TYPE_TEMPLATE),
        });
    }

    /** 渲染件订阅的唯一状态源（由本类重算后写入） */
    private readonly state = new SimpleStore<TemplateState>({
        initializing: true,
        frameworks: [],
        selectedId: null,
        selectedDesc: '',
        subFrameworks: [],
        unitRows: [],
    });

    private unsub: (() => void) | null = null;
    /** 当前选中的框架 nodeId（模板框架） */
    private selectedId: string | null = null;
    /** 右栏模板单元树展开状态（nodeId 集合） */
    private readonly expandedUnitIds = new Set<string>();

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口 */
        private pipe: DataPipe,
        private settings: PluginSettings,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_TEMPLATE;
    }

    getDisplayText(): string {
        return '模板模式';
    }

    getIcon(): string {
        return 'copy';
    }

    /** 渲染件在 TemplatePanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(TemplatePanel, {
            state: this.state,
            onSelect: (nodeId: string) => { this.selectedId = nodeId; this.recompute(); },
            onToggleExpand: (nodeId: string) => {
                if (this.expandedUnitIds.has(nodeId)) this.expandedUnitIds.delete(nodeId);
                else this.expandedUnitIds.add(nodeId);
                this.recompute();
            },
            onCollapseAll: () => { this.expandedUnitIds.clear(); this.recompute(); },
            onCreateUnit: () => this.openCreateTemplateUnit(),
            onCreateSubFramework: () => this.openCreate(NODE_KIND.TEMP),
            onCreateRootTemplate: () => this.openCreateRootTemplate(),
            onApply: (nodeId: string) => this.applyTemplate(nodeId),
            onOpenFile: (nodeId: string) => this.openNodeFile(nodeId),
            onDelete: (nodeId: string) => this.deleteTemplateTree(nodeId),
        });
    }

    protected onMounted(): void {
        this.unsub = this.pipe.SUB_ActiveView(() => this.recompute());
        this.recompute();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
    }

    // ============================================================
    // 状态重算（数据 → 视图状态）
    // ============================================================

    private recompute(): void {
        const frameworks: TemplateFrameworkRow[] = this.pipe
            .GET_ByKind(NODE_KIND.TEMP)
            .map(({ nodeId, data }) => ({ nodeId, desc: data.desc, kindLabel: NODE_KIND_LABELS[data.kind] }));

        const next: TemplateState = {
            initializing: !this.pipe.isInitialized,
            frameworks,
            selectedId: this.selectedId,
            selectedDesc: '',
            subFrameworks: [],
            unitRows: [],
        };

        if (this.selectedId !== null) {
            const node = this.pipe.GET_Node(this.selectedId);
            if (!node) {
                this.selectedId = null;
                next.selectedId = null;
            } else {
                next.selectedDesc = node.desc;

                const children = this.pipe
                    .GET_Children(this.selectedId)
                    .filter((c): c is { kind: NodeKindValue; nodeId: string; data: SeqtkNode } => !!c.data);

                next.subFrameworks = children
                    .filter((c) => c.data.kind === NODE_KIND.TEMP)
                    .map((c) => ({ nodeId: c.nodeId, desc: c.data.desc, kindLabel: NODE_KIND_LABELS[c.data.kind] }));

                if (children.length === 0) {
                    next.rightEmpty = '暂无模板单元：可在事务设计右键「存为模板」，或点击「新建模板单元」创建';
                }

                for (const unit of children.filter((c) => c.data.kind !== NODE_KIND.TEMP)) {
                    this.flattenUnit(unit.nodeId, unit.data, 0, true, next.unitRows);
                }
            }
        }

        this.state.set(next);
    }

    /**
     * 把模板单元子树按展开状态扁平化（顶层 + 已展开的后代）。
     * 树形由 depth 表达，渲染件只负责缩进 —— Panel 因此不必理解节点关系。
     */
    private flattenUnit(
        nodeId: string,
        data: SeqtkNode,
        depth: number,
        isTop: boolean,
        out: TemplateUnitRow[],
    ): void {
        const children = this.pipe.GET_Children(nodeId).filter((c) => !!c.data);
        const expanded = this.expandedUnitIds.has(nodeId);

        out.push({
            nodeId,
            kindLabel: NODE_KIND_LABELS[data.kind],
            desc: data.desc,
            depth,
            hasChildren: children.length > 0,
            expanded,
            isTop,
        });

        if (expanded) {
            for (const child of children) {
                if (child.data) this.flattenUnit(child.nodeId, child.data, depth + 1, false, out);
            }
        }
    }

    // ============================================================
    // 模板应用
    // ============================================================

    /**
     * 应用：将模板单元整棵子树克隆到目标框架（{{框架名}} 按目标框架名替换）。
     * 顶层 kind 须为目标框架允许的类型（规则与事务设计一致）。
     */
    private applyTemplate(templateId: string): void {
        const template = this.pipe.GET_Node(templateId);
        if (!template) return;

        const frameworks = [
            ...this.pipe.GET_ByKind(NODE_KIND.TRANS),
            ...this.pipe.GET_ByKind(NODE_KIND.INFO),
        ];
        if (frameworks.length === 0) {
            new Notice('请先创建目标框架（事务框架 / 信息框架）');
            return;
        }

        new SelectFrameworkModal(this.app, {
            title: '应用模板到框架',
            frameworks: frameworks.map((f) => ({ nodeId: f.nodeId, label: f.data.desc })),
            onSelect: (targetId) => {
                const target = this.pipe.GET_Node(targetId);
                if (!target) return;
                if (!GET_AllowedChildKinds(target.kind).includes(template.kind)) {
                    new Notice(`该模板顶层类型「${NODE_KIND_LABELS[template.kind]}」不能插入此框架`);
                    return;
                }
                void this.applyTemplateTo(targetId, target.desc, templateId);
            },
        }).open();
    }

    /** 递归克隆模板单元整棵子树到目标框架（供 applyTemplate 调用） */
    private async applyTemplateTo(targetId: string, targetDesc: string, templateId: string): Promise<void> {
        const rootId = await cloneSubtree({
            sourceId: templateId,
            parentId: targetId,
            pipe: this.pipe,
            resolveText: (text) => text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(targetDesc),
        });
        if (rootId) new Notice('模板已应用');
        else new Notice('应用模板失败');
    }

    // ============================================================
    // 通用操作
    // ============================================================

    /** 新建模板单元（类型可选，父节点 = 当前选中的模板框架） */
    private openCreateTemplateUnit(): void {
        const parentId = this.selectedId;
        if (!parentId) return;
        new TransactionCreateModal(this.app, {
            kinds: UNIT_KINDS,
            onSubmit: (input) => void this.createNode(input, parentId),
        }).open();
    }

    private openCreate(fixedKind: NodeKindValue): void {
        const parentId = this.selectedId;
        if (!parentId) return;
        new TransactionCreateModal(this.app, {
            kinds: [fixedKind],
            onSubmit: (input) => void this.createNode(input, parentId),
        }).open();
    }

    /** 新建根级模板框架（无父节点；模板框架的首次创建入口） */
    private openCreateRootTemplate(): void {
        new TransactionCreateModal(this.app, {
            kinds: [NODE_KIND.TEMP],
            onSubmit: (input) => void this.createNode(input),
        }).open();
    }

    /** 创建节点（parentId 提供时挂到该父框架下，双向维护 follows + parent） */
    private async createNode(
        input: { kind: NodeKindValue; desc: string; state: SeqtkState },
        parentId?: string,
    ): Promise<void> {
        if (!this.pipe.isInitialized) {
            new Notice('查询缓存尚未就绪，请稍候');
            return;
        }
        const now = new Date().toISOString();
        const data = {
            kind: input.kind,
            desc: input.desc,
            open: true,
            create: now,
            modify: now,
            ...(parentId ? { parent: parentId } : {}),
        } as SeqtkNode;

        try {
            // 文件先行 + 父 follows 双向维护 + 缓存写入，统一由 EXEC_Create 承担
            await this.pipe.EXEC_Create({ kind: input.kind, data, parentId: parentId || undefined });
        } catch (err) {
            console.error('[SeqTK] 创建节点失败:', err);
            new Notice(`[SeqTK] 创建节点失败: ${err}`);
        }
    }

    /** 打开节点文件编辑（模板单元正文编辑） */
    private openNodeFile(nodeId: string): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        const filePath = GET_FileByPath(node.kind, nodeId, this.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file instanceof TFile) {
            void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
        }
    }

    /** 级联删除模板单元：移除整棵子树缓存与文件（顶层为「存为模板」存入的单元入口） */
    private deleteTemplateTree(nodeId: string): void {
        const root = this.pipe.GET_Node(nodeId);
        if (!root) return;

        // 文件侧逐个删除；缓存侧走**单次** REMOVE_NodeTree
        //（同时清理 active + archive 两库后代，且只刷一次快照 —— 子树可能含已归档后代）
        const targets = [
            ...this.pipe.COLLECT_Descendants(nodeId).map((d) => ({ kind: d.kind, nodeId: d.nodeId })),
            { kind: root.kind, nodeId },
        ];
        this.pipe.EXEC_RemoveTree(nodeId, targets);
        new Notice(`模板单元已删除（含 ${targets.length} 个节点）`);
    }
}
