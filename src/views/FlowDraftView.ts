/**
 * FlowDraftView — 规则设计 · 流程草稿
 *
 * 双栏：
 * - 左栏：草稿列表（新建 / 切换 / 重命名 / 删除）
 * - 右栏：泳道板 —— 一条草稿含多条并行事件轴（横向并列、横向滚动），
 *   每条轴自上而下排列「起止时间块」；块可拖拽重排 / 跨轴移动，
 *   可按编号（手动顺序）或按起止时间升降序排列。
 *
 * 定位（与流程设计 / 流程推送区分）：
 * - 纯 UI 草稿，无专属语法、不涉及提醒
 * - 块内容：起止时间（快速敲定时间）+ 只读关联节点（可点击跳文件）+ 备注/直接文本
 * - 数据持久化：rootFolder/flow-drafts.json（DraftStore），不创建、不修改任何节点
 */

import { ItemView, Menu, Modal, Notice, Setting, TextComponent, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS, getCategoryOf } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import { DraftStore } from '../core/DraftStore';
import {
  createEventAxis,
  createFlowDraft,
  createTimeBlock,
  genDraftId,
  sortBlocksByTime,
} from '../types/draft';
import type { EventAxis, FlowDraft, TimeBlock } from '../types/draft';

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
// 通用弹窗（单输入文本 / 确认），参照其他视图文件内私有类风格
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

/** 节点搜索候选 */
interface NodeCandidate {
  nodeId: string;
  data: SeqtkNode;
}

/**
 * 节点选择弹窗 — 输入即搜（NodeCache.search），列表展示 kind 徽章 + 名称 + nodeId。
 * 仅用于把节点「只读关联」到时间块，不修改节点本身。
 */
class NodePickModal extends Modal {
  private searchInput!: HTMLInputElement;
  private listEl!: HTMLElement;
  private emptyEl: HTMLElement | null = null;
  private searchTimer: number | null = null;

  constructor(
    app: any,
    private nodeCache: NodeCache,
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
    const results = q ? this.nodeCache.search(q, 50) : this.nodeCache.search('', 50);
    if (results.length === 0) {
      this.listEl.createEl('div', { cls: 'seqtk-draft-node-empty', text: '无匹配节点' });
      return;
    }
    for (const { nodeId, data } of results) {
      const row = this.listEl.createDiv('seqtk-draft-node-item');
      row.createEl('span', {
        cls: `seqtk-kind-badge kind-${getCategoryOf(data.kind)}`,
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

export class FlowDraftView extends ItemView {
  private nodeCache: NodeCache;
  private fileManager: NodeFileManager;
  private draftStore: DraftStore;

  private leftEl!: HTMLElement;
  private boardEl!: HTMLElement;   // 泳道板（右栏滚动容器）
  private toolbarEl!: HTMLElement;
  private saveStateEl: HTMLElement | null = null;

  private drafts: FlowDraft[] = [];
  private selectedDraftId: string | null = null;
  private unsub: (() => void) | null = null;
  private saveTimer: number | null = null;
  private loaded = false;

  // 拖拽状态
  private dragInfo: { axisId: string; blockId: string } | null = null;
  private dropTarget: { axisId: string; insertBeforeId: string | null } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    nodeCache: NodeCache,
    fileManager: NodeFileManager,
  ) {
    super(leaf);
    this.nodeCache = nodeCache;
    this.fileManager = fileManager;
    this.draftStore = new DraftStore(this.app, fileManager);
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

  // ============================================================
  // 生命周期
  // ============================================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');
    const right = split.createDiv('seqtk-split-right');
    this.toolbarEl = right.createDiv('seqtk-draft-toolbar');
    this.boardEl = right.createDiv('seqtk-draft-board');

    // 左栏空白右键：新建草稿（仅绑定一次，避免列表重渲染时重复累积）
    this.leftEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-draft-list-item')) return;
      e.preventDefault();
      this.createDraft();
    });

    // 订阅节点缓存：就绪后重绘左栏（依赖 nodeCache 的列表），并刷新块内节点引用显示
    // （更名跟随 / 归档或删除标失效；不做整表重渲染以免打断输入）
    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      if (!this.loaded) return;
      if (!this.nodeCache.isInitialized) return;
      this.renderLeft();
      this.refreshNodeRefs();
    });

    await this.loadData();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    await this.flushSave();
  }

