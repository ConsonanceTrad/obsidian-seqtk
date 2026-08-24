/**
 * ChainCreateModal — 链路创建模态框
 * 
 * 输入一句话想法 → 自动生成 desire → direct → taskchain 三级链路预览
 * 确认后批量创建节点并建立 parent 引用
 */

import { Modal, Setting } from 'obsidian';
import type { NodeType, AnyNode, ChainNodeType } from '../../types/index';
import { NODE_TYPE_LABELS } from '../../types/index';

export interface ChainCreateOptions {
  /** 批量创建回调：按顺序传入 (nodeType, data, body) 的列表 */
  onConfirm: (nodes: Array<{ nodeType: ChainNodeType; name: string; parentRef?: string }>) => void;
}

export class ChainCreateModal extends Modal {
  private options: ChainCreateOptions;
  private idea = '';
  private directName = '';
  private taskchainName = '';
  private previewVisible = false;

  constructor(app: import('obsidian').App, options: ChainCreateOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('node-editor-modal');

    this.setTitle('链路创建');

    // 说明
    contentEl.createEl('p', {
      cls: 'duplicant-quick-create-desc',
      text: '创建同名单链路，以快速进入任务编辑。',
    });

    // 期望名称（同时作为 desire 节点名称）
    const ideaSetting = new Setting(contentEl)
      .setName('期望')
      .setDesc('输入后下两项自动填充')
      .addText((text) => {
        text.setValue(this.idea);
        text.setPlaceholder('想要...');
        text.onChange((v) => {
          this.idea = v.trim();
          this.updatePreview();
        });
        setTimeout(() => text.inputEl.focus(), 100);
      });

    // Direct 名称
    new Setting(contentEl)
      .setName(`${NODE_TYPE_LABELS['direct']}`)
      .addText((text) => {
        text.setValue(this.directName);
        text.setPlaceholder('方向名称');
        text.onChange((v) => { this.directName = v.trim(); });
        text.inputEl.dataset.chainLevel = 'direct';
      });

    // Taskchain 名称
    new Setting(contentEl)
      .setName(`${NODE_TYPE_LABELS['taskchain']}`)
      .addText((text) => {
        text.setValue(this.taskchainName);
        text.setPlaceholder('目标名称');
        text.onChange((v) => { this.taskchainName = v.trim(); });
        text.inputEl.dataset.chainLevel = 'taskchain';
      });

    // 底部按钮
    const footerEl = contentEl.createEl('div', { cls: 'node-editor-footer' });

    const saveBtn = footerEl.createEl('button', { cls: 'btn primary', text: '创建链路' });
    saveBtn.addEventListener('click', () => this.handleConfirm());

    // 快捷键
    this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter' && e.ctrlKey) this.handleConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * 根据想法自动填充各级名称
   */
  private updatePreview(): void {
    if (!this.idea) return;

    // direct 用 "实现「{想法}」的路径"
    // taskchain 用 "完成「{想法}」"
    if (!this.directName || this.directName === `实现「${this.prevIdea}」的路径`) {
      this.directName = `实现「${this.idea}」的路径`;
      const directInput = this.contentEl.querySelector('[data-chain-level="direct"]') as HTMLInputElement;
      if (directInput) directInput.value = this.directName;
    }
    if (!this.taskchainName || this.taskchainName === `完成「${this.prevIdea}」`) {
      this.taskchainName = `完成「${this.idea}」`;
      const taskchainInput = this.contentEl.querySelector('[data-chain-level="taskchain"]') as HTMLInputElement;
      if (taskchainInput) taskchainInput.value = this.taskchainName;
    }

    this.prevIdea = this.idea;
    this.previewVisible = true;
  }

  private prevIdea = '';

  private handleConfirm(): void {
    if (!this.idea && !this.directName && !this.taskchainName) return;

    const nodes: Array<{ nodeType: ChainNodeType; name: string; parentRef?: string }> = [];

    // desire（无 parent）
    if (this.idea) {
      nodes.push({ nodeType: 'desire', name: this.idea });
    }

    // direct（parent = desire）
    if (this.directName) {
      nodes.push({ nodeType: 'direct', name: this.directName });
    }

    // taskchain（parent = direct）
    if (this.taskchainName) {
      nodes.push({ nodeType: 'taskchain', name: this.taskchainName });
    }

    this.options.onConfirm(nodes);
    this.close();
  }
}
