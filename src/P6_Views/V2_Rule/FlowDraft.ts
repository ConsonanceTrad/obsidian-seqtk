/**
 * FlowDraftView — 规则设计 · 流程草稿
 *
 * 双栏：
 * - 左栏：草稿列表（新建 / 切换 / 重命名 / 删除）
 * - 右栏：泳道板 —— 一条草稿含多条并行事件轴（横向并列、横向滚动），
 *   每条事件轴持有轴级「起止时间段」，自上而下排列顺序块；块可拖拽
 *   重排 / 跨轴移动，按编号或按轴起止时间对泳道排序。
 *
 * 定位（与流程设计 / 流程推送区分）：
 * - 纯 UI 草稿，无专属语法、不涉及提醒
 * - 数据持久化：rootFolder/flow-drafts.json（DraftStore），不创建、不修改任何节点
 *
 * 逻辑与渲染分离：
 * - 本文件（逻辑）：数据搬运（草稿 CRUD）、防抖保存，以及 **泳道板的命令式 DOM 逻辑**；
 * - FlowDraftPanel.tsx（渲染）：左栏草稿列表 + 右栏工具栏 + 泳道板容器。
 *
 * 泳道板（横向泳道 + 块拖拽重排 / 跨轴移动 + 局部刷新）约 550 行命令式 DOM，
 * 与 FlowDesign 的 LAD 编辑器同理：React 只出容器，命令式资源不进渲染树。
 */

