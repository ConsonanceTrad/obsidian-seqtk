/**
 * TemplateView — 模板模式（模板库管理视图 · 装配壳）
 *
 * 本类只做五件事（见 P6_Views/Views.md「视图的职责边界」）：
 * 装配 / 注册 / 微调 / 数据注入 / 交互转发；其余按功能切片放在 `Template/Slice/`：
 *   Slice/templateModel.ts   数据 → 视图模型（左栏模板框架树）
 *   Slice/templateText.ts    右栏文本区：导出 / 校验预览 / 回写
 *   Slice/templateActions.ts 新建 / 删除 / 打开正文
 *   Slice/templateApply.ts   把模板内容插进目标框架
 *
 * 布局：左栏 = 模板框架树（与事务设计左栏同一个树组件），只负责「选哪个框架 / 增删框架」；
 * 右栏 = 选中框架的内容，**直接用文本表示** —— 对框架内容做解析预览、合法性校验，再按差异
 * 回写。内容的增删改一律在文本里进行，不再另画一棵单元树。
 *
 * 模板语义：模板单元 = 模板框架（framework-template）的 follows 直属子树，desc / body 里的
 * `{{框架名}}`、`{{父.字段}}`、`{{变量:提示|默认值}}` 在插入时求值（语法与求值见
 * P2_Tools/Parse/TempParse.ts）。
 *
 * 两个 store 分开：结构态（树 / 选中）与文本区态（正在编辑的文本）——
 * 按键只刷后者，左栏树不跟着每帧重渲。
 */

