/**
 * FlowDraftView — 规则设计 · 流程草稿
 *
 * 定位：**中间产物**。针对选定日做一份简要的线性清单，条目可关联事务节点。
 *
 * 与流程设计的区别（这是它独立存在的理由）：
 * - 草稿是独立节点类型（NODE_KIND.DRAFT），以**流程脚本形式**存储在节点正文里
 * - 只提供这一套简化的清单界面，**不提供脚本设计功能**（没有脚本态 / LAD 态切换）
 * - 流程设计的左栏按 NODE_KIND.FLOW 取脚本，所以草稿天然不会混进去，无需额外过滤
 *
 * 正文字法（复用 flow 语法，不另造一套）：
 *   ║ #STF @20260824-0000        这份草稿覆盖的那一天（约束指令，起 / 止各一条）
 *   ║ #ENF @20260824-2359
 *   ║
 *   ║ AT @20260824-0800 DO @abc123;                    时点条目
 *   ║ AT @20260824-0900 TO @20260824-1200 DO @def456;  时段条目
 *
 * 条目**只有时间与节点引用**（`DO` 只收 `@节点id`）—— 没有自由文本，这是刻意的。
 *
 * 「循环事项」不另立模型：它也是一份草稿，只是 `#STF`/`#ENF` 跨越多日 ——
 * 区间由使用方解释（本视图负责显示与编辑，不负责判定「今天生不生效」）。
 *
 * 逻辑与渲染分离：本文件（逻辑）管数据搬运、AST 操作与清单的命令式 DOM；
 * FlowDraftPanel.tsx（渲染）只出左栏日历与右栏外壳。与 FlowDesign 的 LAD 编辑器同理。
 */