  private async loadData(): Promise<void> {
    this.drafts = await this.draftStore.load();
    this.loaded = true;
    // 校验并清理已被删除的草稿引用（无必要，保持原样）
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

  private get allBlocksCount(): number {
    let n = 0;
    for (const d of this.drafts) for (const a of d.axes) n += a.blocks.length;
    return n;
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
    if (this.saveStateEl) this.saveStateEl.setText(text);
  }

  /** 全量重渲染（草稿切换 / 增删排序后调用） */
  private renderAll(): void {
    this.renderToolbar();
    this.renderLeft();
    this.renderBoard();
  }

  // ============================================================
  // 工具栏（右栏顶部）
  // ============================================================

  private renderToolbar(): void {
    this.toolbarEl.empty();
    const d = this.selectedDraft;
    const titleEl = this.toolbarEl.createEl('span', {
      cls: 'seqtk-draft-toolbar-title',
      text: d ? d.title : '流程草稿',
    });
    if (!d) {
      titleEl.addClass('seqtk-draft-toolbar-title-dim');
      this.saveStateEl = this.toolbarEl.createEl('span', { cls: 'seqtk-draft-save-state' });
      return;
    }

    // 排序（作用于当前草稿全部事件轴的块；结果即新的手动顺序）
    const ascBtn = this.toolbarEl.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '时间 ↑' });
    const descBtn = this.toolbarEl.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '时间 ↓' });
    setTooltip(ascBtn, '将所有事件轴的时间块按起止时间升序重排（无时间的块排尾部）');
    setTooltip(descBtn, '按起止时间降序重排');
    ascBtn.addEventListener('click', () => this.applyTimeSort(false));
    descBtn.addEventListener('click', () => this.applyTimeSort(true));

    const addAxisBtn = this.toolbarEl.createEl('button', { cls: 'seqtk-btn seqtk-btn-small seqtk-btn-primary', text: '+ 事件轴' });
    addAxisBtn.addEventListener('click', () => this.addAxis());

    const addBlockBtn = this.toolbarEl.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '+ 时间块' });
    addBlockBtn.addEventListener('click', () => {
      const target = d.axes[0];
      if (target) this.addBlock(target.id);
      else new Notice('请先添加事件轴');
    });

    const hint = this.toolbarEl.createEl('span', {
      cls: 'seqtk-draft-hint',
      text: '块编号即当前顺序；拖拽块可重排或跨轴移动；时间块起止用于快速敲定时间',
    });
    hint.setAttribute('aria-hidden', 'true');

    this.saveStateEl = this.toolbarEl.createEl('span', { cls: 'seqtk-draft-save-state', text: '已保存' });
  }

  // ============================================================
  // 左栏：草稿列表
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '流程草稿' });

    const newBtn = this.leftEl.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '+ 新建草稿' });
    newBtn.addEventListener('click', () => this.createDraft());

    if (this.drafts.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无草稿（点击上方新建）' });
    } else {
      for (const draft of this.drafts) {
        const row = this.leftEl.createDiv('seqtk-draft-list-item');
        if (draft.id === this.selectedDraftId) row.addClass('seqtk-draft-list-item-active');
        row.createEl('span', { cls: 'seqtk-draft-list-title', text: draft.title });
        const nBlocks = draft.axes.reduce((s, a) => s + a.blocks.length, 0);
        const meta = row.createEl('span', { cls: 'seqtk-draft-list-meta', text: `${draft.axes.length} 轴 · ${nBlocks} 块` });
        row.addEventListener('click', () => this.selectDraft(draft.id));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showDraftMenu(e, draft);
        });
      }
    }
  }

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
      message: `确定删除草稿「${draft.title}」？将同时移除其 ${draft.axes.length} 条事件轴、${nBlocks} 个时间块。此操作不可撤销。`,
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
  // 泳道板（右栏主体）
  // ============================================================

  private renderBoard(): void {
    this.clearDropIndicators();
    this.boardEl.empty();
    const d = this.selectedDraft;
    if (!d) {
      const empty = this.boardEl.createDiv('seqtk-draft-board-empty');
      empty.createEl('div', { text: '还没有草稿' });
      empty.createEl('div', { cls: 'seqtk-draft-board-empty-sub', text: '在左侧新建一条流程草稿，开始快速敲定时间' });
      return;
    }
    for (const axis of d.axes) {
      this.renderLane(axis);
    }
  }

  private renderLane(axis: EventAxis): void {
    const lane = this.boardEl.createDiv('seqtk-draft-lane');
    lane.dataset.axisId = axis.id;

    // ── 轴头 ──
    const head = lane.createDiv('seqtk-draft-lane-head');
    const titleEl = head.createEl('span', { cls: 'seqtk-draft-lane-title', text: axis.title });
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

    // ── 轴体（块列表；drag 事件委派到此处统一处理插入位） ──
    const body = lane.createDiv('seqtk-draft-lane-body');
    body.dataset.axisId = axis.id;

    for (const block of axis.blocks) {
      this.renderBlock(axis, block);
    }

    if (axis.blocks.length === 0) {
      const emptyHint = body.createDiv('seqtk-draft-lane-empty');
      emptyHint.textContent = '空轴 — 把块拖到这里，或添加时间块';
    }

    const addBtn = body.createEl('button', { cls: 'seqtk-btn seqtk-btn-small seqtk-draft-add-block', text: '+ 时间块' });
    addBtn.addEventListener('click', () => this.addBlock(axis.id));

    this.attachLaneDrag(body, axis.id);
  }

  /** 时间块卡片 */
  private renderBlock(axis: EventAxis, block: TimeBlock): void {
    const body = this.boardEl.querySelector<HTMLElement>(`.seqtk-draft-lane-body[data-axis-id="${axis.id}"]`);
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
    head.createEl('button', { cls: 'seqtk-draft-icon-btn', attr: { 'aria-label': '复制时间块' } }, (btn) => {
      setIcon(btn, 'copy');
      btn.addEventListener('click', () => this.duplicateBlock(axis.id, block.id));
    });
    head.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-icon-danger', attr: { 'aria-label': '删除时间块' } }, (btn) => {
      setIcon(btn, 'x');
      btn.addEventListener('click', () => this.deleteBlock(axis.id, block.id));
    });

    // ── 时间编辑区（起 / 止，可缺省） ──
    const times = card.createDiv('seqtk-draft-times');
    this.renderTimeRow(times, '起', block, 'from');
    this.renderTimeRow(times, '止', block, 'to');
    const metaRow = times.createDiv('seqtk-draft-meta-row');
    metaRow.createEl('span', { cls: 'seqtk-draft-time-label', text: '时长' });
    metaRow.createEl('span', { cls: 'seqtk-draft-span', text: spanText(block.from, block.to) });

    // 快捷敲定：设置「起」，未设止或止早于起时自动补 +1h
    const chips = card.createDiv('seqtk-draft-chips');
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
      chip.addEventListener('click', () => this.applyQuickStart(axis.id, block.id, q.offsetMin));
    }

    // ── 备注 / 直接文本 ──
    const textarea = card.createEl('textarea', {
      cls: 'seqtk-draft-text',
      attr: {
        rows: '2',
        placeholder: '备注 / 直接输入文本（可空）…',
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

  /** 时间输入行：label + datetime-local + 清除按钮；change 只更新模型不整表重渲染 */
  private renderTimeRow(container: HTMLElement, label: string, block: TimeBlock, side: 'from' | 'to'): void {
    const row = container.createDiv('seqtk-draft-time-row');
    row.createEl('span', { cls: 'seqtk-draft-time-label', text: label });
    const input = row.createEl('input', {
      cls: 'seqtk-draft-time-input',
      attr: { type: 'datetime-local' },
    });
    input.value = isoToInput(block[side]);
    input.addEventListener('change', () => {
      block[side] = inputToIso(input.value);
      this.markModified();
      this.updateCardMeta(block.id);
    });
    row.createEl('button', { cls: 'seqtk-draft-icon-btn seqtk-draft-clear-btn', attr: { 'aria-label': '清除' } }, (btn) => {
      setIcon(btn, 'x');
      btn.addEventListener('click', () => {
        block[side] = undefined;
        input.value = '';
        this.markModified();
        this.updateCardMeta(block.id);
      });
    });
  }

  /** 渲染某块的「关联节点引用」标签（可点击跳文件） */
  private renderNodeRef(el: HTMLElement, block: TimeBlock): void {
    el.empty();
    if (!block.nodeId) {
      const ph = el.createEl('span', { cls: 'seqtk-draft-node-name seqtk-draft-node-placeholder', text: '未关联节点' });
      el.title = '点击右侧 关联 按钮选择节点';
      return;
    }
    const node = this.safeGetNode(block.nodeId);
    if (!node) {
      el.addClass('is-missing');
      const span = el.createEl('span', {
        cls: 'seqtk-draft-node-name',
        text: this.nodeCache.isInitialized ? '节点不存在（已删除或归档）' : '节点未载入（缓存未就绪）',
      });
      span.dataset.nodeId = block.nodeId;
      return;
    }
    el.createEl('span', {
      cls: `seqtk-kind-badge kind-${getCategoryOf(node.kind)}`,
      text: NODE_KIND_LABELS[node.kind],
    });
    const name = el.createEl('span', { cls: 'seqtk-draft-node-name', text: node.desc });
    name.dataset.nodeId = block.nodeId;
    el.addClass('seqtk-draft-node-ref-linked');
    el.addEventListener('click', () => this.openNodeFile(block.nodeId!));
    el.title = `${node.desc}\n${block.nodeId}\n点击打开节点文件`;
  }

  /** 局部刷新块卡的元信息（时长等，输入时不打断焦点） */
  private updateCardMeta(blockId: string): void {
    const card = this.boardEl.querySelector<HTMLElement>(`.seqtk-draft-block[data-block-id="${blockId}"]`);
    if (!card) return;
    const d = this.selectedDraft;
    if (!d) return;
    for (const a of d.axes) {
      const block = a.blocks.find((b) => b.id === blockId);
      if (block) {
        const spanEl = card.querySelector('.seqtk-draft-span');
        if (spanEl) spanEl.setText(spanText(block.from, block.to));
        return;
      }
    }
  }

  // ============================================================
  // 草稿 / 泳道 / 块的增删改
  // ============================================================

  private applyTimeSort(desc: boolean): void {
    const d = this.selectedDraft;
    if (!d) return;
    for (const a of d.axes) {
      a.blocks = sortBlocksByTime(a.blocks, desc);
    }
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
        this.boardEl.scrollLeft = this.boardEl.scrollWidth;
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
      message: `确定删除事件轴「${axis.title}」？将同时移除其中 ${axis.blocks.length} 个时间块。`,
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
      const card = this.boardEl.querySelector<HTMLElement>(`.seqtk-draft-block[data-block-id="${block.id}"]`);
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
    if (!this.nodeCache.isInitialized) {
      new Notice('节点缓存尚未就绪，请稍后再试');
      return;
    }
    const d = this.selectedDraft;
    const axis = d?.axes.find((a) => a.id === axisId);
    const block = axis?.blocks.find((b) => b.id === blockId);
    if (!d || !axis || !block) return;
    new NodePickModal(this.app, this.nodeCache, (nodeId) => {
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

  /** 快捷设定「起」；止为空或早于新起时自动补 1 小时 */
  private applyQuickStart(axisId: string, blockId: string, offsetMin: number): void {
    const d = this.selectedDraft;
    const axis = d?.axes.find((a) => a.id === axisId);
    const block = axis?.blocks.find((b) => b.id === blockId);
    if (!d || !axis || !block) return;
    const from = new Date(Date.now() + offsetMin * 60000);
    block.from = from.toISOString();
    if (!block.to || new Date(block.to).getTime() <= from.getTime()) {
      block.to = new Date(from.getTime() + 3600000).toISOString();
    }
    this.markModified();
    // 刷新本卡时间输入值 + 元信息
    const card = this.boardEl.querySelector<HTMLElement>(`.seqtk-draft-block[data-block-id="${blockId}"]`);
    if (card) {
      const inputs = card.querySelectorAll<HTMLInputElement>('.seqtk-draft-time-input');
      if (inputs[0]) inputs[0].value = isoToInput(block.from);
      if (inputs[1]) inputs[1].value = isoToInput(block.to);
      this.updateCardMeta(blockId);
    }
  }

  /** 安全读取节点：缓存未初始化或读取异常时返回 undefined（避免渲染崩溃） */
  private safeGetNode(nodeId: string | undefined): SeqtkNode | undefined {
    if (!nodeId || !this.nodeCache.isInitialized) return undefined;
    try {
      return this.nodeCache.getNode(nodeId) ?? undefined;
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
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(node.kind, nodeId));
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
        if (this.dropTarget
          && this.dropTarget.axisId === axisId
          && this.dropTarget.insertBeforeId === (after ? this.nextBlockId(body, targetId) : targetId)) {
          // 无变化（拖到自己原位的边界判定），仍保留指示
        }
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
      const body = this.boardEl.querySelector<HTMLElement>(`.seqtk-draft-lane-body[data-axis-id="${axisId}"]`);
      body?.addClass('seqtk-drop-tail');
    }
  }

  private clearDropIndicators(): void {
    this.boardEl.querySelectorAll('.seqtk-drop-before').forEach((el) => el.removeClass('seqtk-drop-before'));
    this.boardEl.querySelectorAll('.seqtk-drop-after').forEach((el) => el.removeClass('seqtk-drop-after'));
    this.boardEl.querySelectorAll('.seqtk-drop-tail').forEach((el) => el.removeClass('seqtk-drop-tail'));
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
    if (dstAxisId === srcAxisId) {
      // 同轴：移除后再定位（insertBeforeId 不会是被移除的自身）
    }
    const idx = insertBeforeId ? dstAxis.blocks.findIndex((b) => b.id === insertBeforeId) : -1;
    if (idx < 0) dstAxis.blocks.push(block);
    else dstAxis.blocks.splice(idx, 0, block);
    this.markModified();
    this.renderBoard();
  }

  // ============================================================
  // 节点引用刷新（订阅 nodeStore：节点更名 / 删除 / 归档时更新显示）
  // ============================================================

  private refreshNodeRefs(): void {
    this.boardEl.querySelectorAll<HTMLElement>('.seqtk-draft-node-ref').forEach((refEl) => {
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