import { createElement, type ReactNode } from "react";
import { Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import { PARSE_TextTree } from "../../../../P2_Tools/Parse/TextTree";
import { TransactionCreateModal } from "../../../../P7_Render/Structure/S2_Modal/TransactionModals";
import { BUILD_Menu, type MenuDefinition } from "../../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition";
import {
    TemplatePanel,
    type TemplateActions,
    type TemplateState,
    type TemplateTextState,
} from "./TemplatePanel";
import { BUILD_TemplateLeftItems } from "../Slice/templateModel";
import {
    APPLY_TemplateFrameworkText,
    CHECK_TemplateFrameworkText,
    EXPORT_TemplateFrameworkText,
} from "../Slice/templateText";
import {
    CREATE_TemplateNode,
    DELETE_TemplateTree,
    OPEN_NodeFile,
} from "../Slice/templateActions";
import { APPLY_Template } from "../Slice/templateApply";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../../../P3_Settings/Settings";
import type { NodeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";

export const VIEW_TYPE_TEMPLATE = 'seqtk-template';

/** 文本区空态（未选框架 / 缓存未就绪） */
const EMPTY_TEXT_STATE: TemplateTextState = {
    frameworkId: null,
    value: '',
    baseline: '',
    issues: [],
    preview: [],
    notice: [],
    rootCount: 0,
    canApply: false,
};

@AutoView()
@AutoRegister()
export class TemplateView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_TEMPLATE, title: '模板模式', icon: 'copy', description: '模板库管理：左栏模板框架树负责选框架与增删，右栏以文本直接编辑选中框架的内容（实时解析预览与合法性校验）；创建模板在事务设计右键「存为模板」。', category: '事务设计'},
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

    /** 视图容器附加类（基座 addClass 用） */
    protected cssClass = 'seqtk-template-view';

    /** 结构态：左栏框架树 / 选中（渲染件经 useStore 订阅） */
    private readonly stateStore = new SimpleStore<TemplateState>({
        initializing: true,
        leftItems: [],
        selectedId: null,
    });

    /** 文本区态：正在编辑的文本与它的预览 / 校验（与结构态分开，按键只刷这一份） */
    private readonly textStore = new SimpleStore<TemplateTextState>(EMPTY_TEXT_STATE);

    /** 左栏展开集合（模板框架树） */
    private readonly expandedLeft = new Set<string>();

    /** 当前选中的模板框架 nodeId（null = 未选）；切片协作可见 */
    public selectedFrameworkId: string | null = null;
    /**
     * 文本区正在编辑的内容（null = 未改动，显示该框架的导出结果）；
     * 切片协作可见（回写后由本类置回 null）
     */
    public textDraft: string | null = null;

    private unsub: (() => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口（读写与订阅一律经它） */
        public pipe: DataPipe,
        /** 打开模板框架正文时按它算文件路径（GET_FileByPath） */
        public settings: PluginSettings,
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

    /** 渲染件在 TemplatePanel.tsx：视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(TemplatePanel, {
            state: this.stateStore,
            text: this.textStore,
            actions: this.buildActions(),
            host: { setTooltip, setIcon },
        });
    }

    protected onMounted(): void {
        this.unsub = this.pipe.SUB_ActiveView(() => this.refresh());
        this.refresh();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
    }

    // ============================================================
    // 数据注入：状态重建
    // ============================================================

    /** 重建结构态与文本区（数据变化 / 选中变化 / 展开变化后调用） */
    public refresh(): void {
        this.collapseSelectionIfGone();

        // 先取 id 再查节点：右栏要的是「框架 id」，而 SeqtkNode 上并没有 nodeId 字段；
        // 顺带保证整段用的是同一个选中快照（collapseSelectionIfGone 刚清过已消失的选中）
        const frameworkId = this.selectedFrameworkId;
        const current = frameworkId ? this.pipe.GET_Node(frameworkId) : undefined;
        this.stateStore.set({
            initializing: !this.pipe.isInitialized,
            leftItems: BUILD_TemplateLeftItems(this.pipe, this.expandedLeft, frameworkId),
            leftEmpty: !this.pipe.isInitialized
                ? '正在加载缓存…'
                : this.pipe.GET_ByKind(NODE_KIND.TEMP).length === 0
                    ? '暂无模板框架：点标题栏「新建」，或先在事务设计里「存为模板」'
                    : undefined,
            selectedId: frameworkId,
            rightTitle: current ? `${NODE_KIND_LABELS[current.kind]} · ${current.desc}` : undefined,
        });
        this.refreshText();
    }

    /**
     * 重算文本区（按键与数据变化都走这里，只刷 textStore）
     *
     * 基线是「此刻框架内容导出成的文本」；编辑值优先取 textDraft —— 于是缓存刷新
     * （别处改了模板内容）时，未改动的文本区自动跟上，已改动的保留草稿。
     */
    public refreshText(): void {
        const frameworkId = this.selectedFrameworkId;
        if (!frameworkId) {
            this.textStore.set(EMPTY_TEXT_STATE);
            return;
        }
        const baseline = EXPORT_TemplateFrameworkText(this.pipe, frameworkId);
        const value = this.textDraft ?? baseline;
        const check = CHECK_TemplateFrameworkText(this.pipe, frameworkId, value);
        this.textStore.set({
            frameworkId,
            value,
            baseline,
            issues: check.issues,
            preview: check.preview,
            notice: check.notice,
            rootCount: check.rootCount,
            canApply: check.canApply && value !== baseline,
        });
    }

    /**
     * 选中的框架若已不存在（别处删了），清掉选中与草稿
     *
     * 切片协作可见：templateActions.DELETE_TemplateTree 删到当前选中时也会调用（幂等）。
     */
    public collapseSelectionIfGone(): void {
        if (this.selectedFrameworkId && !this.pipe.GET_Node(this.selectedFrameworkId)) {
            this.selectedFrameworkId = null;
            this.textDraft = null;
        }
    }

    // ============================================================
    // 交互数据传递：TemplateActions 的实现（逐项转发到切片）
    // ============================================================

    private buildActions(): TemplateActions {
        return {
            toggle: (nodeId) => {
                if (this.expandedLeft.has(nodeId)) this.expandedLeft.delete(nodeId);
                else this.expandedLeft.add(nodeId);
                this.refresh();
            },
            select: (nodeId) => {
                this.selectedFrameworkId = nodeId;
                // 换框架：文本区回到新框架的导出结果（草稿属于上一个框架）
                this.textDraft = null;
                this.refresh();
            },
            contextMenu: (nodeId, e) => this.showRowMenu(nodeId, e),
            createRootFramework: () => this.openCreate([NODE_KIND.TEMP]),
            applyTemplate: (nodeId) => APPLY_Template(this, nodeId),
            deleteNode: (nodeId) => DELETE_TemplateTree(this, nodeId),
            openFile: (nodeId) => OPEN_NodeFile(this, nodeId),
            textChange: (value) => {
                this.textDraft = value;
                this.refreshText();
            },
            textCommit: () => void this.commitText(),
            textReset: () => {
                this.textDraft = null;
                this.refreshText();
            },
        };
    }

    /**
     * 框架行右键菜单
     *
     * 只针对模板框架本身 —— 模板内容不在这棵树上管理（内容 = 右栏的文本），所以菜单里
     * 没有「新建单元」这类内容级动作；「应用此模板到框架…」把整个框架的内容插进目标框架。
     */
    private showRowMenu(nodeId: string, event: MouseEvent): void {
        const defs: MenuDefinition[] = [
            {
                name: '应用此模板到框架…',
                icon: 'paste',
                section: 'use',
                action: () => APPLY_Template(this, nodeId),
            },
            {
                name: '打开正文',
                icon: 'file-text',
                section: 'use',
                action: () => OPEN_NodeFile(this, nodeId),
            },
            {
                name: '新建子模板框架',
                icon: 'folder-plus',
                section: 'new',
                action: () => this.openCreate([NODE_KIND.TEMP], nodeId),
            },
            {
                name: '删除此模板框架（含内容）',
                icon: 'trash-2',
                section: 'danger',
                warning: true,
                action: () => DELETE_TemplateTree(this, nodeId),
            },
        ];
        BUILD_Menu(defs, event);
    }

    /** 新建节点弹窗（kinds 为候选类型；parentId 缺省 = 建为根级框架） */
    private openCreate(kinds: NodeKindValue[], parentId?: string): void {
        new TransactionCreateModal(this.app, {
            kinds,
            onSubmit: (input) => void CREATE_TemplateNode(this, input, parentId),
        }).open();
    }

    /**
     * 文本区回写：解析 → 按「同层同位置」对齐回写（与设计视图的框架内容编辑同一条路径）
     *
     * 回写后清掉草稿：基线随数据更新，文本区自动显示回写后的结果，不会停在旧文本上。
     */
    private async commitText(): Promise<void> {
        const frameworkId = this.selectedFrameworkId;
        if (!frameworkId || this.textDraft === null) return;

        const { roots, issues } = PARSE_TextTree(this.textDraft);
        if (issues.length > 0) {
            new Notice('文本仍有解析问题，未回写（问题已列在文本区下方）');
            return;
        }
        const result = await APPLY_TemplateFrameworkText(this.pipe, frameworkId, roots);
        if (result.error) {
            new Notice(`回写中断：已更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}；失败：${result.error}`);
            return;
        }
        new Notice(`已回写：更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}`);
        this.textDraft = null;
        this.refresh();
    }
}
