/**
 * DescriptionEditModal — 轻量级描述编辑模态框
 * 
 * 对齐旧版 v1 的 promptEditBody 功能：
 * - 标题：编辑描述 - {节点名称}
 * - 内容：textarea 编辑区
 * - 按钮：保存
 * - Ctrl+Enter 保存，Escape 关闭
 */

import { Modal, Setting } from 'obsidian';

export interface DescriptionEditOptions {
  /** 当前正文内容 */
  currentBody: string;
  /** 保存回调 */
  onSave: (body: string) => void;
}

export class DescriptionEditModal extends Modal {
  private options: DescriptionEditOptions;
  private body: string;

  constructor(app: import('obsidian').App, options: DescriptionEditOptions) {
    super(app);
    this.options = options;
    this.body = options.currentBody;
    this.setTitle('编辑描述');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('duplicant-desc-edit-modal');

    // textarea 编辑区
    const textarea = contentEl.createEl('textarea', {
      cls: 'duplicant-body-editor',
      attr: { rows: '6', placeholder: '输入描述...' },
    });
    textarea.value = this.body;
    textarea.addEventListener('input', () => { this.body = textarea.value; });
    setTimeout(() => textarea.focus(), 100);

    // 底部按钮
    const footerEl = contentEl.createEl('div', { cls: 'node-editor-footer' });

    const saveBtn = footerEl.createEl('button', { cls: 'btn primary', text: '保存' });
    saveBtn.addEventListener('click', () => this.handleSave());

    // Ctrl+Enter 保存，Escape 关闭
    this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter' && e.ctrlKey) this.handleSave();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private handleSave(): void {
    this.options.onSave(this.body);
    this.close();
  }
}
