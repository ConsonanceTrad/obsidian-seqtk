/**
 * ExecDesignView — 执行设计 · 双栏骨架（未实现）
 *
 * 未实现但需要双栏的功能口：先基于 DualPaneView 给一个无需功能的可视化界面，
 * 后续接入功能时只需替换 renderLeft / renderRight 的内容：
 * - 左栏：执行程序 / 脚本（可视化程序以脚本为事实源）
 * - 右栏：双栏编辑器（连接 Obsidian 右侧附属信息叶子窗口）
 *
 * 当前为占位说明，无数据订阅、无功能逻辑。
 */

import { DualPaneView } from './dual/DualPaneView';
import { VIEW_TYPE_EXEC_DESIGN } from './PlaceholderView';

export class ExecDesignView extends DualPaneView {
  /** 视图容器附加类 */
  protected cssClass = 'seqtk-exec-design-view';

  getViewType(): string {
    return VIEW_TYPE_EXEC_DESIGN;
  }

  getDisplayText(): string {
    return '执行设计';
  }

  getIcon(): string {
    return 'play';
  }

  protected renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '执行程序 / 脚本' });
    const empty = this.leftEl.createDiv('seqtk-empty');
    empty.setText('暂无执行程序');
    const hint = this.leftEl.createDiv('seqtk-placeholder-desc');
    hint.setText('功能待接入：内置可切换的可视化执行程序或执行脚本程序（可视化以脚本为基础的渲染，脚本为事实源）。');
  }

  protected renderRight(): void {
    this.rightEl.empty();
    const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '双栏编辑器' });
    this.rightEl.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });
    const desc = this.rightEl.createDiv('seqtk-placeholder-desc');
    desc.setText('提供触发式或手动式的自动程序；连接 Obsidian 右侧附属信息叶子窗口。');
  }
}