import { GET_KindClass } from "../../P4_Nodes/NodeKind/KindColors";
import { createElement, type ReactNode } from "react";
import { Menu, Modal, Notice, Setting, TextComponent, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { DraftStore } from "../../P2_Tools/Script/DraftStore";
import {
    createEventAxis,
    createFlowDraft,
    createTimeBlock,
    genDraftId,
    sortAxesByTime,
} from "../../P2_Tools/Script/Draft";
import { FlowDraftPanel, type FlowDraftRow, type FlowDraftState } from "./FlowDraftPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { SeqtkNode } from "../../P4_Nodes/Node";
import type { EventAxis, FlowDraft, TimeBlock } from "../../P2_Tools/Script/Draft";

export const VIEW_TYPE_FLOW_DRAFT = 'seqtk-flow-draft';

/** 自动保存防抖（毫秒） */
const SAVE_DEBOUNCE = 500;

// ============================================================
// 时间工具（ISO ↔ datetime-local、时长文本）
// ============================================================

/** ISO → datetime-local input value（本地时区，无秒） */
function isoToInput(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local input value → ISO（本地时区解释）；空串/非法返回 undefined */
function inputToIso(value: string): string | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
}

/** 时长友好文本（如 2h 30m / 1d 3h），缺起止返回 '-' */
function spanText(from?: string, to?: string): string {
    if (!from || !to) return '-';
    const ms = new Date(to).getTime() - new Date(from).getTime();
    if (Number.isNaN(ms) || ms < 0) return '反向';
    const totalMin = Math.round(ms / 60000);
    if (totalMin === 0) return '<1m';
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    const parts: string[] = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    return parts.join(' ');
}

// ============================================================
// 通用弹窗（文本输入 / 确认 / 节点选择），本视图专用
// ============================================================

/** 文本输入弹窗（用于标题等） */
class DraftPromptModal extends Modal {
    constructor(
        app: any,
        private opts: {
            title: string;
            placeholder?: string;
            initialValue?: string;
            onOk: (value: string) => void;
        },
    ) {
        super(app);
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
        app: any,
        private opts: {
            title: string;
            message: string;
            confirmText?: string;
            onConfirm: () => void;
        },
    ) {
        super(app);
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
 * 仅用于把节点「只读关联」到顺序块，不修改节点本身。
 */
class NodePickModal extends Modal {
    private searchInput!: HTMLInputElement;
    private listEl!: HTMLElement;
    private emptyEl: HTMLElement | null = null;
    private searchTimer: number | null = null;

    constructor(
        app: any,
        private pipe: DataPipe,
        private onPick: (nodeId: string) => void,
    ) {
        super(app);
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
        this.emptyEl = contentEl.createDiv('seqtk-draft-node-empty');

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
        const q = query.trim();
        const results = this.pipe.SEARCH_Nodes(q, 50);
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
        {viewType: VIEW_TYPE_FLOW_DRAFT, title: '流程草稿', icon: 'calendar-range', description: '草稿板：多条并行事件轴，时间块起止用于快速敲定时间；块可只读关联节点或直接输入文本。无专属语法、不涉及提醒。', category: '规则设计'},
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

    private draftStore: DraftStore;
    /** FlowDraftPanel 提供的泳道板容器 */
    private boardEl: HTMLDivElement | null = null;

    private drafts: FlowDraft[] = [];
    private selectedDraftId: string | null = null;
    private unsub: (() => void) | null = null;
    private saveTimer: number | null = null;
    private loaded = false;

    // 拖拽状态
    private dragInfo: { axisId: string; blockId: string } | null = null;
    private dropTarget: { axisId: string; insertBeforeId: string | null } | null = null;

    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<FlowDraftState>({
        drafts: [],
        selectedDraftId: null,
        title: '流程草稿',
        saveState: '',
        hasDraft: false,
    });

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: SeqtkPlugin,
        /** 数据面唯一入口（节点只读 + 草稿文件读写都经它） */
        private pipe: DataPipe,
    ) {
        super(leaf);
        this.draftStore = new DraftStore(pipe);
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
            onCreateDraft: () => this.createDraft(),
            onSelectDraft: (id: string) => this.selectDraft(id),
            onDraftContextMenu: (id: string, e: globalThis.MouseEvent) => {
                const draft = this.drafts.find((d) => d.id === id);
                if (draft) this.showDraftMenu(e, draft);
            },
            onLeftBlankContextMenu: () => this.createDraft(),
            onSortByTime: (desc: boolean) => this.applyTimeSort(desc),
            onAddAxis: () => this.addAxis(),
            onAddBlock: () => {
                const target = this.selectedDraft?.axes[0];
                if (target) this.addBlock(target.id);
                else new Notice('请先添加事件轴');
            },
            onBoardReady: (container: HTMLDivElement) => {
                this.boardEl = container;
                void this.loadData();
            },
            onBoardDispose: () => { this.boardEl = null; },
        });
    }

    protected onMounted(): void {
        // 订阅节点缓存：就绪后重绘左栏（依赖 nodeCache 的列表），并刷新块内节点引用显示
        this.unsub = this.pipe.SUB_ActiveView(() => {
            if (!this.loaded) return;
            if (!this.pipe.isInitialized) return;
            this.syncState();
            this.refreshNodeRefs();
        });
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
        void this.flushSave();
    }

    private async loadData(): Promise<void> {
        this.drafts = await this.draftStore.load();
        this.loaded = true;
        if (this.drafts.length > 0 && !this.drafts.some((d) => d.id === this.selectedDraftId)) {
            this.selectedDraftId = this.drafts[0].id;
        }
        this.renderAll();
    }

    // ============================================================
    // 状态辅助
    // ============================================================

    private get selectedDraft(): FlowDraft | undefined {
        return this.drafts.find((d) => d.id === this.selectedDraftId);
    }

    /** 标记当前草稿已修改并安排防抖保存 */
    private markModified(): void {
        const d = this.selectedDraft;
        if (!d) return;
        d.modify = new Date().toISOString();
        this.setSaveState('保存中…');
        if (this.saveTimer) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => void this.flushSave(), SAVE_DEBOUNCE);
    }

    private async flushSave(): Promise<void> {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.draftStore.save(this.drafts);
        this.setSaveState(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    }

    private setSaveState(text: string): void {
        this.state.set({ ...this.state.get(), saveState: text });
    }

    /** 同步左栏列表与工具栏标题到渲染件 */
    private syncState(): void {
        const rows: FlowDraftRow[] = this.drafts.map((d) => ({
            id: d.id,
            title: d.title,
            axes: d.axes.length,
            blocks: d.axes.reduce((s, a) => s + a.blocks.length, 0),
        }));
        const d = this.selectedDraft;
        this.state.set({
            drafts: rows,
            selectedDraftId: this.selectedDraftId,
            title: d ? d.title : '流程草稿',
            saveState: this.state.get().saveState,
            hasDraft: !!d,
        });
    }

    /** 全量重渲染（草稿切换 / 增删排序后调用） */
    private renderAll(): void {
        this.syncState();
        this.renderBoard();
    }

    // ============================================================
    // 左栏：草稿列表（数据 → 状态）
    // ============================================================

    private showDraftMenu(e: MouseEvent, draft: FlowDraft): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item.setTitle('重命名').setIcon('pencil')
                .onClick(() => this.renameDraft(draft)));
        menu.addItem((item) =>
            item.setTitle('删除草稿').setIcon('trash')
                .onClick(() => this.deleteDraft(draft)));
        menu.showAtMouseEvent(e);
    }

    private createDraft(): void {
        new DraftPromptModal(this.app, {
            title: '新建流程草稿',
            placeholder: '草稿标题（如：本周推进计划）',
            initialValue: `草稿 ${this.drafts.length + 1}`,
            onOk: (title) => {
                const draft = createFlowDraft(title);
                this.drafts.push(draft);
                this.selectedDraftId = draft.id;
                this.renderAll();
                void this.flushSave();
            },
        }).open();
    }

    private selectDraft(id: string): void {
        if (this.selectedDraftId === id) return;
        this.selectedDraftId = id;
        this.clearDropIndicators();
        this.renderAll();
    }

    private renameDraft(draft: FlowDraft): void {
        new DraftPromptModal(this.app, {
            title: '重命名草稿',
            initialValue: draft.title,
            onOk: (title) => {
                draft.title = title;
                this.markModified();
                this.renderAll();
            },
        }).open();
    }

    private deleteDraft(draft: FlowDraft): void {
        const nBlocks = draft.axes.reduce((s, a) => s + a.blocks.length, 0);
        new DraftConfirmModal(this.app, {
            title: '删除草稿',
            message: `确定删除草稿「${draft.title}」？将同时移除其 ${draft.axes.length} 条事件轴、${nBlocks} 个顺序块。此操作不可撤销。`,
            onConfirm: () => {
                this.drafts = this.drafts.filter((x) => x.id !== draft.id);
                if (this.selectedDraftId === draft.id) {
                    this.selectedDraftId = this.drafts[0]?.id ?? null;
                }
                this.renderAll();
                void this.flushSave();
            },
        }).open();
    }

    // ============================================================
    // 泳道板（右栏主体，命令式 DOM）
    // ============================================================

    private renderBoard(): void {
        const board = this.boardEl;
        if (!board) return;
        this.clearDropIndicators();
        board.empty();
        const d = this.selectedDraft;
        if (!d) {
            const empty = board.createDiv('seqtk-draft-board-empty');
            empty.createEl('div', { text: '还没有草稿' });
            empty.createEl('div', { cls: 'seqtk-draft-board-empty-sub', text: '在左侧新建一条流程草稿，开始快速敲定时间' });
            return;
        }
        for (const axis of d.axes) {
            this.renderLane(board, axis);
        }
    }

    private renderLane(board: HTMLElement, axis: EventAxis): void {
        const lane = board.createDiv('seqtk-draft-lane');
        lane.dataset.axisId = axis.id;

        // ── 轴头 ──
        const head = lane.createDiv('seqtk-draft-lane-head');
        head.createEl('span', { cls: 'seqtk-draft-lane-title', text: axis.title });
        head.createEl('button', { cls: 'seqtk-draft-icon-btn', attr: { 'aria-label': '重命名轴' } }, (btn) => {
            setIcon(btn, 'pencil');
            btn.addEventListener('click', () => this.renameAxis(axis.id));
        });
        const moveBtn = (dir: -1 | 1, icon: string, label: string): void => {
            head.createEl('button', { cls: 'seqtk-draft-icon-btn', attr: { 'aria-label': label } }, (btn) => {
                setIcon(btn, icon);
                btn.addEventListener('click', () => this.moveAxis(axis.id, dir));
            });
        };
        moveBtn(-1, 'chevron-left', '左移事件轴');
        moveBtn(1, 'chevron-right', '右移事件轴');
        head.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-icon-danger', attr: { 'aria-label': '删除事件轴' } }, (btn) => {
            setIcon(btn, 'trash-2');
            btn.addEventListener('click', () => this.deleteAxis(axis.id));
        });

        // ── 轴级时间段（轴持有起止，用于快速敲定时间） ──
        this.renderAxisTimeArea(lane, axis);

        // ── 轴体（顺序块列表；drag 事件委派到此处统一处理插入位） ──
        const body = lane.createDiv('seqtk-draft-lane-body');
        body.dataset.axisId = axis.id;

        for (const block of axis.blocks) {
            this.renderBlock(board, axis, block);
        }

        if (axis.blocks.length === 0) {
            const emptyHint = body.createDiv('seqtk-draft-lane-empty');
            emptyHint.textContent = '空轴 — 把块拖到这里，或添加顺序块';
        }

        const addBtn = body.createEl('button', { cls: 'seqtk-btn seqtk-btn-small seqtk-draft-add-block', text: '+ 顺序块' });
        addBtn.addEventListener('click', () => this.addBlock(axis.id));

        this.attachLaneDrag(body, axis.id);
    }

    /** 轴级时间段编辑区：起/止 datetime-local（可缺省）+ 快捷 chips + 时长 */
    private renderAxisTimeArea(lane: HTMLElement, axis: EventAxis): void {
        const area = lane.createDiv('seqtk-draft-lane-times');
        this.renderAxisTimeRow(area, '起', axis, 'from');
        this.renderAxisTimeRow(area, '止', axis, 'to');
        const metaRow = area.createDiv('seqtk-draft-meta-row');
        metaRow.createEl('span', { cls: 'seqtk-draft-time-label', text: '时长' });
        metaRow.createEl('span', { cls: 'seqtk-draft-span', text: spanText(axis.from, axis.to) });

        // 快捷敲定「起」：未设止或止早于起时自动补 +1h
        const chips = area.createDiv('seqtk-draft-chips');
        const quick: { label: string; offsetMin: number; tip: string }[] = [
            { label: '现在', offsetMin: 0, tip: '起 = 此刻' },
            { label: '明天', offsetMin: 24 * 60, tip: '起 = 24 小时后' },
            { label: '+30分', offsetMin: 30, tip: '起 = 30 分钟后' },
            { label: '+1时', offsetMin: 60, tip: '起 = 1 小时后' },
            { label: '+1天', offsetMin: 24 * 60, tip: '起 = 1 天后' },
        ];
        for (const q of quick) {
            const chip = chips.createEl('button', { cls: 'seqtk-draft-chip', text: q.label });
            setTooltip(chip, `${q.tip}；止为空或早于起时自动顺延 1 小时`);
            chip.addEventListener('click', () => this.applyQuickStart(axis.id, q.offsetMin));
        }
    }

    /** 顺序块卡片 */
    private renderBlock(board: HTMLElement, axis: EventAxis, block: TimeBlock): void {
        const body = board.querySelector<HTMLElement>(`.seqtk-draft-lane-body[data-axis-id="${axis.id}"]`);
        if (!body) return;
        const bodyEmpty = body.querySelector('.seqtk-draft-lane-empty');
        if (bodyEmpty) bodyEmpty.remove();

        const idx = axis.blocks.findIndex((b) => b.id === block.id);
        const card = body.createDiv('seqtk-draft-block');
        card.dataset.blockId = block.id;
        card.draggable = true;

        // ── 首行：编号 + 拖拽把手 + 关联节点 + 操作 ──
        const head = card.createDiv('seqtk-draft-block-head');
        head.createEl('span', { cls: 'seqtk-draft-index', text: `#${idx + 1}` });
        head.createEl('span', { cls: 'seqtk-draft-grip', attr: { 'aria-label': '拖拽排序' } }, (el) => {
            setIcon(el, 'grip-vertical');
        });

        const refEl = head.createDiv('seqtk-draft-node-ref');
        this.renderNodeRef(refEl, block);

        head.createEl('button', { cls: 'seqtk-draft-icon-btn', attr: { 'aria-label': '关联节点' } }, (btn) => {
            setIcon(btn, 'link');
            btn.addEventListener('click', () => this.pickNode(axis.id, block.id));
        });
        if (block.nodeId) {
            head.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-icon-danger', attr: { 'aria-label': '解除节点关联' } }, (btn) => {
                setIcon(btn, 'unlink');
                btn.addEventListener('click', () => this.clearNodeLink(block));
            });
        }
        head.createEl('button', { cls: 'seqtk-draft-icon-btn', attr: { 'aria-label': '复制块' } }, (btn) => {
            setIcon(btn, 'copy');
            btn.addEventListener('click', () => this.duplicateBlock(axis.id, block.id));
        });
        head.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-icon-danger', attr: { 'aria-label': '删除块' } }, (btn) => {
            setIcon(btn, 'x');
            btn.addEventListener('click', () => this.deleteBlock(axis.id, block.id));
        });

        // ── 步骤文本（块仅表示执行顺序，无自身时间） ──
        const textarea = card.createEl('textarea', {
            cls: 'seqtk-draft-text',
            attr: {
                rows: '2',
                placeholder: '步骤文本 / 备注…',
            },
        });
        textarea.value = block.text ?? '';
        textarea.addEventListener('input', () => {
            block.text = textarea.value;
            this.markModified();
        });

        // ── 拖拽 ──
        card.addEventListener('dragstart', (e) => {
            this.dragInfo = { axisId: axis.id, blockId: block.id };
            this.dropTarget = null;
            card.addClass('seqtk-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', block.id);
            }
        });
        card.addEventListener('dragend', () => {
            this.dragInfo = null;
            this.dropTarget = null;
            this.clearDropIndicators();
        });
    }

    /** 轴级时间输入行：label + datetime-local + 清除按钮；change 只更新模型不整表重渲染 */
    private renderAxisTimeRow(container: HTMLElement, label: string, axis: EventAxis, side: 'from' | 'to'): void {
        const row = container.createDiv('seqtk-draft-time-row');
        row.createEl('span', { cls: 'seqtk-draft-time-label', text: label });
        const input = row.createEl('input', {
            cls: 'seqtk-draft-time-input',
            attr: { type: 'datetime-local' },
        });
        input.value = isoToInput(axis[side]);
        input.addEventListener('change', () => {
            axis[side] = inputToIso(input.value);
            this.markModified();
            this.updateAxisMeta(axis.id);
        });
        row.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-clear-btn', attr: { 'aria-label': '清除' } }, (btn) => {
            setIcon(btn, 'x');
            btn.addEventListener('click', () => {
                axis[side] = undefined;
                input.value = '';
                this.markModified();
                this.updateAxisMeta(axis.id);
            });
        });
    }

    /** 渲染某块的「关联节点引用」标签（可点击跳文件） */
    private renderNodeRef(el: HTMLElement, block: TimeBlock): void {
        el.empty();
        if (!block.nodeId) {
            el.createEl('span', { cls: 'seqtk-draft-node-name seqtk-draft-node-placeholder', text: '未关联节点' });
            setTooltip(el, '点击右侧 关联 按钮选择节点');
            return;
        }
        const node = this.safeGetNode(block.nodeId);
        if (!node) {
            el.addClass('is-missing');
            const span = el.createEl('span', {
                cls: 'seqtk-draft-node-name',
                text: this.pipe.isInitialized ? '节点不存在（已删除或归档）' : '节点未载入（缓存未就绪）',
            });
            span.dataset.nodeId = block.nodeId;
            return;
        }
        el.createEl('span', {
            cls: `seqtk-kind-badge ${GET_KindClass(node.kind)}`,
            text: NODE_KIND_LABELS[node.kind],
        });
        const name = el.createEl('span', { cls: 'seqtk-draft-node-name', text: node.desc });
        name.dataset.nodeId = block.nodeId;
        el.addClass('seqtk-draft-node-ref-linked');
        el.addEventListener('click', () => this.openNodeFile(block.nodeId!));
        el.title = `${node.desc}\n${block.nodeId}\n点击打开节点文件`;
    }

    /** 局部刷新轴的时长文本（编辑起止时调用，不打断块输入焦点） */
    private updateAxisMeta(axisId: string): void {
        const board = this.boardEl;
        if (!board) return;
        const lane = board.querySelector<HTMLElement>(`.seqtk-draft-lane[data-axis-id="${axisId}"]`);
        if (!lane) return;
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!axis) return;
        const spanEl = lane.querySelector('.seqtk-draft-span');
        if (spanEl) spanEl.setText(spanText(axis.from, axis.to));
    }

    // ============================================================
    // 草稿 / 泳道 / 块的增删改
    // ============================================================

    private applyTimeSort(desc: boolean): void {
        const d = this.selectedDraft;
        if (!d) return;
        // 按轴级起止时间对泳道（事件轴左右顺序）排序，结果即新的手动顺序
        d.axes = sortAxesByTime(d.axes, desc);
        this.markModified();
        this.renderBoard();
    }

    private addAxis(): void {
        const d = this.selectedDraft;
        if (!d) return;
        new DraftPromptModal(this.app, {
            title: '新增事件轴',
            placeholder: '事件轴标题',
            initialValue: `事件轴 ${d.axes.length + 1}`,
            onOk: (title) => {
                d.axes.push(createEventAxis(title));
                this.markModified();
                this.renderBoard();
                if (this.boardEl) this.boardEl.scrollLeft = this.boardEl.scrollWidth;
            },
        }).open();
    }

    private renameAxis(axisId: string): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        new DraftPromptModal(this.app, {
            title: '重命名事件轴',
            initialValue: axis.title,
            onOk: (title) => {
                axis.title = title;
                this.markModified();
                this.renderBoard();
            },
        }).open();
    }

    private moveAxis(axisId: string, dir: -1 | 1): void {
        const d = this.selectedDraft;
        if (!d) return;
        const i = d.axes.findIndex((a) => a.id === axisId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.axes.length) return;
        const [axis] = d.axes.splice(i, 1);
        d.axes.splice(j, 0, axis);
        this.markModified();
        this.renderBoard();
    }

    private deleteAxis(axisId: string): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        new DraftConfirmModal(this.app, {
            title: '删除事件轴',
            message: `确定删除事件轴「${axis.title}」？将同时移除其中 ${axis.blocks.length} 个顺序块。`,
            onConfirm: () => {
                d.axes = d.axes.filter((a) => a.id !== axisId);
                this.markModified();
                this.renderBoard();
            },
        }).open();
    }

    private addBlock(axisId: string): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        const block = createTimeBlock();
        axis.blocks.push(block);
        this.markModified();
        this.renderBoard();
        // 聚焦新块的备注输入
        window.setTimeout(() => {
            const card = this.boardEl?.querySelector<HTMLElement>(`.seqtk-draft-block[data-block-id="${block.id}"]`);
            const ta = card?.querySelector<HTMLTextAreaElement>('.seqtk-draft-text');
            ta?.focus();
        }, 30);
    }

    private duplicateBlock(axisId: string, blockId: string): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        const i = axis.blocks.findIndex((b) => b.id === blockId);
        if (i < 0) return;
        const copy: TimeBlock = {
            ...axis.blocks[i],
            id: genDraftId('b'),
        };
        axis.blocks.splice(i + 1, 0, copy);
        this.markModified();
        this.renderBoard();
    }

    private deleteBlock(axisId: string, blockId: string): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        axis.blocks = axis.blocks.filter((b) => b.id !== blockId);
        this.markModified();
        this.renderBoard();
    }

    private pickNode(axisId: string, blockId: string): void {
        if (!this.pipe.isInitialized) {
            new Notice('节点缓存尚未就绪，请稍后再试');
            return;
        }
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        const block = axis?.blocks.find((b) => b.id === blockId);
        if (!d || !axis || !block) return;
        new NodePickModal(this.app, this.pipe, (nodeId) => {
            block.nodeId = nodeId;
            this.markModified();
            // 重建该卡（同步 head 中「解除关联」按钮的显隐）
            this.renderBoard();
        }).open();
    }

    /** 解除节点关联 */
    private clearNodeLink(block: TimeBlock): void {
        block.nodeId = undefined;
        this.markModified();
        // 重建该卡（同步移除「解除关联」按钮）
        this.renderBoard();
    }

    /** 快捷设定事件轴「起」；止为空或早于新起时自动补 1 小时 */
    private applyQuickStart(axisId: string, offsetMin: number): void {
        const d = this.selectedDraft;
        const axis = d?.axes.find((a) => a.id === axisId);
        if (!d || !axis) return;
        const from = new Date(Date.now() + offsetMin * 60000);
        axis.from = from.toISOString();
        if (!axis.to || new Date(axis.to).getTime() <= from.getTime()) {
            axis.to = new Date(from.getTime() + 3600000).toISOString();
        }
        this.markModified();
        // 刷新本轴时间输入值 + 时长
        const lane = this.boardEl?.querySelector<HTMLElement>(`.seqtk-draft-lane[data-axis-id="${axisId}"]`);
        if (lane) {
            const inputs = lane.querySelectorAll<HTMLInputElement>('.seqtk-draft-time-input');
            if (inputs[0]) inputs[0].value = isoToInput(axis.from);
            if (inputs[1]) inputs[1].value = isoToInput(axis.to);
            this.updateAxisMeta(axisId);
        }
    }

    /** 安全读取节点：缓存未初始化或读取异常时返回 undefined（避免渲染崩溃） */
    private safeGetNode(nodeId: string | undefined): SeqtkNode | undefined {
        if (!nodeId || !this.pipe.isInitialized) return undefined;
        try {
            return this.pipe.GET_Node(nodeId) ?? undefined;
        } catch (err) {
            console.warn('[SeqTK][Draft] 读取节点失败:', err);
            return undefined;
        }
    }

    private openNodeFile(nodeId: string): void {
        const node = this.safeGetNode(nodeId);
        if (!node) {
            new Notice('节点不存在或尚未载入缓存');
            return;
        }
        const filePath = GET_FileByPath(node.kind, nodeId, this.plugin.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file) {
            void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
        } else {
            new Notice('未找到节点文件');
        }
    }

    // ============================================================
    // 拖拽（同轴重排 / 跨轴移动）
    // ============================================================

    private attachLaneDrag(body: HTMLElement, axisId: string): void {
        body.addEventListener('dragover', (e) => {
            if (!this.dragInfo) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            const targetBlock = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-draft-block');
            if (targetBlock && targetBlock.parentElement === body) {
                // 上方 → 插入到该块前；下方 → 插入到该块后
                const rect = targetBlock.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                const targetId = targetBlock.dataset.blockId ?? null;
                this.setDropTarget(axisId, after ? this.nextBlockId(body, targetId) : targetId, targetBlock, after);
            } else {
                // 落在空白（轴尾/空轴）：插入到末尾
                this.setDropTarget(axisId, null, null, false);
            }
        });
        body.addEventListener('dragleave', (e) => {
            // 离开整个轴体时清空指示
            if (!body.contains(e.relatedTarget as Node)) {
                this.dropTarget = null;
                this.clearDropIndicators();
            }
        });
        body.addEventListener('drop', (e) => {
            e.preventDefault();
            const info = this.dragInfo;
            const target = this.dropTarget;
            this.dragInfo = null;
            this.dropTarget = null;
            this.clearDropIndicators();
            if (!info) return;
            if (target) {
                this.moveBlock(info.axisId, info.blockId, target.axisId, target.insertBeforeId);
            }
        });
    }

    /** 某块在 body 中的下一个块 id（用于「插入到该块后」定位） */
    private nextBlockId(body: HTMLElement, blockId: string | null): string | null {
        if (!blockId) return null;
        const cards = Array.from(body.querySelectorAll<HTMLElement>('.seqtk-draft-block'));
        const i = cards.findIndex((c) => c.dataset.blockId === blockId);
        return i >= 0 && i + 1 < cards.length ? (cards[i + 1].dataset.blockId ?? null) : null;
    }

    /** 设置插入目标并给出视觉指示 */
    private setDropTarget(axisId: string, insertBeforeId: string | null, anchorBlock: HTMLElement | null, after: boolean): void {
        if (this.dropTarget
            && this.dropTarget.axisId === axisId
            && this.dropTarget.insertBeforeId === insertBeforeId) {
            return;
        }
        this.dropTarget = { axisId, insertBeforeId };
        this.clearDropIndicators();
        if (anchorBlock) {
            if (after) anchorBlock.addClass('seqtk-drop-after');
            else anchorBlock.addClass('seqtk-drop-before');
        } else {
            // 落空区：给轴体加底色提示
            const body = this.boardEl?.querySelector<HTMLElement>(`.seqtk-draft-lane-body[data-axis-id="${axisId}"]`);
            body?.addClass('seqtk-drop-tail');
        }
    }

    private clearDropIndicators(): void {
        const board = this.boardEl;
        if (!board) return;
        board.querySelectorAll('.seqtk-drop-before').forEach((el) => el.removeClass('seqtk-drop-before'));
        board.querySelectorAll('.seqtk-drop-after').forEach((el) => el.removeClass('seqtk-drop-after'));
        board.querySelectorAll('.seqtk-drop-tail').forEach((el) => el.removeClass('seqtk-drop-tail'));
    }

    /** 移动块：从源轴移除，插入目标轴 insertBeforeId 之前（null = 末尾）；同轴自移时做等效定位 */
    private moveBlock(srcAxisId: string, blockId: string, dstAxisId: string, insertBeforeId: string | null): void {
        const d = this.selectedDraft;
        if (!d) return;
        const srcAxis = d.axes.find((a) => a.id === srcAxisId);
        const dstAxis = d.axes.find((a) => a.id === dstAxisId);
        if (!srcAxis || !dstAxis) return;
        const block = srcAxis.blocks.find((b) => b.id === blockId);
        if (!block) return;
        // 位置无变化（插到自身前 / 自身后紧邻）→ 不操作
        if (srcAxisId === dstAxisId) {
            const arr = srcAxis.blocks;
            const i = arr.findIndex((b) => b.id === blockId);
            const j = insertBeforeId ? arr.findIndex((b) => b.id === insertBeforeId) : arr.length;
            if (i === j || i + 1 === j) return;
        }
        srcAxis.blocks = srcAxis.blocks.filter((b) => b.id !== blockId);
        const idx = insertBeforeId ? dstAxis.blocks.findIndex((b) => b.id === insertBeforeId) : -1;
        if (idx < 0) dstAxis.blocks.push(block);
        else dstAxis.blocks.splice(idx, 0, block);
        this.markModified();
        this.renderBoard();
    }

    // ============================================================
    // 节点引用刷新（订阅活跃缓存快照：节点更名 / 删除 / 归档时更新显示）
    // ============================================================

    private refreshNodeRefs(): void {
        const board = this.boardEl;
        if (!board) return;
        board.querySelectorAll<HTMLElement>('.seqtk-draft-node-ref').forEach((refEl) => {
            const d = this.selectedDraft;
            if (!d) return;
            // 通过卡 id 反查 block
            const card = refEl.closest<HTMLElement>('.seqtk-draft-block');
            const blockId = card?.dataset.blockId;
            if (!blockId) return;
            let block: TimeBlock | undefined;
            outer: for (const a of d.axes) {
                for (const b of a.blocks) {
                    if (b.id === blockId) { block = b; break outer; }
                }
            }
            if (!block) return;
            refEl.empty();
            refEl.removeClass('seqtk-draft-node-ref-linked');
            refEl.removeClass('is-missing');
            refEl.onclick = null;
            this.renderNodeRef(refEl, block);
        });
    }
}
