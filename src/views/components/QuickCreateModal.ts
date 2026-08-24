/**
 * QuickCreateModal — 快速节点创建模态框
 * 
 * 精简表单：选择节点类型 + 输入名称 → 直接创建
 * 支持 desire / direct / taskchain 三种链路节点类型
 */

import { Modal, Setting } from 'obsidian';
import type { NodeType, AnyNode } from '../../types/index';
import { NODE_TYPE_LABELS } from '../../types/index';

export interface QuickCreateOptions {
  /** 指定节点类型（固定类型模式，不显示类型下拉） */
  nodeType?: NodeType;
  /** 可选的父节点候选（用于 direct/taskchain 自动关联） */
  parentCandidates?: { nodeId: string; data: AnyNode }[];
  /** 创建回调 */
  onSave: (nodeType: NodeType, name: string) => void;
}

const AVAILABLE_TYPES: NodeType[] = ['desire', 'direct', 'taskchain'];

const TYPE_DESCRIPTIONS: Record<string, string> = {
  desire: '顶层期望，代表你想要实现的愿景或目标方向。',
  direct: '隶属于某个期望的方向，代表实现期望的路径。',
  taskchain: '隶属于某个方向的具体目标，可分解为任务项。',
};

export class QuickCreateModal extends Modal {
  private options: QuickCreateOptions;
  private selectedType: NodeType = 'desire';
  private name = '';

  constructor(app: import('obsidian').App, options: QuickCreateOptions) {
    super(app);
    this.options = options;
    // 如果指定了 nodeType，直接使用；否则默认 desire
    if (options.nodeType) {
      this.selectedType = options.nodeType;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('node-editor-modal');

    const fixedType = this.options.nodeType;

    // 标题：固定类型时显示"新建{类型名}"，否则显示"快速创建节点"
    this.setTitle(fixedType ? `新建${NODE_TYPE_LABELS[fixedType] ?? fixedType}` : '快速创建节点');

    if (!fixedType) {
      // 类型说明
      const descEl = contentEl.createEl('div', { cls: 'duplicant-quick-create-desc' });

      // 类型选择（仅非固定类型时显示）
      new Setting(contentEl)
        .setName('节点类型')
        .addDropdown((dd) => {
          for (const t of AVAILABLE_TYPES) {
            dd.addOption(t, NODE_TYPE_LABELS[t] ?? t);
          }
          dd.setValue(this.selectedType);
          dd.onChange((v) => {
            this.selectedType = v as NodeType;
            descEl.textContent = TYPE_DESCRIPTIONS[v] ?? '';
          });
        });

      descEl.textContent = TYPE_DESCRIPTIONS[this.selectedType];
    }

    // 名称输入
    new Setting(contentEl)
      .setName('名称')
      .setDesc('待添加的节点名')
      .addText((text) => {
        text.setValue(this.name);
        text.setPlaceholder('输入...');
        text.onChange((v) => { this.name = v.trim(); });
        setTimeout(() => text.inputEl.focus(), 100);
      });

    // 底部按钮
    const footerEl = contentEl.createEl('div', { cls: 'node-editor-footer' });

    const saveBtn = footerEl.createEl('button', { cls: 'btn primary', text: '创建' });
    saveBtn.addEventListener('click', () => this.handleSave());

    const cancelBtn = footerEl.createEl('button', { cls: 'btn cancel', text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    // 快捷键
    this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter') this.handleSave();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private handleSave(): void {
    if (!this.name) return;
    this.options.onSave(this.selectedType, this.name);
    this.close();
  }
}
