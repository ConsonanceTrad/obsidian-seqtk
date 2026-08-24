/**
 * PlaceholderView — 未实现功能口的通用占位视图
 *
 * 中控台展示操作口目录中尚未实现的功能口，点击打开此占位视图，
 * 展示标题、描述与规划要点（内容摘录自操作口目录）。
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';

export const VIEW_TYPE_EXEC_DESIGN = 'seqtk-exec-design';
export const VIEW_TYPE_QUERY_DESIGN = 'seqtk-query-design';
export const VIEW_TYPE_COLLAB = 'seqtk-collab';
export const VIEW_TYPE_LOG = 'seqtk-log';

interface PlaceholderOptions {
  title: string;
  desc: string;
  /** 规划要点列表 */
  points?: string[];
}

export class PlaceholderView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private opts: PlaceholderOptions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    // 由 opts 匹配对应的 viewType
    switch (this.opts.title) {
      case '执行设计': return VIEW_TYPE_EXEC_DESIGN;
      case '查询设计': return VIEW_TYPE_QUERY_DESIGN;
      case '智能协作': return VIEW_TYPE_COLLAB;
      case '日志阅览': return VIEW_TYPE_LOG;
      default: return 'seqtk-placeholder';
    }
  }

  getDisplayText(): string {
    return this.opts.title;
  }

  getIcon(): string {
    switch (this.opts.title) {
      case '执行设计': return 'play';
      case '查询设计': return 'search';
      case '智能协作': return 'bot';
      case '日志阅览': return 'scroll-text';
      default: return 'help-circle';
    }
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-placeholder-view');

    container.createEl('h3', { cls: 'seqtk-placeholder-title', text: this.opts.title });
    container.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });
    container.createEl('div', { cls: 'seqtk-placeholder-desc', text: this.opts.desc });
    if (this.opts.points && this.opts.points.length > 0) {
      const list = container.createEl('ul', { cls: 'seqtk-placeholder-points' });
      for (const p of this.opts.points) {
        list.createEl('li', { text: p });
      }
    }
  }

  async onClose(): Promise<void> {
    // 无订阅，无需清理
  }
}
