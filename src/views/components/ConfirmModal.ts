/**
 * ConfirmModal — 确认对话框（替代 ConfirmDialog.svelte）
 * 
 * 继承 Obsidian Modal，用于级联删除等需要用户确认的危险操作
 */

import { Modal } from 'obsidian';

export interface ConfirmModalOptions {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  private options: ConfirmModalOptions;

  constructor(app: import('obsidian').App, options: ConfirmModalOptions) {
    super(app);
    this.options = {
      confirmLabel: '确认',
      cancelLabel: '取消',
      danger: false,
      ...options,
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('confirm-dialog');

    // 标题
    this.titleEl.textContent = this.options.message;

    // 详情
    if (this.options.detail) {
      const detailEl = contentEl.createEl('div', { cls: 'confirm-detail' });
      detailEl.textContent = this.options.detail;
    }

    // 按钮区域
    const actionsEl = contentEl.createEl('div', { cls: 'confirm-actions' });

    // 取消按钮
    const cancelBtn = actionsEl.createEl('button', { cls: 'confirm-btn cancel', text: this.options.cancelLabel! });
    cancelBtn.addEventListener('click', () => this.close());

    // 确认按钮
    const confirmBtn = actionsEl.createEl('button', {
      cls: `confirm-btn ${this.options.danger ? 'danger' : 'primary'}`,
      text: this.options.confirmLabel!,
    });
    confirmBtn.addEventListener('click', () => {
      this.options.onConfirm();
      this.close();
    });

    // Enter 键确认
    this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        this.options.onConfirm();
        this.close();
      }
      if (e.key === 'Escape') {
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
