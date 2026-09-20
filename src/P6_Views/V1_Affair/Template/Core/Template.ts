/**
 * TemplateView — 模板模式（模板库管理视图 · 装配壳）
 *
 * 本类只做五件事（见 P6_Views/Views.md「视图的职责边界」）：
 * 装配 / 注册 / 微调 / 数据注入 / 交互转发；其余按功能切片放在 `Template/Slice/`：
 *   Slice/templateModel.ts     数据 → 视图模型（左栏模板框架树）
 *   Slice/templateText.ts      右栏文本区：导出 / 校验预览 / 回写
 *   Slice/templateActions.ts   删除 / 打开正文
 *   Slice/templateApply.ts     把模板内容插进目标框架
 *   Slice/TemplateTreeShared.ts 左栏共享状态（与委托面板同源）
 *   Slice/templateDelegate.ts  模板来源的委托描述（委托到侧栏时按它渲染）
 *
 * 布局：左栏 = 模板框架树（与事务设计左栏同一个树组件），只负责「选哪个框架 / 增删框架」，
 * 并且**与事务设计同法可以委托到侧栏**（委托出去的就是这棵模板框架树）；
 * 右栏 = 选中框架的内容，**直接用文本表示** —— 对框架内容做解析预览、合法性校验，再按差异
 * 回写。内容的增删改一律在文本里进行，不再另画一棵单元树。
 *
 * 左栏的增删与命名**与事务设计同法**：行内新建（附加行，含连续输入）与行内重命名，
 * 都转发给 `design/inlineEdit` —— 与设计视图、委托面板是同一份实现，没有弹窗新建。
 *
 * 模板语义：模板单元 = 模板框架（framework-template）的 follows 直属子树，desc / body 里的
 * `{{frame}}`、`{{p.字段}}`、`{{变量名:提示|默认值}}` 在插入时求值（语法与求值见
 * P2_Tools/Parse/TempParse.ts）。
 *
 * 两个 store 分开：结构态（树 / 选中 / 委托 / 行内编辑态）与文本区态（正在编辑的文本）——
 * 按键只刷后者，左栏树不跟着每帧重渲。
 */

import { createElement, type ReactNode } from "react";
import { Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { Save_Setting } from "../../../../P3_Settings/Settings";
import { NODE_KIND } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import { PARSE_TextTree, TOGGLE_TextTreeState } from "../../../../P2_Tools/Parse/TextTree";
import { BUILD_Menu, type MenuDefinition } from "../../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition";
import { ICON, SECTION } from "../../../../P7_Render/Composition/C3_RightClickMenu/MenuAppearance";
import { HAS_TemplateUnits, IS_TemplateContainer } from "../../../../P7_Render/Structure/S2_Modal/TemplateModals";
import {
    TemplatePanel,
    type TemplateActions,
    type TemplateState,
    type TemplateTextState,
} from "./TemplatePanel";
import { BUILD_TemplateLeftItems, EMPTY_TemplateTreeText } from "../Slice/templateModel";
import { TEMPLATE_TREE } from "../Slice/TemplateTreeShared";
import {
    APPLY_TemplateFrameworkText,
    CHECK_TemplateFrameworkText,
    EXPORT_TemplateFrameworkText,
} from "../Slice/templateText";
import { OPEN_NodeFile } from "../Slice/templateActions";
import { archiveNode } from "../../Design/Slice/actions";
import { APPLY_Template } from "../Slice/templateApply";
// 模板来源的委托描述：该模块顶层把自己注册给委托登记处，少了它
// `DELEGATE.delegate('template')` 会找不到来源（委托按钮点了没反应）。
// 这里具名导入是为了拿到实例、在挂载时告知本视图的 viewType（见 DelegateSource.viewType）
import { TEMPLATE_DELEGATE } from "../Slice/templateDelegate";
import {
    cancelCreate,
    cancelRename,
    commitCreate,
    commitRename,
    setCreateKind,
    setCreateRepeat,
    startCreateBlank,
    startCreateChild,
    startRename,
    type InlineEditView,
} from "../../Design/Slice/inlineEdit";
import { SYNC_FromFiles } from "../../../V0_Common/SyncFromFiles";
import { DELEGATE } from "../../../Special/Delegate/DelegateRegistry";
import { START_Delegate } from "../../../Special/Delegate/delegateTargets";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../../../P3_Settings/Settings";
import type { NodeLineCtx } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import type { DesignInlineCreating, TreeSide } from "../../Design/Core/DesignPanel";

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
    conflict: 'append',
};

