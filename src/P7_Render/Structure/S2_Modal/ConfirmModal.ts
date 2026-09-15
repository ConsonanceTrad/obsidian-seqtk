/**
 * ConfirmModal — 确认对话框（危险操作二次确认）
 *
 * 自 old/0.1.2/src/views/components/ConfirmModal.ts 迁入。
 *
 * 保持 Obsidian 原生 Modal 实现、不 React 化：Modal 是命令式浮层
 * （new ConfirmModal(app, opts).open()），不属于视图渲染树；保持原生反而让
 * 「渲染 / 逻辑」的边界更清晰（见 P7_Render/Render.md 与计划决策 dec-db13741643639699）。
 */

import { Modal, type App } from 'obsidian';

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

  constructor(app: App, options: ConfirmModalOptions) {
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
