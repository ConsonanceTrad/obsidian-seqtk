/**
 * HubView — 中控台面板
 *
 * 所有操作面板的统一入口：列出注册表中的全部面板（图标 + 标题 + 描述），
 * 点击打开对应面板（已打开则聚焦）。
 *
 * 设计约定：各类型面板不设置 ribbon 按钮，仅通过内置指令与中控台打开；
 * 中控台自身通过内置指令「打开中控台」进入。
 */

import { ItemView, setIcon, WorkspaceLeaf } from 'obsidian';
import { PANEL_REGISTRY, HUB_CATEGORIES } from './panelRegistry';
import type { PanelEntry } from './panelRegistry';
import type { PluginSettings } from '../types/index';

export const VIEW_TYPE_HUB = 'seqtk-hub';
/** 侧边栏中控台（与主区中控台可共存） */
export const VIEW_TYPE_HUB_SIDE = 'seqtk-hub-side';

export class HubView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    /** 视图类型（主区 seqtk-hub / 侧栏 seqtk-hub-side，两者可共存） */
    private viewType: string = VIEW_TYPE_HUB,
    /** 中控台管理设置（显隐与组内顺序） */
    private hubSettings?: PluginSettings['hub'],
  ) {
    super(leaf);
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return '中控台';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  /** 组内排序：先按 order 中出现的顺序，其余按 registry 声明顺序 */
  private orderedEntries(entries: PanelEntry[], order: string[]): PanelEntry[] {
    const byOrder = order
      .map((vt) => entries.find((e) => e.viewType === vt))
      .filter((e): e is PanelEntry => !!e);
    const rest = entries.filter((e) => !order.includes(e.viewType));
    return [...byOrder, ...rest];
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-hub-view');

    // 内部标题已不再需要
    // container.createEl('h3', { text: '中控台', cls: 'seqtk-hub-title' });
    // container.createEl('div', {
    //   cls: 'seqtk-hub-subtitle',
    //   text: '选择要打开的操作面板（也可通过命令面板输入对应名称打开）',
    // });

    const list = container.createDiv('seqtk-hub-list');
    for (const cat of HUB_CATEGORIES) {
      const entries = PANEL_REGISTRY.filter((e) => e.category === cat);
      if (entries.length === 0) continue;
      const cfg = this.hubSettings?.[cat] ?? { hidden: [], order: [] };
      const hiddenSet = new Set(cfg.hidden);
      const ordered = this.orderedEntries(entries, cfg.order).filter((e) => !hiddenSet.has(e.viewType));
      if (ordered.length === 0) continue; // 该分栏全部隐藏 → 不显示分栏
      const catTitle = list.createDiv('seqtk-hub-category-title');
      catTitle.setText(cat);
      for (const entry of ordered) {
        this.renderEntry(list, entry);
      }
    }
  }

  private renderEntry(list: HTMLElement, entry: PanelEntry): void {
    const item = list.createDiv('seqtk-hub-item');
    if (entry.placeholder) item.addClass('seqtk-hub-item-placeholder');
    const iconEl = item.createSpan('seqtk-hub-item-icon');
    setIcon(iconEl, entry.icon);
    item.createEl('span', { cls: 'seqtk-hub-item-title', text: entry.title });
    item.createEl('span', { cls: 'seqtk-hub-item-desc', text: entry.description });
    if (entry.placeholder) {
      const badge = item.createSpan('seqtk-hub-item-badge');
      badge.setText('规划中');
    }
    item.addEventListener('click', () => this.openPanel(entry.viewType));
  }

  async onClose(): Promise<void> {
    // 无订阅，无需清理
  }

  /** 打开指定视图类型的面板（已打开则聚焦，否则新标签页） */
  private openPanel(viewType: string): void {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf('tab');
    if (leaf) {
      void leaf.setViewState({ type: viewType, active: true });
      workspace.revealLeaf(leaf);
    }
  }
}
