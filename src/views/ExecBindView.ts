/**
 * ExecBindView — 执行绑定 · 双栏骨架（未实现）
 *
 * 基于 DualPaneView 的双栏可视化占位：将执行行为绑定到指定时间点，
 * 或绑定到某事件（节点）完成后自动触发。
 * - 左栏：绑定规则（定时触发 / 事件后触发）
 * - 右栏：规则编辑与触发记录
 *
 * 后续接入功能时只需替换 renderLeft / renderRight 内容；当前无功能、无订阅。
 */

import { DualPaneView } from './dual/DualPaneView';
import { VIEW_TYPE_EXEC_BIND } from './PlaceholderView';

export class ExecBindView extends DualPaneView {
  /** 视图容器附加类 */
  protected cssClass = 'seqtk-exec-bind-view';

  getViewType(): string {
    return VIEW_TYPE_EXEC_BIND;
  }

  getDisplayText(): string {
    return '执行绑定';
  }

  getIcon(): string {
    return 'cable';
  }

  protected renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '绑定规则' });
    this.leftEl.createDiv('seqtk-placeholder-desc').setText('将执行行为绑定到指定时间点，或绑定到某事件（节点）完成后自动触发。');
    const panels = this.leftEl.createDiv('seqtk-placeholder-panels');
    const timer = panels.createDiv('seqtk-placeholder-panel');
    timer.createDiv('seqtk-placeholder-panel-title').setText('定时触发');
    timer.createDiv('seqtk-placeholder-panel-desc').setText('一次性时间点或周期触发（复用流程脚本规则语法）。');
    const event = panels.createDiv('seqtk-placeholder-panel');
    event.createDiv('seqtk-placeholder-panel-title').setText('事件后触发');
    event.createDiv('seqtk-placeholder-panel-desc').setText('监听节点完成等状态变化后触发绑定行为。');
  }

  protected renderRight(): void {
    this.rightEl.empty();
    const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '编辑与记录' });
    this.rightEl.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });
    const panels = this.rightEl.createDiv('seqtk-placeholder-panels');
    const edit = panels.createDiv('seqtk-placeholder-panel');
    edit.createDiv('seqtk-placeholder-panel-title').setText('规则编辑');
    edit.createDiv('seqtk-placeholder-panel-desc').setText('绑定规则（触发条件 → 执行行为）以可视化或脚本化方式编辑与阅览，供执行设计接入自动程序。');
    const manage = panels.createDiv('seqtk-placeholder-panel');
    manage.createDiv('seqtk-placeholder-panel-title').setText('管理阅览');
    manage.createDiv('seqtk-placeholder-panel-desc').setText('绑定规则的启停控制、触发记录与执行日志。');
  }
}
