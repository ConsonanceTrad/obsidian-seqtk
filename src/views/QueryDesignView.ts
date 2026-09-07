/**
 * QueryDesignView — 查询设计 · 双栏骨架（未实现）
 *
 * 基于 DualPaneView 的双栏可视化占位：使用内置脚本配合 db 实现相关信息查询，
 * 支持复杂语句，支持查询结果解析输出模块以供使用。
 * - 左栏：查询脚本（内置脚本库 / 复杂语句）
 * - 右栏：查询执行与结果解析
 *
 * 后续接入功能时只需替换 renderLeft / renderRight 内容；当前无功能、无订阅。
 */

import { DualPaneView } from './dual/DualPaneView';
import { VIEW_TYPE_QUERY_DESIGN } from './PlaceholderView';

export class QueryDesignView extends DualPaneView {
  /** 视图容器附加类 */
  protected cssClass = 'seqtk-query-design-view';

  getViewType(): string {
    return VIEW_TYPE_QUERY_DESIGN;
  }

  getDisplayText(): string {
    return '查询设计';
  }

  getIcon(): string {
    return 'search';
  }

  protected renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '查询脚本' });
    this.leftEl.createDiv('seqtk-placeholder-desc').setText('使用内置脚本配合 db 实现相关信息查询，支持复杂语句。');
    const panels = this.leftEl.createDiv('seqtk-placeholder-panels');
    const script = panels.createDiv('seqtk-placeholder-panel');
    script.createDiv('seqtk-placeholder-panel-title').setText('内置脚本');
    script.createDiv('seqtk-placeholder-panel-desc').setText('内置脚本库与脚本化查询入口。');
    const complex = panels.createDiv('seqtk-placeholder-panel');
    complex.createDiv('seqtk-placeholder-panel-title').setText('复杂语句');
    complex.createDiv('seqtk-placeholder-panel-desc').setText('支持复杂语句的查询编辑区。');
  }

  protected renderRight(): void {
    this.rightEl.empty();
    const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '查询与结果' });
    this.rightEl.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });
    const panels = this.rightEl.createDiv('seqtk-placeholder-panels');
    const run = panels.createDiv('seqtk-placeholder-panel');
    run.createDiv('seqtk-placeholder-panel-title').setText('查询执行');
    run.createDiv('seqtk-placeholder-panel-desc').setText('执行查询并预览原始结果。');
    const output = panels.createDiv('seqtk-placeholder-panel');
    output.createDiv('seqtk-placeholder-panel-title').setText('结果解析输出');
    output.createDiv('seqtk-placeholder-panel-desc').setText('查询结果解析输出模块以供使用。');
  }
}