import { GET_KindClass } from "../../P4_Nodes/NodeKind/KindColors";
import { createElement, type ReactNode } from "react";
import { Menu, Modal, Notice, Setting, TextComponent, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { parseFlowScript } from "../../P2_Tools/Script/parser";
import { serializeFlowScript, timeText } from "../../P2_Tools/Script/serialize";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { TransactionCreateModal } from "../../P7_Render/Structure/S2_Modal/TransactionModals";
import { FlowDraftPanel, type FlowDraftRow, type FlowDraftState } from "./FlowDraftPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode, NodeFile } from "../../P4_Nodes/Node";
import type { FlowScript, Statement, TimeExpr } from "../../P2_Tools/Script/parser";

export const VIEW_TYPE_FLOW_DRAFT = 'seqtk-flow-draft';

/** 正文写回的防抖（毫秒）：敲字时不必每个字符落一次盘 */
const SAVE_DEBOUNCE = 500;

/**
 * 列表取回来的一条
 *
 * 直接用 `NodeFile`（`{ nodeId, data, body }`）—— 扫描文件时正文就一起拿到了，
 * 之后算日期区间、数条目、解析 AST 都不必再去取一遍正文。
 *
 * 这一点很关键：草稿是 `NODE_KIND.DRAFT`，属**文件基准通道**，不在活跃缓存里，
 * 用 `GET_ByKind` / `GET_NodeBody` 取它只会得到空 —— 那正是此前草稿列表恒为空、
 * 选中后也不显示条目的原因。
 */
type DraftEntry = NodeFile;

// ============================================================
// 日期与时间的小工具
// ============================================================

/** 今天的 `YYYY-MM-DD`（本地时区） */
function todayIso(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD` ⇄ `YYYYMMDD`（时间戳表达式里用紧凑写法） */
const compact = (date: string): string => date.replace(/-/g, '');
const spaced = (ymd: string): string | null => {
    const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** 绝对时间戳 → `HH:mm`；不是时间戳或解不出就给空 */
function timeOfDay(expr: TimeExpr | undefined): string {
    if (!expr || expr.kind !== 'stamp') return '';
    const t = expr.time;
    return t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '';
}

/** `HH:mm` + 草稿日期 → 绝对时间戳表达式 */
function stampOf(date: string, hhmm: string): TimeExpr {
    const [h, m] = hhmm.split(':');
    return { kind: 'stamp', date: compact(date), time: `${h}${m}` };
}

/** 从约束里取出日期（`#STF` / `#ENF` 的值是绝对时间戳时才有） */
function guardDate(ast: FlowScript, kind: 'STF' | 'ENF'): string | null {
    const g = ast.guards.find((x) => x.kind === kind);
    if (!g || g.value === 'EVER' || g.value.kind !== 'stamp') return null;
    return spaced(g.value.date);
}

/**
 * 改一条条目的时间
 *
 * 同时更新 `branch.arg` 与 `branch.time` —— 前者是解析时留下的原始文本、后者是结构化结果，
 * 两者必须一起走（序列化目前读 `arg`，渲染读 `time`，脱节就会出现「改了这个那个没变」）。
 */
function setItemTime(stmt: Statement, at: TimeExpr, to: TimeExpr | undefined): void {
    if (stmt.branch.kind !== 'AT') return;
    stmt.branch.time = at;
    stmt.branch.arg = timeText(at);
    stmt.branch.toTime = to;
    stmt.branch.to = to ? timeText(to) : undefined;
}

/** 这条条目的节点引用（草稿条目只挂一个 DO） */
function itemNodeId(stmt: Statement): string | undefined {
    for (const t of stmt.transfers) {
        if (t.kind === 'DO') return t.nodeId;
    }
    return undefined;
}

/** 写回节点引用：有就改，没有就补一个 DO；传 undefined 即解除 */
function setItemNode(stmt: Statement, nodeId: string | undefined): void {
    for (const t of stmt.transfers) {
        if (t.kind === 'DO') {
            if (nodeId === undefined) {
                stmt.transfers = stmt.transfers.filter((x) => x !== t);
            } else {
                t.nodeId = nodeId;
            }
            return;
        }
    }
    if (nodeId !== undefined) stmt.transfers.push({ kind: 'DO', nodeId });
}

/** 条目排序用的键：时点或时段的起点 */
function itemKey(stmt: Statement): string {
    const t = stmt.branch.time;
    return t && t.kind === 'stamp' ? t.time : '\uffff';
}

// ============================================================
// 通用弹窗（文本输入 / 确认 / 节点选择），本视图专用
// ============================================================

/** 文本输入弹窗 */
class DraftPromptModal extends Modal {
    constructor(
        app: unknown,
        private opts: {
            title: string;
            placeholder?: string;
            initialValue?: string;
            onOk: (value: string) => void;
        },
    ) {
        super(app as never);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle(this.opts.title);
        const tc = new TextComponent(contentEl);
        tc.inputEl.addClass('seqtk-draft-prompt-input');
        tc.setPlaceholder(this.opts.placeholder ?? '');
        if (this.opts.initialValue) tc.setValue(this.opts.initialValue);
        tc.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submit(tc.getValue());
            if (e.key === 'Escape') this.close();
        });
        new Setting(contentEl).addButton((b) => {
            b.setButtonText('确认').setCta().onClick(() => this.submit(tc.getValue()));
        }).addButton((b) => {
            b.setButtonText('取消').onClick(() => this.close());
        });
        window.setTimeout(() => {
            tc.inputEl.focus();
            tc.inputEl.select();
        }, 30);
    }

    private submit(value: string): void {
        const v = value.trim();
        if (!v) {
            new Notice('内容不能为空');
            return;
        }
        this.opts.onOk(v);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** 确认弹窗 */
class DraftConfirmModal extends Modal {
    constructor(
        app: unknown,
        private opts: {
            title: string;
            message: string;
            confirmText?: string;
            onConfirm: () => void;
        },
    ) {
        super(app as never);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle(this.opts.title);
        contentEl.createEl('p', { text: this.opts.message });
        new Setting(contentEl).addButton((b) => {
            b.setButtonText(this.opts.confirmText ?? '删除').setCta().onClick(() => {
                this.opts.onConfirm();
                this.close();
            });
        }).addButton((b) => {
            b.setButtonText('取消').onClick(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * 节点选择弹窗 — 输入即搜（NodeCache 搜索），列表展示 kind 徽章 + 名称 + nodeId。
 * 仅用于把节点「只读关联」到草稿条目，不修改节点本身。
 */
class NodePickModal extends Modal {
    private searchInput!: HTMLInputElement;
    private listEl!: HTMLElement;
    private searchTimer: number | null = null;

    constructor(
        app: unknown,
        private pipe: DataPipe,
        private onPick: (nodeId: string) => void,
    ) {
        super(app as never);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle('关联节点（只读引用，不修改节点）');

        this.searchInput = contentEl.createEl('input', {
            cls: 'seqtk-draft-node-search',
            attr: { type: 'text', placeholder: '输入节点名称 / nodeId 搜索…' },
        });
        this.listEl = contentEl.createDiv('seqtk-draft-node-list');
        contentEl.createDiv('seqtk-draft-node-empty');

        this.searchInput.addEventListener('input', () => {
            if (this.searchTimer) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => this.renderList(this.searchInput.value), 120);
        });
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });
        window.setTimeout(() => {
            this.searchInput.focus();
            this.renderList('');
        }, 30);
    }

    private renderList(query: string): void {
        this.listEl.empty();
        const results: { nodeId: string; data: SeqtkNode }[] = this.pipe.SEARCH_Nodes(query.trim(), 50);
        if (results.length === 0) {
            this.listEl.createEl('div', { cls: 'seqtk-draft-node-empty', text: '无匹配节点' });
            return;
        }
        for (const { nodeId, data } of results) {
            const row = this.listEl.createDiv('seqtk-draft-node-item');
            row.createEl('span', {
                cls: `seqtk-kind-badge ${GET_KindClass(data.kind)}`,
                text: NODE_KIND_LABELS[data.kind],
            });
            const nameEl = row.createEl('span', { cls: 'seqtk-draft-node-item-name', text: data.desc });
            row.createEl('span', { cls: 'seqtk-draft-node-item-id', text: nodeId });
            row.addEventListener('click', () => {
                this.onPick(nodeId);
                this.close();
            });
            row.addEventListener('mouseenter', () => {
                nameEl.textContent = `${data.desc}  (${nodeId})`;
            });
            row.addEventListener('mouseleave', () => {
                nameEl.textContent = data.desc;
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        if (this.searchTimer) window.clearTimeout(this.searchTimer);
    }
}

// ============================================================
// FlowDraftView
// ============================================================

@AutoView()
@AutoRegister()
export class FlowDraftView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_FLOW_DRAFT, title: '流程草稿', icon: 'calendar-range', description: '针对选定日的简要清单：一条条目是一个时点或时段，可只读关联事务节点。以流程脚本形式存储、带草稿标记，不提供脚本设计功能。', category: '规则设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): FlowDraftView {
        return new FlowDraftView(leaf, plugin, plugin.allDeps.dataPipe);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-flow-draft',
            name: '打开流程草稿',
            callback: () => plugin.activateView(VIEW_TYPE_FLOW_DRAFT),
        });
    }

    /** FlowDraftPanel 提供的清单容器 */
    private listEl: HTMLDivElement | null = null;
    /** 全部草稿节点（NODE_KIND.DRAFT） */
    private drafts: DraftEntry[] = [];
    /** 左栏日历选中的日期（YYYY-MM-DD） */
    private selectedDate = todayIso();
    private selectedDraftId: string | null = null;
    /** 当前草稿解析出来的 AST；编辑都改它，再序列化写回正文 */
    private ast: FlowScript | null = null;
    private unsub: (() => void) | null = null;
    /** 草稿文件（文件基准通道）变化的订阅 */
    private unsubFiles: (() => void) | null = null;
    private saveTimer: number | null = null;

    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<FlowDraftState>({
        selectedDate: this.selectedDate,
        markedDates: [],
        dayDrafts: [],
        selectedDraftId: null,
        title: '未新建',
        saveState: '',
        hasDraft: false,
    });

    constructor(
        leaf: WorkspaceLeaf,
        /** 新建草稿节点要用设置里的数据根目录 */
        private plugin: SeqtkPlugin,
        /** 数据面唯一入口（草稿节点的读写都经它） */
        private pipe: DataPipe,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_FLOW_DRAFT;
    }

    getDisplayText(): string {
        return '流程草稿';
    }

    getIcon(): string {
        return 'calendar-range';
    }

    /** 渲染件在 FlowDraftPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(FlowDraftPanel, {
            state: this.state,
            onSelectDraft: (id: string) => this.selectDraft(id),
            onDraftContextMenu: (id: string, e: globalThis.MouseEvent) => {
                const draft = this.drafts.find((d) => d.nodeId === id);
                if (draft) this.showDraftMenu(e, draft);
            },
            onPickDate: (date: string) => this.pickDate(date),
            onCreateOnDate: () => this.createDraft(),
            onAddPoint: () => this.addItem('point'),
            onAddSpan: () => this.addItem('span'),
            onSortByTime: () => this.sortItems(),
            onListReady: (container: HTMLDivElement) => {
                this.listEl = container;
                void this.loadData();
            },
            onListDispose: () => { this.listEl = null; },
        });
    }

    protected onMounted(): void {
        // 订阅节点缓存：关联节点（事务 / 证据）的改名 / 删除要刷新条目上的引用显示。
        // 草稿自身不在缓存里，它的变化走文件事件那条线（见下）
        this.unsub = this.pipe.SUB_ActiveView(() => {
            if (!this.pipe.isInitialized) return;
            this.renderList();
        });
        // 草稿是**文件基准**节点：新建 / 改名 / 删除都只体现为文件变化，
        // 缓存订阅永远不会响 —— 不订阅这个，左栏就停在首次加载的样子
        this.unsubFiles = this.pipe.SUB_FileChange((kind) => {
            if (kind === NODE_KIND.DRAFT) void this.loadData();
        });
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubFiles?.();
        this.unsubFiles = null;
        this.FLUSH_Session();
    }

    // ============================================================
    // 数据：草稿节点 ⇄ 状态
    // ============================================================

    /**
     * 拉取全部草稿（**异步**：扫盘）
     *
     * 草稿是文件基准节点，取它只能扫盘。失败时**保留现有列表**并记日志 ——
     * 先清空再拉的话，扫描是异步的，中间那一帧会闪出「一份草稿都没有」。
     */
    private async loadData(): Promise<void> {
        let files: NodeFile[];
        try {
            files = await this.pipe.SCAN_Files([NODE_KIND.DRAFT]);
        } catch (e) {
            console.error('[SeqTK] 扫描流程草稿失败:', e);
            return;
        }
        this.drafts = files;
        // 选中项没了（被删）→ 退到当前日期命中的第一份；那天没有就清空
        const ids = new Set(this.drafts.map((d) => d.nodeId));
        if (this.selectedDraftId && !ids.has(this.selectedDraftId)) this.selectedDraftId = null;
        if (!this.selectedDraftId) this.selectedDraftId = this.dayEntries()[0]?.nodeId ?? null;
        this.reloadAst();
        this.renderAll();
    }

    /** 一份草稿覆盖的日期区间（看 `#STF` / `#ENF` 两条约束） */
    private rangeOf(entry: DraftEntry): { from: string; to: string } {
        const ast = parseFlowScript(entry.body);
        const from = guardDate(ast, 'STF') ?? todayIso();
        return { from, to: guardDate(ast, 'ENF') ?? from };
    }

    /**
     * 某一天命中的草稿
     *
     * 单日草稿是精确相等；跨日的（循环草稿）落在区间内就算 —— 于是在日历上，
     * 一个跨日草稿会让区间里的每一天都打上点，这正合「这几天都归它管」的语义。
     */
    private entriesOn(date: string): DraftEntry[] {
        return this.drafts.filter((d) => {
            const { from, to } = this.rangeOf(d);
            const lo = from <= to ? from : to;
            const hi = from <= to ? to : from;
            return lo <= date && date <= hi;
        });
    }

    /** 当前日期命中的草稿（按标题排序，顺序稳定） */
    private dayEntries(): DraftEntry[] {
        return this.entriesOn(this.selectedDate)
            .slice()
            .sort((a, b) => a.data.desc.localeCompare(b.data.desc));
    }

    /** 解析选中草稿的正文（正文在扫描时已经一并取回，不必再读一次） */
    private reloadAst(): void {
        const entry = this.selectedNode;
        this.ast = entry ? parseFlowScript(entry.body) : null;
    }

    private get selectedNode(): DraftEntry | undefined {
        return this.drafts.find((d) => d.nodeId === this.selectedDraftId);
    }

    /** AST 改动 → 安排防抖写回正文 */
    private commitAst(): void {
        if (!this.ast || !this.selectedDraftId) return;
        this.state.set({ ...this.state.get(), saveState: '保存中…' });
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            this.FLUSH_Session();
        }, SAVE_DEBOUNCE);
    }

    /** 立刻把当前 AST 写回正文（防抖到期 / 切草稿 / 关视图时调用） */
    public FLUSH_Session(): void {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        const id = this.selectedDraftId;
        const entry = this.selectedNode;
        if (!id || !entry || !this.ast) return;
        this.pipe.EXEC_Mutation({
            op: 'setBody',
            kind: entry.data.kind,
            nodeId: id,
            body: serializeFlowScript(this.ast),
        });
        const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        this.state.set({ ...this.state.get(), saveState: `已保存 ${now}` });
    }

    /** 同步日历打点、当日草稿列表与工具栏标题 */
    private syncState(): void {
        const rows: FlowDraftRow[] = this.dayEntries().map((d) => ({
            id: d.nodeId,
            title: d.data.desc,
            meta: `${this.itemCount(d)} 条`,
        }));

        // 日历打点：把每份草稿覆盖的日期逐日摊开。用 Date 逐日推进（不做毫秒加法），
        // 跨夏令时也不会偏一天
        const pad = (n: number): string => String(n).padStart(2, '0');
        const keyOf = (dt: Date): string => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        const marked = new Set<string>();
        for (const d of this.drafts) {
            const { from, to } = this.rangeOf(d);
            const lo = from <= to ? from : to;
            const hi = from <= to ? to : from;
            const cur = new Date(`${lo}T00:00:00`);
            const end = new Date(`${hi}T00:00:00`);
            while (cur.getTime() <= end.getTime()) {
                marked.add(keyOf(cur));
                cur.setDate(cur.getDate() + 1);
            }
        }

        const entry = this.selectedNode;
        this.state.set({
            selectedDate: this.selectedDate,
            markedDates: [...marked].sort(),
            dayDrafts: rows,
            selectedDraftId: this.selectedDraftId,
            title: entry ? entry.data.desc : '未新建',
            saveState: this.state.get().saveState,
            hasDraft: !!entry,
        });
    }

    /** 一份草稿的条目数 */
    private itemCount(entry: DraftEntry): number {
        return parseFlowScript(entry.body).statements.length;
    }

    private renderAll(): void {
        this.syncState();
        this.renderList();
    }

    // ============================================================
    // 左栏：草稿的增删改（列表与日历在 FlowDraftPanel）
    // ============================================================

    private showDraftMenu(e: MouseEvent, draft: DraftEntry): void {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('重命名').setIcon('pencil')
            .onClick(() => this.renameDraft(draft)));
        menu.addItem((item) => item.setTitle('打开文件').setIcon('file-text')
            .onClick(() => this.openNodeFile(draft.nodeId, draft.data.kind)));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle('删除').setIcon('trash')
            .onClick(() => this.deleteDraft(draft)));
        menu.showAtMouseEvent(e);
    }

    /** 新建草稿：建一个 DRAFT 节点，正文预置「日历选中那一天」的 #STF / #ENF */
    private createDraft(): void {
        new TransactionCreateModal(this.app, {
            kinds: [NODE_KIND.DRAFT],
            onSubmit: (input) => {
                const now = new Date().toISOString();
                // 建在日历当前选中的那一天，而不是「今天」—— 在别的日子上点新建就该建在那天
                const date = this.selectedDate;
                const body = [
                    `#STF @${compact(date)}-0000`,
                    `#ENF @${compact(date)}-2359`,
                ].join('\n');
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    create: now,
                    modify: now,
                } as SeqtkNode;
                void this.pipe.EXEC_Create({ kind: input.kind, data, body }).then((nodeId) => {
                    this.selectedDraftId = nodeId;
                    this.loadData();
                }).catch((e: unknown) => {
                    console.error('[SeqTK] 新建流程草稿失败:', e);
                    new Notice('新建流程草稿失败，请查看控制台');
                });
            },
        }).open();
    }

    /** 在日历上选一天：切过去，并选中那天命中的第一份草稿 */
    private pickDate(date: string): void {
        if (this.selectedDate === date) return;
        this.FLUSH_Session();
        this.selectedDate = date;
        this.selectedDraftId = this.dayEntries()[0]?.nodeId ?? null;
        this.reloadAst();
        this.renderAll();
    }

    private selectDraft(id: string): void {
        if (this.selectedDraftId === id) return;
        // 切换前先把上一份的改动落盘，免得丢
        this.FLUSH_Session();
        this.selectedDraftId = id;
        this.reloadAst();
        this.renderAll();
    }

    private renameDraft(draft: DraftEntry): void {
        new DraftPromptModal(this.app, {
            title: '重命名流程草稿',
            initialValue: draft.data.desc,
            onOk: (title) => {
                this.pipe.EXEC_Mutation({
                    op: 'update',
                    kind: draft.data.kind,
                    nodeId: draft.nodeId,
                    updates: { desc: title, modify: new Date().toISOString() },
                });
                this.loadData();
            },
        }).open();
    }

    private deleteDraft(draft: DraftEntry): void {
        new DraftConfirmModal(this.app, {
            title: '删除流程草稿',
            message: `确定删除草稿「${draft.data.desc}」？\n这会连同节点文件一起移除，且不可撤销。`,
            onConfirm: () => {
                this.pipe.EXEC_Mutation({ op: 'remove', kind: draft.data.kind, nodeId: draft.nodeId });
                if (this.selectedDraftId === draft.nodeId) this.selectedDraftId = null;
                this.loadData();
            },
        }).open();
    }

    // ============================================================
    // 右栏：线性清单（命令式 DOM）
    // ============================================================

    private renderList(): void {
        const host = this.listEl;
        if (!host) return;
        host.empty();

        if (!this.selectedDraftId) {
            const empty = host.createDiv('seqtk-draft-board-empty');
            empty.createEl('div', { text: '还没有选中草稿' });
            empty.createEl('div', { cls: 'seqtk-draft-board-empty-sub', text: '在左侧日历上选一天，点「在这天新建」开始' });
            return;
        }

        const ast = this.ast;
        if (!ast) return;
        if (ast.errors.length > 0) {
            host.createEl('div', { cls: 'seqtk-draft-board-empty-sub', text: '这份草稿的正文解析失败，请在节点文件里修正：' });
            for (const err of ast.errors) {
                host.createEl('div', { cls: 'seqtk-flow-err', text: `第 ${err.line} 行：${err.message}` });
            }
            return;
        }

        this.renderDayRow(host, ast);
        const list = host.createDiv('seqtk-draft-items');
        if (ast.statements.length === 0) {
            list.createEl('div', { cls: 'seqtk-draft-items-empty', text: '这一日还没有条目 —— 用上方按钮加一个时点或时段' });
        }
        ast.statements.forEach((s, i) => this.renderItem(list, s, i));
    }

    /** 顶部：这份草稿覆盖的日期（跨多日即循环草稿） */
    private renderDayRow(host: HTMLElement, ast: FlowScript): void {
        const row = host.createDiv('seqtk-draft-dayrow');
        row.createEl('span', { cls: 'seqtk-draft-time-label', text: '日期' });
        const input = row.createEl('input', { cls: 'seqtk-draft-time-input', attr: { type: 'date' } });
        input.value = guardDate(ast, 'STF') ?? todayIso();
        input.addEventListener('change', () => {
            if (!input.value) return;
            this.setDraftDate(ast, input.value);
            this.commitAst();
            this.syncState();
        });
        setTooltip(row, '这份草稿覆盖的那一天。要表达跨日的循环事项，可直接改节点正文里的 #STF / #ENF。');
    }

    /**
     * 改草稿的日期
     *
     * `#STF` / `#ENF` 与**条目的时间戳日期一起挪** —— 否则把草稿从 8/24 改到 8/25 后，
     * 条目还留在 8/24，清单上就会出现「这一天里排着别的日期的条目」。
     */
    private setDraftDate(ast: FlowScript, date: string): void {
        const upsert = (kind: 'STF' | 'ENF', hhmm: string): void => {
            const value = stampOf(date, `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`);
            const g = ast.guards.find((x) => x.kind === kind);
            if (g) g.value = value;
            else ast.guards.push({ line: 0, kind, value });
        };
        upsert('STF', '0000');
        upsert('ENF', '2359');

        for (const s of ast.statements) {
            if (s.branch.kind !== 'AT') continue;
            const at = s.branch.time;
            const to = s.branch.toTime;
            setItemTime(
                s,
                at && at.kind === 'stamp' ? { kind: 'stamp', date: compact(date), time: at.time } : (at ?? stampOf(date, '00:00')),
                to && to.kind === 'stamp' ? { kind: 'stamp', date: compact(date), time: to.time } : to,
            );
        }
    }

    /** 一条条目：时间（时点或时段）+ 关联节点 + 操作 */
    private renderItem(list: HTMLElement, stmt: Statement, idx: number): void {
        const isSpan = stmt.branch.to !== undefined;
        const row = list.createDiv(`seqtk-draft-item seqtk-draft-item-${isSpan ? 'span' : 'point'}`);
        const date = guardDate(this.ast ?? parseFlowScript(''), 'STF') ?? this.selectedDate;

        // ── 时间 ──
        const time = row.createDiv('seqtk-draft-item-time');
        if (stmt.branch.kind === 'AT') {
            const at = timeOfDay(stmt.branch.time);
            this.timeInput(time, at, (v) => {
                setItemTime(stmt, stampOf(date, v),
                    stmt.branch.toTime ? stampOf(date, timeOfDay(stmt.branch.toTime) || v) : undefined);
                this.commitAst();
            });
            if (isSpan) {
                time.createEl('span', { cls: 'seqtk-draft-arrow', text: '→' });
                const to = timeOfDay(stmt.branch.toTime);
                this.timeInput(time, to, (v) => {
                    setItemTime(stmt, stmt.branch.time ?? stampOf(date, v), stampOf(date, v));
                    this.commitAst();
                });
            }
        } else {
            // 草稿只产出 AT；其它分支是手工改过正文留下的 —— 如实标出来，不偷偷改写
            time.createEl('span', { cls: 'seqtk-draft-item-odd', text: `（${stmt.branch.kind}）` });
        }

        // ── 关联节点 ──
        const refEl = row.createDiv('seqtk-draft-node-ref');
        this.renderNodeRef(refEl, stmt);

        // ── 操作 ──
        const actions = row.createDiv('seqtk-draft-item-actions');
        const iconBtn = (icon: string, label: string, danger: boolean, onClick: () => void): void => {
            actions.createEl('button', {
                cls: 'seqtk-draft-icon-btn' + (danger ? ' seqtk-draft-icon-danger' : ''),
                attr: { 'aria-label': label },
            }, (btn) => {
                setIcon(btn, icon);
                setTooltip(btn, label);
                btn.addEventListener('click', onClick);
            });
        };
        iconBtn('link', '关联节点', false, () => this.pickNode(stmt));
        if (itemNodeId(stmt) !== undefined) {
            iconBtn('unlink', '解除关联', true, () => {
                setItemNode(stmt, undefined);
                this.commitAst();
                this.renderList();
            });
        }
        iconBtn('chevron-up', '上移', false, () => this.moveItem(idx, -1));
        iconBtn('chevron-down', '下移', false, () => this.moveItem(idx, 1));
        iconBtn('x', '删除条目', true, () => this.removeItem(idx));
    }

    /** 一个 `HH:mm` 输入；改动即写回 AST */
    private timeInput(parent: HTMLElement, value: string, onChange: (v: string) => void): void {
        const input = parent.createEl('input', { cls: 'seqtk-draft-time-input', attr: { type: 'time' } });
        input.value = value;
        input.addEventListener('change', () => {
            if (input.value) onChange(input.value);
        });
    }

    /** 条目上的关联节点标签（可点开文件） */
    private renderNodeRef(el: HTMLElement, stmt: Statement): void {
        el.empty();
        const ref = itemNodeId(stmt);
        if (ref === undefined) {
            el.createEl('span', { cls: 'seqtk-draft-node-name seqtk-draft-node-placeholder', text: '未关联' });
            return;
        }
        if (!this.pipe.isInitialized) {
            el.createEl('span', { cls: 'seqtk-draft-node-name', text: '节点未载入' });
            return;
        }
        const node = this.pipe.GET_Node(ref);
        if (!node) {
            el.addClass('is-missing');
            el.createEl('span', { cls: 'seqtk-draft-node-name', text: '节点不存在' });
            return;
        }
        el.createEl('span', {
            cls: `seqtk-kind-badge ${GET_KindClass(node.kind)}`,
            text: NODE_KIND_LABELS[node.kind],
        });
        el.createEl('span', { cls: 'seqtk-draft-node-name', text: node.desc });
        el.addClass('seqtk-draft-node-ref-linked');
        setTooltip(el, `${node.desc}\n${ref}\n点击打开节点文件`);
        el.addEventListener('click', () => this.openNodeFile(ref, node.kind));
    }

    // ============================================================
    // 条目操作（都改 AST，再经 commitAst 写回正文）
    // ============================================================

    /**
     * 加一个条目
     *
     * 时点取当前整点、时段取「当前整点 ~ 下一个整点」。**日期用草稿那一天** ——
     * 条目时间戳里的日期与 `#STF` 保持一致，清单上才不会出现跨日的怪东西。
     */
    private addItem(kind: 'point' | 'span'): void {
        const ast = this.ast;
        if (!ast) return;
        const date = guardDate(ast, 'STF') ?? this.selectedDate;
        const pad = (n: number): string => String(n % 24).padStart(2, '0');
        const h = new Date().getHours();
        const at = stampOf(date, `${pad(h)}:00`);
        const line = ast.statements.reduce((max, s) => Math.max(max, s.line), 0) + 1;
        const stmt: Statement = {
            line,
            branch: kind === 'span'
                ? { kind: 'AT', arg: timeText(at), time: at }
                : { kind: 'AT', arg: timeText(at), time: at },
            block: [],
            braced: false,
            transfers: [],
        };
        if (kind === 'span') {
            const to = stampOf(date, `${pad(h + 1)}:00`);
            setItemTime(stmt, at, to);
        }
        ast.statements.push(stmt);
        this.commitAst();
        this.renderList();
    }

    private removeItem(idx: number): void {
        const ast = this.ast;
        if (!ast) return;
        ast.statements.splice(idx, 1);
        this.commitAst();
        this.renderList();
    }

    private moveItem(idx: number, dir: -1 | 1): void {
        const ast = this.ast;
        if (!ast) return;
        const j = idx + dir;
        if (j < 0 || j >= ast.statements.length) return;
        const [moved] = ast.statements.splice(idx, 1);
        ast.statements.splice(j, 0, moved);
        this.commitAst();
        this.renderList();
    }

    /** 按时点 / 时段起点排序（没有时间的条目排尾部） */
    private sortItems(): void {
        const ast = this.ast;
        if (!ast) return;
        const key = (s: Statement): string => itemKey(s);
        ast.statements = ast.statements
            .map((s, i) => ({ s, i }))
            .sort((a, b) => (key(a.s) !== key(b.s) ? key(a.s).localeCompare(key(b.s)) : a.i - b.i))
            .map((x) => x.s);
        this.commitAst();
        this.renderList();
    }

    private pickNode(stmt: Statement): void {
        if (!this.pipe.isInitialized) {
            new Notice('节点缓存尚未就绪，请稍后再试');
            return;
        }
        new NodePickModal(this.app, this.pipe, (nodeId) => {
            setItemNode(stmt, nodeId);
            this.commitAst();
            this.renderList();
        }).open();
    }

    private openNodeFile(nodeId: string, kind: NodeKindValue): void {
        const filePath = GET_FileByPath(kind, nodeId, this.plugin.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
        else new Notice('未找到节点文件');
    }
}
