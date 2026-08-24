/**
 * TransactionModals — 事务节点创建/编辑模态框（MVP 操作口）
 *
 * 模态框仅负责收集输入，落盘与缓存同步由调用方（TransactionView）执行。
 */

import { App, DropdownComponent, Modal, Setting, TextComponent } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState, EventNature } from '../../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
  STATE_VALUES,
  EVENT_NATURE_LABELS,
  isFrameworkKind,
  isTransactionKind,
} from '../../types/index';

/** 创建后行为 */
export type CreateAfterAction = 'direct' | 'edit-body';

/** 创建节点的输入 */
export interface TransactionCreateInput {
  kind: NodeKind;
  desc: string;
  state: SeqtkState;
  /** 事件性质（仅 kind=event 时提供） */
  nature?: EventNature;
  /** 创建后行为（默认 direct=直接创建，不跳转） */
  afterCreate: CreateAfterAction;
}

/** 编辑节点的输入 */
export interface TransactionEditInput {
  desc: string;
  state: SeqtkState;
  /** 事件性质（仅 event 节点提供） */
  nature?: EventNature;
}

function stateOptions(): { value: SeqtkState; label: string }[] {
  return [...STATE_VALUES].map((s) => ({ value: s, label: NODE_STATE_LABELS[s] }));
}

/** 该类型是否使用过程状态（state）— 框架与事务节点使用，其余不适用 */
export function kindUsesState(kind: NodeKind): boolean {
  return isFrameworkKind(kind) || isTransactionKind(kind);
}

// ============================================================
// 创建模态框
// ============================================================

export class TransactionCreateModal extends Modal {
  private kind: NodeKind;
  private desc = '';
  private state: SeqtkState = 'plan';
  private nature: EventNature = 'temp';
  private natureSetting: Setting | null = null;
  private stateSel: DropdownComponent | null = null;