/** 左栏宽度范围（px）与默认值 —— 与 DesignPanel 同一口径，两个视图间切换时栏宽不跳 */
const LEFT_WIDTH_MIN = 160;
const LEFT_WIDTH_MAX = 640;
const LEFT_WIDTH_DEFAULT = 280;
/** 设置写回的防抖等待（拖动结束与连续展开不必每帧落盘） */
const PERSIST_DEBOUNCE_MS = 600;

/**
 * 行内新建要的落点上下文
 *
 * 层级取自行上的 data-depth（与设计视图 menuDefinitions 的 ctxFromEvent 同一套判据：
 * 附加行的缩进靠它对齐）；parentId 不在 `startCreateChild` 的用武之地，留空即可。
 */
function CTX_FromRowEvent(event: MouseEvent, nodeId: string): NodeLineCtx {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.seqtk-frame-item');
    return { nodeId, parentId: '', depth: Number(row?.dataset.depth ?? '0') };
}

@AutoView()
@AutoRegister()
export class TemplateView extends ReactViewBase implements InlineEditView {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {
            viewType: VIEW_TYPE_TEMPLATE,
            title: '模板模式',
            icon: 'copy',
            description: '模板库管理，供解析与复用的节点结构。',
            category: '事务设计'
        },
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): TemplateView {
        return new TemplateView(
            leaf,
            plugin.allDeps.dataPipe,
            plugin.allDeps.settings,
            // 常规写盘回调：视图类不直接依赖插件实例
            () => void Save_Setting(plugin),
        );
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

    /** 结构态：左栏框架树 / 选中 / 委托 / 行内编辑态（渲染件经 useStore 订阅） */
    private readonly stateStore = new SimpleStore<TemplateState>({
        initializing: true,
        leftItems: [],
        selectedId: null,
        delegated: false,
        leftPaneWidth: LEFT_WIDTH_DEFAULT,
        creating: null,
        renameId: null,
    });

    /** 文本区态：正在编辑的文本与它的预览 / 校验（与结构态分开，按键只刷这一份） */
    private readonly textStore = new SimpleStore<TemplateTextState>(EMPTY_TEXT_STATE);

    /**
     * 左栏展开集合 —— 指向共享状态源（见 Slice/TemplateTreeShared）。
     * 左栏可被「委托」到侧栏显示，两处必须同源，故不放视图实例；
     * 这里保持 `view.expandedLeft` 的既有写法不变。
     */
    public expandedLeft = TEMPLATE_TREE.expanded;

    /**
     * 行内编辑态（InlineEditView 契约，见 design/inlineEdit）
     *
     * 与设计视图、委托面板共用同一套「附加行 / 行内重命名」实现：本类只持有这两个状态，
     * 进入与提交都走那套切片。
     */
    public creating: DesignInlineCreating | null = null;
    public rename: { nodeId: string; side: TreeSide } | null = null;
    /** 写盘期间压掉重绘（见 design/inlineEdit 的 commitCreate） */
    public suppressRefresh = false;
    /** 本视图只有左栏一棵树：满足 NodeEditHost 的占位集合 */
    private readonly rightExpanded = new Set<string>();

    /** 当前选中的模板框架 nodeId（null = 未选）；与委托面板共享，转发到共享状态 */
    public get selectedFrameworkId(): string | null {
        return TEMPLATE_TREE.selectedId;
    }

    public set selectedFrameworkId(v: string | null) {
        TEMPLATE_TREE.selectedId = v;
    }

    /**
     * 文本区正在编辑的内容（null = 未改动，显示该框架的导出结果）；
     * 切片协作可见（回写后由本类置回 null）
     */
    public textDraft: string | null = null;

    /** 左栏宽度（记忆于 settings.templateLeftPaneWidth；拖动结束后才写回）；切片协作可见 */
    public leftWidth = LEFT_WIDTH_DEFAULT;
    /** 设置写回的防抖计时器；切片协作可见 */
    public persistTimer: number | null = null;

    private unsub: (() => void) | null = null;
    private unsubShared: (() => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口（读写与订阅一律经它） */
        public pipe: DataPipe,
        /** 打开模板框架正文时按它算文件路径（GET_FileByPath） */
        public settings: PluginSettings,
        /** 把设置写回磁盘（由装配层注入，视图类不直接依赖插件实例） */
        public persistSettings?: () => void,
    ) {
        super(leaf);
        this.leftWidth = this.settings.templateLeftPaneWidth || LEFT_WIDTH_DEFAULT;
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

    // ── NodeEditHost：让 design/actions 与 design/inlineEdit 的动作能直接复用 ──

    /** 模板模式没有右栏树，但 NodeEditHost 要求成对给出（新建一律按左栏展开） */
    get expandedRight(): Set<string> {
        return this.rightExpanded;
    }

    /** 两栏重绘在本视图是同一件事：重建结构态与文本区 */
    renderLeft(): void {
        this.refresh();
    }

    renderRight(): void {
        this.refresh();
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
        // 恢复上次的打开位置：选中的模板框架、左栏展开集合（左栏宽度在构造里已恢复）。
        // 与设计视图同一套做法 —— 位置是会话状态，重开库应回到关库前看到的地方
        // 共享源里已有选中时不覆盖 —— 同 Design.ts 该处的说明（从委托面板跳过来时会用到）
        if (!TEMPLATE_TREE.selectedId && this.settings.templateSelectedId) {
            TEMPLATE_TREE.selectedId = this.settings.templateSelectedId;
        }
        this.expandedLeft.clear();
        for (const id of this.settings.templateExpandedIds ?? []) this.expandedLeft.add(id);
        // 「上次的委托意图」交给共享状态源：启动瞬间登记处还是空的，只看它左栏会先按
        // 未委托铺出来、随后才跳到委托态（详见 TemplateTreeShared 的说明）。
        // 必须在 refresh 之前 —— 首次算视图状态时就要用上。
        // `!settled` 不可省：恢复一旦落定，settings 里那个来源已属历史，再拿它当意图
        // 会把已经取消的委托又假装成待恢复（见 DELEGATE.settled）
        TEMPLATE_TREE.SET_PendingDelegated(
            this.settings.delegatedOwner === 'template' && !DELEGATE.settled,
        );
        // 告知模板来源「本视图是哪个 viewType」：委托面板里点行末的「在右侧打开」
        // 靠它把焦点移回本视图（见 DelegateSource.viewType 与 REVEAL_SourceView）
        TEMPLATE_DELEGATE.viewType = VIEW_TYPE_TEMPLATE;
        // 共享状态（展开 / 选中 / 委托）变化 → 重刷：委托期间左栏与把手要收起来，
        // 从委托面板那侧取消委托时本视图也必须跟着回来。顺带把意图重新同步一次 ——
        // 共享状态变化也可能是 main 作废了上次的委托意图；同样只在尚未落定时同步
        this.unsubShared = TEMPLATE_TREE.store.subscribe(() => {
            TEMPLATE_TREE.SET_PendingDelegated(
                this.settings.delegatedOwner === 'template' && !DELEGATE.settled,
            );
            this.refresh();
        });
        this.refresh();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubShared?.();
        this.unsubShared = null;
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
            this.persistTimer = null;
            this.persistNow();             // 关闭视图前把最后一次宽度变更落盘
        }
    }

    // ============================================================
    // 会话状态落盘（左栏宽度 / 打开位置）
    // ============================================================

    /**
     * 立即把会话状态写回设置（不防抖）
     *
     * 「打开位置」= 左栏宽度 + 选中的模板框架 + 左栏展开集合，三项一起记，
     * 重开库时才能回到关库前看到的地方（与设计视图的 persistNow 同一套口径）。
     */
    public persistNow(): void {
        this.settings.templateLeftPaneWidth = this.leftWidth;
        this.settings.templateSelectedId = TEMPLATE_TREE.selectedId;
        this.settings.templateExpandedIds = [...this.expandedLeft];
        this.persistSettings?.();
    }

    /**
     * 把会话状态立即落盘（供插件卸载时调用）
     *
     * 与设计视图的 FLUSH_Session 同名同义：写回有 600ms 防抖，而关库时 Obsidian 直接
     * 卸载插件，onBeforeUnmount 未必会被调用，最后一次变更就会丢。
     */
    public FLUSH_Session(): void {
        this.persistNow();
    }

    /** 防抖写回：拖动结束与连续操作不会频繁落盘 */
    private schedulePersist(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            this.persistNow();
        }, PERSIST_DEBOUNCE_MS);
    }

    // ============================================================
    // 数据注入：状态重建
    // ============================================================

    /** 重建结构态与文本区（数据变化 / 选中变化 / 展开变化 / 委托变化 / 行内编辑变化后调用） */
    public refresh(): void {
        this.collapseSelectionIfGone();

        // 先取 id 再查节点：右栏要的是「框架 id」，而 SeqtkNode 上并没有 nodeId 字段；
        // 顺带保证整段用的是同一个选中快照（collapseSelectionIfGone 刚清过已消失的选中）
        const frameworkId = this.selectedFrameworkId;
        const current = frameworkId ? this.pipe.GET_Node(frameworkId) : undefined;
        this.stateStore.set({
            initializing: !this.pipe.isInitialized,
            // 行覆盖信息：正在重命名的那一行由行组件渲染输入框
            leftItems: BUILD_TemplateLeftItems(this.pipe, this.expandedLeft, frameworkId, (nodeId) => ({
                editing: this.rename?.nodeId === nodeId,
            })),
            leftEmpty: !this.pipe.isInitialized
                ? '正在加载缓存…'
                : this.pipe.GET_ByKind(NODE_KIND.TEMP).length === 0 ? EMPTY_TemplateTreeText : undefined,
            selectedId: frameworkId,
            rightTitle: current ? `${NODE_KIND_LABELS[current.kind]} · ${current.desc}` : undefined,
            delegated: TEMPLATE_TREE.delegated,
            leftPaneWidth: this.leftWidth,
            creating: this.creating,
            renameId: this.rename?.nodeId ?? null,
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
            // 插入时的同名冲突策略：记忆在设置里，预览区底部可改
            conflict: this.settings.templatePolicy ?? 'append',
        });
    }

    /**
     * 选中的框架若已不存在（别处归档 / 删了），清掉选中与草稿
     *
     * 切片协作可见：委托面板的同名回调与本视图共用同一份判定（幂等）。
     */
    public collapseSelectionIfGone(): void {
        const id = this.selectedFrameworkId;
        // 选中项没了、或**变成了归类容器**（刚给它加了子框架）→ 清掉选中与草稿：
        // 容器没有编辑入口，右栏不该继续挂着它的内容
        if (id && (!this.pipe.GET_Node(id) || IS_TemplateContainer(this.pipe, id))) {
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
                // 广播：模板树若正被委托，侧栏那份也要重算
                TEMPLATE_TREE.markExpandedChanged();
                this.refresh();
            },
            select: (nodeId) => {
                // 归类容器不可选中（它只是分类目录）：点它不改变选中，右栏也不动
                if (IS_TemplateContainer(this.pipe, nodeId)) return;
                this.selectedFrameworkId = nodeId;
                // 换框架：文本区回到新框架的导出结果（草稿属于上一个框架）
                this.textDraft = null;
                this.refresh();
            },
            contextMenu: (nodeId, e) => this.showRowMenu(nodeId, e),
            // 左栏空白右键：行内新建根级模板框架 + 从磁盘刷新（与事务设计左栏同一处、同一套形态）
            blankContextMenu: (e) => {
                BUILD_Menu(
                    [
                        {
                            name: '新建模板框架',
                            icon: ICON.newFramework,
                            section: SECTION.main,
                            action: () => startCreateBlank(this, NODE_KIND.TEMP, 'left'),
                        },
                        {
                            name: '从磁盘刷新',
                            icon: ICON.syncFromFiles,
                            section: SECTION.refresh,
                            action: () => void SYNC_FromFiles(this.pipe),
                        },
                    ],
                    e,
                );
            },
            applyTemplate: (nodeId) => APPLY_Template(this, nodeId),
            // 归档而非删除：模板是可复用资产，误删代价大，归档后还能捞回来
            archiveNode: (nodeId) => archiveNode(this, nodeId),
            openFile: (nodeId) => OPEN_NodeFile(this, nodeId),
            // ── 行内新建 / 重命名：转发给 design/inlineEdit（与设计视图、委托面板同一份实现）──
            createCommit: (parentId, kind, name) => void commitCreate(this, parentId, kind, name),
            createCancel: () => cancelCreate(this),
            createKindChange: (_parentId, kind) => setCreateKind(this, kind),
            createRepeatChange: (_parentId, repeat) => setCreateRepeat(this, repeat),
            inlineCommit: (nodeId, value) => commitRename(this, nodeId, value),
            inlineCancel: () => cancelRename(this),
            textChange: (value) => {
                this.textDraft = value;
                this.refreshText();
            },
            textCommit: () => void this.commitText(),
            textReset: () => {
                this.textDraft = null;
                this.refreshText();
            },
            setConflict: (policy) => {
                // 记忆在设置里（下次打开还是这个选择），随后刷一次文本区把选中态显示出来
                this.settings.templatePolicy = policy;
                this.persistSettings?.();
                this.refreshText();
            },
            togglePreviewState: (line) => {
                // 预览上的状态圆点：改的就是编辑文本（草稿），没按「确认」前不落库
                const r = TOGGLE_TextTreeState(this.textDraft ?? '', line);
                if (!r) return;
                this.textDraft = r.value;
                this.refreshText();
            },
            toggleDelegate: () => {
                // 全局互斥：已在委托就释放这份；否则让模板来源进入委托并把落点开出来
                if (TEMPLATE_TREE.delegated) DELEGATE.release('template');
                else START_Delegate(this.app, this.settings, 'template');
                this.refresh();
            },
            setLeftWidth: (width) => {
                const clamped = Math.min(Math.max(Math.round(width), LEFT_WIDTH_MIN), LEFT_WIDTH_MAX);
                if (clamped === this.leftWidth) return;
                this.leftWidth = clamped;
                this.schedulePersist();
            },
        };
    }

    /**
     * 框架行右键菜单
     *
     * 只针对模板框架本身 —— 模板内容不在这棵树上管理（内容 = 右栏的文本），所以菜单里
     * 没有「新建单元」这类内容级动作；「应用此模板到框架…」把整个框架的内容插进目标框架。
     * 新建与重命名都是**行内**的（与事务设计左栏同一套），不再开弹窗。
     *
     * 两类框架各少一项：
     * - 归类容器（含子框架）：不是可用模板，所以没有「应用」与「打开正文」
     * - 已经装了模板单元的框架：不再给「新建子框架」（见下面的判定说明）
     * 委托出去的那份树用的是同一套菜单（见 Slice/templateDelegate）。
     */
    private showRowMenu(nodeId: string, event: MouseEvent): void {
        const defs: MenuDefinition[] = [];
        // 已经装了模板单元（非框架类型子节点）的框架不再提供「新建子框架」：
        // 一个模板框架要么当分类目录（装子框架）、要么当模板库（装单元），
        // 混在一起就分不清哪些是模板、哪些是分类了
        if (!HAS_TemplateUnits(this.pipe, nodeId)) {
            defs.push({
                name: '新建子项',
                icon: ICON.newFramework,
                section: 'new',
                action: () => startCreateChild(this, CTX_FromRowEvent(event, nodeId), 'left', [NODE_KIND.TEMP]),
            });
        }
        defs.push(
            {
                name: '重命名',
                icon: ICON.rename,
                section: 'new',
                action: () => startRename(this, nodeId, 'left'),
            },
            {
                name: '归档模板',
                icon: ICON.archive,
                section: 'danger',
                warning: true,
                action: () => archiveNode(this, nodeId),
            },
        );
        BUILD_Menu(defs, event);
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
