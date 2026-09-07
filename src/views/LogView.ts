/**
 * LogView — 日志阅览 · 双栏骨架（未实现）
 *
 * 基于 DualPaneView 的双栏可视化占位：条目化的阅览和搜索日志；
 * 定义部分日志是否需要缓存，以及如何被脚本或自动化获取调用。
 * - 左栏：日志分类（分类来源 / 缓存策略）
 * - 右栏：日志条目（阅览搜索 / 自动化获取）
 *
 * 后续接入功能时只需替换 renderLeft / renderRight 内容；当前无功能、无订阅。
 */

import { DualPaneView } from './dual/DualPaneView';
import { VIEW_TYPE_LOG } from './PlaceholderView';

export class LogView extends DualPaneView {
  /** 视图容器附加类 */
  protected cssClass = 'seqtk-log-view';

  getViewType(): string {
    return VIEW_TYPE_LOG;
  }

  getDisplayText(): string {
    return '日志阅览';
  }

  getIcon(): string {
    return 'scroll-text';
  }

  protected renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '日志分类' });
    this.leftEl.createDiv('seqtk-placeholder-desc').setText('按分类与来源组织日志，管理缓存与获取方式。');
    const panels = this.leftEl.createDiv('seqtk-placeholder-panels');
    const source = panels.createDiv('seqtk-placeholder-panel');
    source.createDiv('seqtk-placeholder-panel-title').setText('分类与来源');
    source.createDiv('seqtk-placeholder-panel-desc').setText('条目化的日志分类与来源管理。');
    const cache = panels.createDiv('seqtk-placeholder-panel');
    cache.createDiv('seqtk-placeholder-panel-title').setText('缓存策略');
    cache.createDiv('seqtk-placeholder-panel-desc').setText('定义部分日志是否需要缓存，以及如何被脚本或自动化获取调用。');
  }

  protected renderRight(): void {
    this.rightEl.empty();
    const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '日志条目' });
    this.rightEl.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });
    const panels = this.rightEl.createDiv('seqtk-placeholder-panels');
    const browse = panels.createDiv('seqtk-placeholder-panel');
    browse.createDiv('seqtk-placeholder-panel-title').setText('条目阅览与搜索');
    browse.createDiv('seqtk-placeholder-panel-desc').setText('条目化的阅览和搜索日志。');
    const fetch = panels.createDiv('seqtk-placeholder-panel');
    fetch.createDiv('seqtk-placeholder-panel-title').setText('自动化获取');
    fetch.createDiv('seqtk-placeholder-panel-desc').setText('日志如何被脚本或自动化获取调用（例如任务的完成信息等）。');
  }
}
