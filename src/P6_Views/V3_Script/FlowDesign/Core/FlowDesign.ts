/**
 * FlowView — 事务设计 · 流程设计
 *
 * 双栏：左栏流程脚本（NODE_KIND.FLOW）列表；右栏「脚本程序」与「LAD 程序」切换制。
 * - 脚本为事实源（节点正文存放 flow 语法文本）
 * - 脚本态：textarea 编辑 + 解析错误红标
 * - LAD 态：约束块 + 语句/时间块的投影与逆向编辑（改参数、增删、↑↓ 重排），
 *   修改经序列化写回脚本文本
 *
 * 逻辑与渲染分离：
 * - 本文件（逻辑）：注册、数据读写、AST 操作，以及 **LAD 编辑器的命令式 DOM 逻辑**；
 * - FlowDesignPanel.tsx（渲染）：左栏脚本列表 + 右栏外壳（模式切换 / 保存 / 容器）。
 *
 * 为什么 LAD 编辑器不 React 化：它是「HTML5 拖拽 + 命令式 DOM 构建 + 右键菜单」的
 * 深度命令式代码，强行声明式化既易引入回归又无收益。
 * 沿用与 CanvasBoardHost 相同的原则：React 只出容器，命令式资源不进渲染树。
 */

import { createElement, type ReactNode } from "react";
import { Menu, Notice, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { PANE_WIDTH_DEFAULT } from "../../../../P0_UI/usePaneResize";
import { NODE_KIND } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import { parseFlowScript, parseTimeExpr } from "../../../../P2_Tools/Script/parser";
import { branchText, guardText, serializeFlowScript, transferText, timeText } from "../../../../P2_Tools/Script/serialize";
import { GET_FileByPath } from "../../../../P5_Data/MdFile/PathTools/PathParse";
import { TransactionCreateModal } from "../../../../P7_Render/Structure/S2_Modal/TransactionModals";
import { FlowDesignPanel, type FlowDesignState, type FlowScriptRow } from "./FlowDesignPanel";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import { Save_Setting, type PluginSettings } from "../../../../P3_Settings/Settings";
import type { NodeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../../../P4_Nodes/Node";
import type { FlowScript, Branch, Transfer, Statement } from "../../../../P2_Tools/Script/parser";
import { DELEGATE } from "../../../Special/Delegate/DelegateRegistry";
import { START_Delegate } from "../../../Special/Delegate/delegateTargets";
import { SET_RowMenu } from "../../../Special/Delegate/rowMenuRegistry";
import { FlowPromptModal } from "../Slice/modals";
import { BUILD_ScriptRows, CREATE_Script, OPEN_ScriptFile, SELECT_Script, SHOW_ScriptMenu } from "../Slice/scriptList";
import { RENDER_ScriptMode } from "../Slice/scriptMode";
import { ADD_StatementByDrop, ADD_TransferByDrop, IS_BranchKind, KIND_LABELS } from "../Slice/authoring";
import { FLOW_DELEGATE, FLOW_TREE } from "../Slice/flowTreeShared";
import type { FlowScriptItem } from "../Slice/flowTreeShared";
import type { FlowDesignHost } from "../Slice/host";

export const VIEW_TYPE_FLOW = 'seqtk-flow';

/** 拖拽时写进 dataTransfer 的类型键（组件面板 ↔ 投放目标之间的约定） */
const DRAG_KEY = 'seqtk/elem';

/** 分支指令名（拖入即新建一条语句） */
const BRANCH_PALETTE = ['REPT', 'AT', 'STEP', 'IF', 'NOT'];
/** 传送指令名（拖入即追加到一条语句） */
const TRANSFER_PALETTE = ['JUMP', 'RECO', 'EXEC', 'DO'];

/** 时间块每深一层的缩进（px） */
const BLOCK_INDENT = 22;

/**
 * 会话状态写回的防抖窗口（ms）
 *
 * 与线路 / 模板各自定义的那份同值 —— 它们也是各写一份，这里沿用同样的做法，
 * 免得为一个常量把几个视图横向串起来。
 */
const PERSIST_DEBOUNCE_MS = 600;

/**
 * 脚本正文自动保存的防抖（毫秒）
 *
 * 比会话状态那 600ms 长：这里一次落盘要读改写一整个 md 文件，
 * 而且每次都会走一遍文件队列；LAD 上连点几下不该变成连写几次盘。
 */
const SCRIPT_SAVE_DEBOUNCE_MS = 1200;

@AutoView()
@AutoRegister()
export class FlowView extends ReactViewBase implements FlowDesignHost {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_FLOW, title: '流程设计', icon: 'workflow', description: '内置可切换的可视化流程程序与流程脚本程序，为时段/日期/时间点编写推送规则（脚本为事实源）。', category: '规则设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): FlowView {
        return new FlowView(
            leaf,
            plugin,
            plugin.allDeps.dataPipe,
            plugin.allDeps.settings,
            // 写盘回调：视图类不直接依赖插件实例（与线路 / 模板视图同一写法）
            () => void Save_Setting(plugin),
        );
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-flow',
            name: '打开流程设计',
            callback: () => plugin.activateView(VIEW_TYPE_FLOW),
        });
    }

    /** FlowDesignPanel 提供的右栏内容容器 */
    private flowContent: HTMLDivElement | null = null;
    /** 切片协作可见（FlowDesignHost）：右栏模式 */
    public mode: 'script' | 'lad' = 'script';
    /**
     * 切片协作可见（FlowDesignHost）：当前选中的脚本 nodeId
     *
     * 转发到共享源而不是自己存一份 —— 左栏与委托面板改的是同一个值，于是两处天然一致，
     * 不需要同步代码（与线路视图的 selectedFrameworkId 同法）。
     */
    public get currentScriptId(): string | null {
        return FLOW_TREE.selectedId;
    }

    public set currentScriptId(v: string | null) {
        FLOW_TREE.selectedId = v;
    }

    /** 切片协作可见（FlowDesignHost）：当前脚本的正文文本 */
    public currentText = '';
    private currentAst: FlowScript | null = null;
    private unsub: (() => void) | null = null;
    /** 共享源（委托状态 / 选中）的订阅 */
    private unsubShared: (() => void) | null = null;
    /** 文件基准节点（脚本）变化订阅 */
    private unsubFiles: (() => void) | null = null;
    /** 左栏宽度（px）：拖动结束后经 setLeftWidth 落到这里 */
    private leftWidth = PANE_WIDTH_DEFAULT;
    /** 会话状态写回的防抖计时器 */
    private persistTimer: number | null = null;
    /** 脚本正文自动保存的防抖计时器 */
    private scriptTimer: number | null = null;
    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<FlowDesignState>({
        initializing: true,
        scripts: [],
        currentScriptId: null,
        mode: 'script',
        leftPaneWidth: PANE_WIDTH_DEFAULT,
        delegated: false,
    });

    constructor(
        leaf: WorkspaceLeaf,
        /** 切片协作可见（FlowDesignHost）：切片要用它取 settings 等 */
        public plugin: SeqtkPlugin,
        /** 数据面唯一入口（读写一律经它）；切片协作可见 */
        public pipe: DataPipe,
        /** 切片协作可见（FlowDesignHost） */
        public settings: PluginSettings,
        /** 把设置写回磁盘（由装配层注入，视图类不直接依赖插件实例） */
        private persistSettings?: () => void,
    ) {
        super(leaf);
        this.leftWidth = this.settings.flowLeftPaneWidth || PANE_WIDTH_DEFAULT;
    }

    getViewType(): string {
        return VIEW_TYPE_FLOW;
    }

    getDisplayText(): string {
        return '流程设计';
    }

    getIcon(): string {
        return 'workflow';
    }

    /** 渲染件在 FlowDesignPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(FlowDesignPanel, {
            state: this.state,
            onSelectScript: (nodeId: string) => this.selectScript(nodeId),
            onScriptContextMenu: (nodeId: string | null, e: globalThis.MouseEvent) => {
                const data = nodeId ? this.pipe.GET_Node(nodeId) : null;
                this.showScriptMenu(nodeId, nodeId ? (FLOW_TREE.items.find((i) => i.nodeId === nodeId) ?? null) : null, e);
            },
            onToggleDelegate: () => this.toggleDelegate(),
            onToggleMode: () => this.switchMode(this.mode === 'script' ? 'lad' : 'script'),
            onSave: () => this.save(true),
            onWidthChange: (width) => this.setLeftWidth(width),
            onContentReady: (container: HTMLDivElement) => {
                this.flowContent = container;
                this.renderContent();
            },
            onContentDispose: () => { this.flowContent = null; },
        });
    }

    protected onMounted(): void {
        this.unsub = this.pipe.SUB_ActiveView(() => this.recompute());
        // 共享源一变（含委托被别处取消）就重算 —— 左栏在「让位 / 回来」之间切换
        this.unsubShared = FLOW_TREE.store.subscribe(() => this.recompute());
        // 脚本是**文件基准**节点：列表靠异步扫描，变化靠文件事件。
        // 上面那条缓存订阅（SUB_ActiveView）永远等不到脚本 —— 它根本不进缓存
        this.REFRESH_Scripts();
        this.unsubFiles = this.pipe.SUB_FileChange((kind) => {
            if (kind === NODE_KIND.FLOW) this.REFRESH_Scripts();
        });
        // 委托面板点「在右侧打开」时要回到本视图，来源得知道自己是哪种类型
        FLOW_DELEGATE.viewType = VIEW_TYPE_FLOW;
        // 行菜单交给登记处：委托面板里取到的就是左栏这一套（见 rowMenuRegistry）
        SET_RowMenu('flow', (ctx, e) => {
            this.showScriptMenu(ctx.nodeId, FLOW_TREE.items.find((i) => i.nodeId === ctx.nodeId) ?? null, e);
        });
        // 上次关库时的委托意图：先按它让位，等登记处落定自然衔接（成因见 FlowTreeShared）
        FLOW_TREE.SET_PendingDelegated(this.settings.delegatedOwner === 'flow' && !DELEGATE.settled);
        this.recompute();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubShared?.();
        this.unsubShared = null;
        this.unsubFiles?.();
        this.unsubFiles = null;
        SET_RowMenu('flow', null);
        // 视图关掉时把最后一次宽度立刻落盘（防抖那一次未必等得到）
        this.FLUSH_Session();
        // 脚本正文也可能还有没落盘的一次自动保存
        this.FLUSH_Script();
    }

    /**
     * 重新扫描流程脚本列表（文件基准通道：**异步**）
     *
     * 脚本不在活跃缓存里，只能扫盘。结果写进 `FLOW_TREE` 快照 —— 左栏与委托面板
     * 都订阅了它，所以一次 SET_Items 会把两边一起刷新。
     */
    private REFRESH_Scripts(): void {
        void this.pipe.SCAN_Files([NODE_KIND.FLOW]).then((files) => {
            FLOW_TREE.SET_Items(files.map((f) => ({
                nodeId: f.nodeId,
                kind: f.data.kind,
                desc: f.data.desc,
                parent: (f.data as { parent?: string }).parent ?? '',
            })));
        }).catch((e: unknown) => {
            console.error('[SeqTK] 扫描流程脚本失败:', e);
        });
    }

    /**
     * 委托 / 取消委托左栏的脚本列表
     *
     * 与 design/navigation.toggleDelegate 同名同语义，只有来源不同 —— 那边硬编码 'design'，
     * 而这里要的是 'flow'。所以本视图自己写这几行，而不是去改那个共用函数。
     */
    private toggleDelegate(): void {
        if (FLOW_TREE.delegated) DELEGATE.release('flow');
        else START_Delegate(this.app, this.settings, 'flow');
    }

    // ============================================================
    // 左栏宽度（会话状态）
    // ============================================================

    /**
     * 左栏宽度变更
     *
     * 拖动期间面板只改 DOM（见 P0_UI/usePaneResize），松手才到这里 —— 每帧落盘会拖慢手感，
     * 所以这里也只更新内存与视图，由 schedulePersist 统一防抖写回。
     */
    private setLeftWidth(width: number): void {
        this.leftWidth = width;
        this.state.set({ ...this.state.get(), leftPaneWidth: this.leftWidth });
        this.schedulePersist();
    }

    /** 防抖写回会话状态（关库那一次由 FLUSH_Session 兜底，见 main.onunload） */
    private schedulePersist(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            this.FLUSH_Session();
        }, PERSIST_DEBOUNCE_MS);
    }

    /**
     * 立刻把会话状态写回设置（不防抖）—— 供关视图与插件卸载时调用
     *
     * 写回有防抖，而关库时 Obsidian 直接卸载插件，onBeforeUnmount 未必被调用，
     * 最后一次变更就可能丢掉，所以 main.onunload 会显式喊一声（与线路 / 模板同一做法）。
     */
    public FLUSH_Session(): void {
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.settings.flowLeftPaneWidth = this.leftWidth;
        this.persistSettings?.();
    }

    // ============================================================
    // 左栏：流程脚本列表（数据 → 状态）
    // ============================================================

    /** 重算左栏与右栏外壳状态（数据 → 视图状态）；切片协作可见 */
    public recompute(): void {
        this.state.set({
            initializing: !this.pipe.isInitialized,
            scripts: BUILD_ScriptRows(this),
            currentScriptId: this.currentScriptId,
            mode: this.mode,
            leftPaneWidth: this.leftWidth,
            delegated: FLOW_TREE.delegated,
            contentEmpty: this.currentScriptId ? undefined : '请在左侧选择流程脚本',
        });
    }

    // ---- 左栏操作：实现在 Slice/scriptList，这里只转发 ----

    private selectScript(nodeId: string): void {
        SELECT_Script(this, nodeId);
    }

    private showScriptMenu(nodeId: string | null, data: FlowScriptItem | null, e: MouseEvent): void {
        SHOW_ScriptMenu(this, nodeId, data, e);
    }

    private createScript(): void {
        CREATE_Script(this);
    }

    private openNodeFile(kind: NodeKindValue, nodeId: string): void {
        OPEN_ScriptFile(this, kind, nodeId);
    }

    // ============================================================
    // 右栏：模式切换与内容
    // ============================================================

    private switchMode(mode: 'script' | 'lad'): void {
        this.mode = mode;
        this.state.set({ ...this.state.get(), mode });
        this.renderContent();
    }

    /** 重绘右栏内容；切片协作可见 */
    public renderContent(): void {
        const el = this.flowContent;
        if (!el) return;
        el.empty();
        if (!this.currentScriptId) return;   // 空态由 Panel 渲染
        if (this.mode === 'script') RENDER_ScriptMode(this, el);
        else this.renderLadMode(el);
    }

    // ---- LAD 态（投影 + 逆向编辑） ----

    private renderLadMode(el: HTMLElement): void {
        /*
         * 就地重绘，并把旧的滚动位置搬过来。
         *
         * 不能用 createDiv 往 el 上追加 —— commitAst 每次改动都调本方法，追加会让 LAD 在
         * 底部一层层长出来（就是「越改越长、改动落在远处」）。清空重建是对的，但重建会把
         * 滚动位置甩回顶部，所以位置得自己记住再还原。
         */
        const prevScrollTop = el.querySelector('.seqtk-flow-lad')?.scrollTop ?? 0;
        el.empty();
        this.currentAst = parseFlowScript(this.currentText);
        const ast = this.currentAst;
        const wrap = el.createDiv('seqtk-flow-lad');
        if (ast.errors.length > 0) {
            for (const err of ast.errors) {
                wrap.createEl('div', { cls: 'seqtk-flow-err', text: `第 ${err.line} 行：${err.message}` });
            }
            wrap.createEl('div', { cls: 'seqtk-empty', text: '存在语法错误，无法渲染 LAD（请在脚本态修正）' });
            return;
        }
        this.renderLadWithOps(wrap, ast);
        wrap.scrollTop = prevScrollTop;
    }

    /** 渲染 LAD 并挂逆向编辑操作（右侧组件面板 + 拖拽添加） */
    private renderLadWithOps(wrap: HTMLElement, ast: FlowScript): void {
        wrap.createEl('div', {
            cls: 'seqtk-lad-hint',
            text: '提示：从上到下是语句序列，带 {} 的语句在下方缩进一层。从右侧拖入分支指令新建语句、拖入传送指令追加到末条；点击芯片改参数，右键删除，{} 按钮切换时间块。修改即时写回脚本。',
        });
        const layout = wrap.createDiv('seqtk-lad-layout');
        const editArea = layout.createDiv('seqtk-lad-edit');
        this.renderPalette(layout);

        // 编辑区空白投放：分支 → 新建一条语句；传送 → 追加到末条语句
        const handleEditDrop = (type: string): void => {
            if (IS_BranchKind(type)) {
                ADD_StatementByDrop(this, type, ast.statements);
                return;
            }
            ADD_TransferByDrop(this, type, ast.statements[ast.statements.length - 1]);
        };
        this.attachDrop(editArea, handleEditDrop, 'seqtk-lad-zone-active');
        this.attachDrop(wrap, handleEditDrop, 'seqtk-lad-zone-active');

        this.renderGuardRow(editArea, ast);

        if (ast.statements.length === 0) {
            const ph = document.createElement('div');
            ph.className = 'seqtk-lad-placeholder';
            ph.textContent = '还没有语句。点击添加，或从右侧拖入分支指令';
            ph.addEventListener('click', (e) => this.showAddStatementMenu(e));
            editArea.appendChild(ph);
        } else {
            ast.statements.forEach((s, i) => this.renderStatementEditable(editArea, ast.statements, s, i, 0));
        }
    }

    /** 右侧预设组件面板（拖拽添加到编辑区）：分支 5 + 传送 4 */
    private renderPalette(layout: HTMLElement): void {
        const palette = layout.createDiv('seqtk-lad-palette');
        palette.createEl('div', { cls: 'seqtk-lad-palette-title', text: '分支指令' });
        for (const kind of BRANCH_PALETTE) this.renderPaletteItem(palette, kind, 'seqtk-lad-branch');
        palette.createEl('div', { cls: 'seqtk-lad-palette-title', text: '传送指令' });
        for (const kind of TRANSFER_PALETTE) this.renderPaletteItem(palette, kind, 'seqtk-lad-step');
        palette.createEl('div', {
            cls: 'seqtk-lad-palette-hint',
            text: '分支 → 新建语句；传送 → 追加到末条',
        });
    }

    /** 一个可拖拽的面板元件 */
    private renderPaletteItem(palette: HTMLElement, kind: string, cls: string): void {
        const el = document.createElement('div');
        el.className = `seqtk-lad-palette-item ${cls}`;
        el.textContent = KIND_LABELS[kind] ?? kind;
        el.draggable = true;
        el.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData(DRAG_KEY, kind);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
        });
        palette.appendChild(el);
    }

    /** 挂载拖放目标：dragover + drop 分发（dragover 用 types 判断组件拖拽，避免 getData 在 dragover 不可靠） */
    private attachDrop(el: HTMLElement, onDrop: (type: string) => void, hoverClass?: string): void {
        el.addEventListener('dragover', (e) => {
            const types = e.dataTransfer?.types ?? [];
            if (!types.includes(DRAG_KEY)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            if (hoverClass) el.classList.add(hoverClass);
        });
        el.addEventListener('dragleave', () => {
            if (hoverClass) el.classList.remove(hoverClass);
        });
        el.addEventListener('drop', (e) => {
            const type = e.dataTransfer?.getData(DRAG_KEY) ?? '';
            e.preventDefault();
            e.stopPropagation();
            if (hoverClass) el.classList.remove(hoverClass);
            if (type) onDrop(type);
        });
    }

    // ---- 约束指令（#STF / #ENF） ----

    /**
     * 把约束条目配成「起止对」
     *
     * 顺序扫描：`#STF` 开一对，紧随的 `#ENF` 并入；没有未闭合的起就让止自成一对。
     * 只做忠实配对（多余 / 缺半的照样显示成行），合法性仍交给评估层。
     */
    private pairGuards(guards: FlowScript['guards']): { stf: number | null; enf: number | null }[] {
        const pairs: { stf: number | null; enf: number | null }[] = [];
        let open = -1;
        guards.forEach((g, i) => {
            if (g.kind === 'STF') {
                pairs.push({ stf: i, enf: null });
                open = pairs.length - 1;
                return;
            }
            if (open >= 0 && pairs[open].enf === null) {
                pairs[open].enf = i;
                open = -1;
            } else {
                pairs.push({ stf: null, enf: i });
            }
        });
        return pairs;
    }

    /**
     * 渲染约束区
     *
     * 约束是**脚本级**的（不属于任何语句），所以排在语句序列之上。**以起止对为组、
     * 每对独立成行**（`#STF` 绿 / `#ENF` 红，一眼看出一头一尾）。点击改值、右键删除、
     * 「+」加一条。可以有多组 —— 合法性（EVER 组不重叠等）交给评估层，这里只忠实呈现。
     */
    private renderGuardRow(parent: HTMLElement, ast: FlowScript): void {
        parent.createEl('div', { cls: 'seqtk-lad-section-title', text: '约束' });

        const pairs = this.pairGuards(ast.guards);
        /** 渲染一行约束（一对起止 + 行末的添加入口） */
        const renderPairRow = (pair: { stf: number | null; enf: number | null }, withAdd: boolean): void => {
            const row = parent.createDiv('seqtk-lad-window');
            for (const idx of [pair.stf, pair.enf]) {
                if (idx === null) continue;
                const g = ast.guards[idx];
                const chip = row.createEl('span', {
                    cls: `seqtk-lad-decl seqtk-lad-decl-${g.kind.toLowerCase()}`,
                    text: guardText(g),
                });
                setTooltip(chip, '点击改值；右键删除');
                chip.addEventListener('click', () => this.editGuard(ast, idx));
                this.attachDeleteMenu(chip, () => { ast.guards.splice(idx, 1); });
            }
            if (withAdd) {
                const add = row.createEl('span', { cls: 'seqtk-lad-add', text: '+' });
                setTooltip(add, '加一条约束');
                add.addEventListener('click', (e) => this.showAddGuardMenu(e, ast));
            }
        };

        if (pairs.length === 0) {
            renderPairRow({ stf: null, enf: null }, true);
            return;
        }
        pairs.forEach((pair, i) => renderPairRow(pair, i === pairs.length - 1));
    }

    /** 弹窗问出一个约束值：`EVER` 或 `@` 时间表达式 */
    private askGuardValue(label: string, initial: string, done: (v: 'EVER' | NonNullable<ReturnType<typeof parseTimeExpr>> | null) => void): void {
        new FlowPromptModal(this.app, [{ label, defaultValue: initial }], ([raw]) => {
            const v = raw.trim();
            if (!v) { done(null); return; }
            if (/^EVER$/i.test(v)) { done('EVER'); return; }
            const t = parseTimeExpr(v);
            if (!t) { new Notice('要写 EVER 或 @ 开头的时间，如 @20260921-0112'); done(null); return; }
            done(t);
        }).open();
    }

    private editGuard(ast: FlowScript, idx: number): void {
        const g = ast.guards[idx];
        this.askGuardValue(
            `${g.kind} 的值（EVER 或 @ 时间）`,
            g.value === 'EVER' ? 'EVER' : timeText(g.value),
            (v) => {
                if (v) { g.value = v; this.commitAst(); }
            },
        );
    }

    private showAddGuardMenu(e: MouseEvent, ast: FlowScript): void {
        const menu = new Menu();
        for (const kind of ['STF', 'ENF'] as const) {
            menu.addItem((item) => item.setTitle(`#${kind}`).setIcon('plus')
                .onClick(() => this.askGuardValue(`${kind} 的值（EVER 或 @ 时间）`, 'EVER', (v) => {
                    if (!v) return;
                    ast.guards.push({ line: 0, kind, value: v });
                    this.commitAst();
                })));
        }
        menu.showAtMouseEvent(e);
    }

    // ---- 语句与时间块 ----

    /**
     * 渲染一条语句（含它的时间块）
     *
     * 时间块用**缩进**表达层次：块内的语句递归画在同一父容器里、深度 +1，
     * 而不是塞进一个嵌套的框 —— 这样整段语句序列看起来仍然是平铺的一张表，
     * 只是后代往里缩，与脚本正文的读法一致。
     */
    private renderStatementEditable(
        parent: HTMLElement,
        siblings: Statement[],
        stmt: Statement,
        idx: number,
        depth: number,
    ): void {
        const row = document.createElement('div');
        row.className = 'seqtk-lad-stream';
        row.style.paddingLeft = `${depth * BLOCK_INDENT}px`;

        // 空块的后代占位：让「这里有块但还空着」看得见
        if (stmt.braced && stmt.block.length === 0) row.addClass('seqtk-lad-stream-braced');

        // 分支芯片（点击改参数；右键删除整条语句）
        const branch = document.createElement('span');
        branch.className = `seqtk-lad-branch seqtk-lad-branch-${stmt.branch.kind.toLowerCase()}`;
        branch.textContent = branchText(stmt.branch);
        setTooltip(branch, '点击修改参数；右键删除这条语句');
        branch.addEventListener('click', () => this.editBranch(stmt));
        this.attachDeleteMenu(branch, () => { siblings.splice(idx, 1); });
        row.appendChild(branch);

        // 传送指令序列（点击改参数，右键删除）
        stmt.transfers.forEach((t, ti) => {
            const arrow = document.createElement('span');
            arrow.className = 'seqtk-lad-arrow';
            arrow.textContent = '──';
            row.appendChild(arrow);

            const chip = document.createElement('span');
            chip.className = `seqtk-lad-step seqtk-lad-step-${t.kind.toLowerCase()}`;
            chip.textContent = transferText(t);
            setTooltip(chip, '点击修改；右键删除');
            chip.addEventListener('click', () => this.editTransfer(stmt, ti));
            this.attachDeleteMenu(chip, () => { stmt.transfers.splice(ti, 1); });
            row.appendChild(chip);
        });

        // 追加传送指令的入口
        const add = document.createElement('span');
        add.className = 'seqtk-lad-add';
        add.textContent = '+';
        setTooltip(add, '添加传送指令');
        add.addEventListener('click', (e) => this.showAddTransferMenu(e, stmt));
        row.appendChild(add);

        // 时间块开关：`;` ⇄ `{}`
        const brace = document.createElement('button');
        brace.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
        brace.textContent = stmt.braced ? '{}' : '{ }';
        setTooltip(brace, stmt.braced ? '取消时间块（改回单语句 ;）' : '变成时间块 {}');
        brace.addEventListener('click', () => {
            stmt.braced = !stmt.braced;
            this.commitAst();
        });
        row.appendChild(brace);

        // ↑↓ 在同层内移动
        this.appendMoveButtons(row, siblings, idx);
        parent.appendChild(row);

        if (stmt.braced) {
            stmt.block.forEach((child, ci) => this.renderStatementEditable(parent, stmt.block, child, ci, depth + 1));
        }
    }

    /** 语句末尾的 ↑↓ 按钮（同层重排） */
    private appendMoveButtons(row: HTMLElement, siblings: Statement[], idx: number): void {
        const mk = (text: string, tip: string, disabled: boolean, target: number): void => {
            const btn = document.createElement('button');
            btn.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
            btn.textContent = text;
            setTooltip(btn, tip);
            btn.disabled = disabled;
            btn.addEventListener('click', () => {
                const [moved] = siblings.splice(idx, 1);
                siblings.splice(target, 0, moved);
                this.commitAst();
            });
            row.appendChild(btn);
        };
        mk('↑', '上移', idx === 0, idx - 1);
        mk('↓', '下移', idx === siblings.length - 1, idx + 1);
    }

    /** 点击分支芯片：改它的参数 */
    private editBranch(stmt: Statement): void {
        const b = stmt.branch;
        const apply = (next: Branch): void => {
            stmt.branch = next;
            this.commitAst();
        };
        switch (b.kind) {
            case 'REPT':
                new FlowPromptModal(this.app, [{ label: 'REPT 循环条件（如 @R-D1）', defaultValue: b.arg }], ([raw]) => {
                    const v = raw.trim();
                    const t = v ? parseTimeExpr(v) : null;
                    if (!t) { new Notice('REPT 的条件要写成 @ 开头的时间，如 @R-D1'); return; }
                    apply({ kind: 'REPT', arg: v, time: t });
                }).open();
                return;
            case 'AT':
                // 两块：起点；TO 留空就是「一个区间」，填了就是「跨到另一个区间」
                new FlowPromptModal(this.app, [
                    { label: 'AT 时间（如 @T-H9 / @20260924-0112）', defaultValue: b.arg },
                    { label: 'TO 时间（留空 = 只到这一处）', defaultValue: b.to ?? '' },
                ], ([atRaw, toRaw]) => {
                    const at = atRaw.trim();
                    const t = at ? parseTimeExpr(at) : null;
                    if (!t) { new Notice('AT 要写成 @ 开头的时间'); return; }
                    const to = toRaw.trim();
                    if (!to) { apply({ kind: 'AT', arg: at, time: t }); return; }
                    const tt = parseTimeExpr(to);
                    if (!tt) { new Notice('TO 要写成 @ 开头的时间'); return; }
                    apply({ kind: 'AT', arg: at, time: t, to, toTime: tt });
                }).open();
                return;
            case 'STEP':
                new FlowPromptModal(this.app, [{ label: 'STEP 步骤名（如 S91）', defaultValue: b.arg }], ([raw]) => {
                    const v = raw.trim();
                    if (v) apply({ kind: 'STEP', arg: v });
                }).open();
                return;
            case 'IF':
            case 'NOT': {
                const kind = b.kind;
                new FlowPromptModal(this.app, [{ label: `${kind} 条件`, defaultValue: b.arg }], ([raw]) => {
                    const v = raw.trim();
                    if (v) apply({ kind, arg: v });
                }).open();
                return;
            }
        }
    }

    /** 点击传送芯片：改它的参数（RECO 没有参数） */
    private editTransfer(stmt: Statement, ti: number): void {
        const t = stmt.transfers[ti];
        const done = (next: Transfer | null): void => {
            if (!next) return;
            stmt.transfers[ti] = next;
            this.commitAst();
        };
        const opt = (label: string, cur: string | undefined, build: (v: string) => Transfer): void => {
            new FlowPromptModal(this.app, [{ label: `${label}（留空 = 无）`, defaultValue: cur ?? '' }], ([raw]) => {
                done(build(raw.trim()));
            }).open();
        };
        switch (t.kind) {
            case 'RECO':
                new Notice('RECO 没有参数');
                return;
            case 'JUMP':
                new FlowPromptModal(this.app, [{ label: 'JUMP 目标（如 脚本id.流程号）', defaultValue: t.target }], ([raw]) => {
                    const v = raw.trim();
                    if (v) done({ kind: 'JUMP', target: v });
                }).open();
                return;
            case 'EXEC':
                opt('EXEC 脚本', t.script, (v) => (v ? { kind: 'EXEC', script: v } : { kind: 'EXEC' }));
                return;
            case 'DO':
                // 两块：节点引用（必填）、优先级（可留空）
                new FlowPromptModal(this.app, [
                    { label: 'DO 节点引用', defaultValue: `@${t.nodeId}` },
                    { label: '推送优先级（可留空；可写负数）', defaultValue: t.priority !== undefined ? String(t.priority) : '' },
                ], ([refRaw, prioRaw]) => {
                    const ref = refRaw.trim().replace(/^@/, '');
                    if (!ref) { new Notice('DO 需要节点引用'); return; }
                    const prio = prioRaw.trim();
                    if (!prio) { done({ kind: 'DO', nodeId: ref }); return; }
                    const n = Number(prio);
                    if (!Number.isFinite(n)) { new Notice('优先级要写数字（可带负号）'); return; }
                    done({ kind: 'DO', nodeId: ref, priority: n });
                }).open();
                return;
        }
    }

    /** 添加语句：菜单选分支指令（与面板拖入等价） */
    private showAddStatementMenu(e: MouseEvent): void {
        const menu = new Menu();
        for (const kind of BRANCH_PALETTE) {
            menu.addItem((item) => item.setTitle(KIND_LABELS[kind] ?? kind).setIcon('plus')
                .onClick(() => {
                    const ast = this.currentAst;
                    if (ast) ADD_StatementByDrop(this, kind, ast.statements);
                }));
        }
        menu.showAtMouseEvent(e);
    }

    /** 给某条语句追加传送指令：菜单选指令 */
    private showAddTransferMenu(e: MouseEvent, stmt: Statement): void {
        const menu = new Menu();
        for (const kind of TRANSFER_PALETTE) {
            menu.addItem((item) => item.setTitle(KIND_LABELS[kind] ?? kind).setIcon('plus')
                .onClick(() => ADD_TransferByDrop(this, kind, stmt)));
        }
        menu.showAtMouseEvent(e);
    }

    /** 右键菜单删除（LAD 不显示删除按钮，保持视觉干净） */
    private attachDeleteMenu(el: HTMLElement, onDelete: () => void): void {
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle('删除').setIcon('trash')
                    .onClick(() => {
                        onDelete();
                        this.commitAst();
                    }));
            menu.showAtMouseEvent(e);
        });
    }

    /**
     * LAD 修改 → 序列化写回脚本文本、重渲染，并**安排一次自动保存**
     *
     * 自动保存挂在 commitAst 上，是因为它是 LAD 侧一切改动的唯一出口
     * （增删语句、改约束、改传送都会走到这里）。手点「保存」的按钮仍在，
     * 只是不再是非点不可才落盘。
     */
    public commitAst(): void {
        if (!this.currentAst) return;
        this.currentText = serializeFlowScript(this.currentAst);
        const el = this.flowContent;
        if (el) this.renderLadMode(el);
        this.scheduleSaveScript();
    }

    // ============================================================
    // 保存
    // ============================================================

    /** 安排一次防抖自动保存（脚本态敲字与 LAD 态改动都汇到这里） */
    public scheduleSaveScript(): void {
        if (this.scriptTimer !== null) window.clearTimeout(this.scriptTimer);
        this.scriptTimer = window.setTimeout(() => {
            this.scriptTimer = null;
            this.save();
        }, SCRIPT_SAVE_DEBOUNCE_MS);
    }

    /** 立刻落盘（防抖到期、切脚本、关视图、插件卸载时调用）；不弹提示 */
    public FLUSH_Script(): void {
        if (this.scriptTimer !== null) {
            window.clearTimeout(this.scriptTimer);
            this.scriptTimer = null;
        }
        this.save(false);
    }

    /**
     * 保存脚本正文
     *
     * **kind 取自左栏快照，而不是读节点** —— 此前这里先 `pipe.GET_Node(currentScriptId)`
     * 只为拿 kind，而脚本是文件基准节点、不在活跃缓存里，于是恒为 undefined、
     * 函数在第一句就静默返回：看起来像「保存没生效」，其实是根本没走到写。
     *
     * @param notify 是否弹「已保存」提示。自动保存传 false —— 否则改一下弹一次，
     *   提示本身会变成噪音，把真正该看见的错误淹掉
     */
    private save(notify = false): void {
        const scriptId = this.currentScriptId;
        if (!scriptId) return;
        const kind = FLOW_TREE.GET_SelectedKind();
        if (!kind) return;
        // 脚本态下取 textarea 值；LAD 态下取 currentText（commitAst 已同步）
        const ta = this.flowContent?.querySelector('textarea.seqtk-flow-textarea') as HTMLTextAreaElement | null;
        if (this.mode === 'script' && ta) {
            this.currentText = ta.value;
        }
        this.pipe.EXEC_Mutation({
            op: 'setBody',
            kind,
            nodeId: scriptId,
            body: this.currentText,
        });
        if (notify) new Notice('流程脚本已保存');
    }
}