  constructor(
    app: App,
    private opts: {
      /** 可创建的 kind 列表（首个为默认值；视图根据父节点类型决定） */
      kinds: NodeKind[];
      onSubmit: (input: TransactionCreateInput) => void;
    }
  ) {
    super(app);
    this.kind = opts.kinds[0];
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('seqtk-modal');

    contentEl.createEl('h3', { text: '新建节点' });

    // 类型 + 名称靠左，状态靠右（类似节点行的展示形式）
    const row = contentEl.createDiv('seqtk-inline-row');
    const left = row.createDiv('seqtk-inline-left');

    const kindSel = new DropdownComponent(left);
    for (const k of this.opts.kinds) {
      kindSel.addOption(k, NODE_KIND_LABELS[k]);
    }
    kindSel.setValue(this.kind);
    kindSel.onChange((v) => {
      this.kind = v as NodeKind;
      this.updateNatureVisibility();
      this.updateStateVisibility();
    });

    const nameInput = new TextComponent(left);
    nameInput.setPlaceholder('名称');
    nameInput.onChange((v) => { this.desc = v; });
    nameInput.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirm('direct');
    });

    // 状态下拉（仅框架/事务类型显示）
    this.stateSel = new DropdownComponent(row);
    for (const o of stateOptions()) {
      this.stateSel.addOption(o.value, o.label);
    }
    this.stateSel.setValue(this.state);
    this.stateSel.onChange((v) => { this.state = v as SeqtkState; });
    this.updateStateVisibility();

    // 事件性质（仅 kind=event 时显示）
    this.natureSetting = new Setting(contentEl)
      .setName('性质')
      .setDesc('临时：临时被派发的任务；补录：已经完成过的任务')
      .addDropdown((dd) => {
        dd.addOption('temp', EVENT_NATURE_LABELS.temp);
        dd.addOption('retro', EVENT_NATURE_LABELS.retro);
        dd.setValue(this.nature);
        dd.onChange((v) => { this.nature = v as EventNature; });
      });
    this.updateNatureVisibility();

    // 三个并列按钮：创建（默认）/ 创建并编辑描述 / 取消
    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText('创建').setCta().onClick(() => this.confirm('direct'));
      })
      .addButton((b) => {
        b.setButtonText('创建并编辑描述').onClick(() => this.confirm('edit-body'));
      })
      .addButton((b) => {
        b.setButtonText('取消').onClick(() => this.close());
      });
  }

  /** 仅当类型为事件时显示性质选择 */
  private updateNatureVisibility(): void {
    if (this.natureSetting) {
      this.natureSetting.settingEl.style.display = this.kind === 'event' ? '' : 'none';
    }
  }

  /** 仅当类型为框架/事务时显示状态下拉 */
  private updateStateVisibility(): void {
    if (this.stateSel) {
      this.stateSel.selectEl.style.display = kindUsesState(this.kind) ? '' : 'none';
    }
  }

  private confirm(afterCreate: CreateAfterAction): void {
    if (!this.desc.trim()) {
      new Setting(this.contentEl).setDesc('名称不能为空');
      return;
    }
    this.opts.onSubmit({
      kind: this.kind,
      desc: this.desc.trim(),
      state: this.state,
      ...(this.kind === 'event' ? { nature: this.nature } : {}),
      afterCreate,
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ============================================================
// 编辑模态框
// ============================================================

export class TransactionEditModal extends Modal {
  private desc: string;
  private state: SeqtkState;
  private body: string;
  private nature: EventNature;

  constructor(
    app: App,
    private opts: {
      node: SeqtkNode;
      onSubmit: (input: TransactionEditInput) => void;
      /** 保存元数据后跳转到文件编辑正文 */
      onOpenFile?: () => void;
    }
  ) {
    super(app);
    this.desc = opts.node.desc;
    this.state = opts.node.state ?? 'plan';
    this.nature = (opts.node as any).nature ?? 'temp';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('seqtk-modal');

    contentEl.createEl('h3', { text: `编辑 · ${NODE_KIND_LABELS[this.opts.node.kind]}` });

    // 名称靠左，状态靠右（类似节点行的展示形式）
    const row = contentEl.createDiv('seqtk-inline-row');
    const left = row.createDiv('seqtk-inline-left');

    const nameInput = new TextComponent(left);
    nameInput.setValue(this.desc);
    nameInput.onChange((v) => { this.desc = v; });

    // 状态下拉（仅框架/事务类型显示）
    if (kindUsesState(this.opts.node.kind)) {
      const stateSel = new DropdownComponent(row);
      for (const o of stateOptions()) {
        stateSel.addOption(o.value, o.label);
      }
      stateSel.setValue(this.state);
      stateSel.onChange((v) => { this.state = v as SeqtkState; });
    }

    // 事件性质（仅 event 节点显示）
    if (this.opts.node.kind === 'event') {
      new Setting(contentEl)
        .setName('性质')
        .addDropdown((dd) => {
          dd.addOption('temp', EVENT_NATURE_LABELS.temp);
          dd.addOption('retro', EVENT_NATURE_LABELS.retro);
          dd.setValue(this.nature);
          dd.onChange((v) => { this.nature = v as EventNature; });
        });
    }

    const actions = new Setting(contentEl);
    if (this.opts.onOpenFile) {
      actions.addButton((b) => {
        b.setButtonText('保存并打开文件').setCta().onClick(() => this.confirmAndOpen());
      });
    }
    actions.addButton((b) => {
      b.setButtonText('保存').onClick(() => this.confirm());
    });
    actions.addButton((b) => {
      b.setButtonText('取消').onClick(() => this.close());
    });
  }

  /** 保存元数据并跳转到文件编辑正文 */
  private confirmAndOpen(): void {
    if (!this.desc.trim()) return;
    this.opts.onSubmit({
      desc: this.desc.trim(),
      state: this.state,
      ...(this.opts.node.kind === 'event' ? { nature: this.nature } : {}),
    });
    this.opts.onOpenFile?.();
    this.close();
  }

  private confirm(): void {
    if (!this.desc.trim()) return;
    this.opts.onSubmit({
      desc: this.desc.trim(),
      state: this.state,
      ...(this.opts.node.kind === 'event' ? { nature: this.nature } : {}),
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
