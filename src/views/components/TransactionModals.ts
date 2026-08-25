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
import { describeCycleRule, validateCycleRule } from '../../utils/cycleRuleParser';

/** 创建后行为 */
export type CreateAfterAction = 'direct' | 'edit-body';

/** 创建节点的输入 */
export interface TransactionCreateInput {
  kind: NodeKind;
  desc: string;
  state: SeqtkState;
  /** 事件性质（仅 kind=event 时提供） */
  nature?: EventNature;
  /** 预期时间（仅事务节点）：ISO 日期/时间 */
  expectedTime?: string;
  /** 预期重复（仅事务节点）：cycleRuleParser 语法规则字符串 */
  expectedRepeat?: string;
  /** 预期时间段（仅框架节点）：起止 ISO 时间 */
  expectedSpan?: { from?: string; to?: string };
  /** 创建后行为（默认 direct=直接创建，不跳转） */
  afterCreate: CreateAfterAction;
}

/** 编辑节点的输入 */
export interface TransactionEditInput {
  desc: string;
  state: SeqtkState;
  /** 事件性质（仅 event 节点提供） */
  nature?: EventNature;
  /** 预期时间（仅事务节点）：ISO 日期/时间 */
  expectedTime?: string;
  /** 预期重复（仅事务节点）：cycleRuleParser 语法规则字符串 */
  expectedRepeat?: string;
  /** 预期时间段（仅框架节点）：起止 ISO 时间 */
  expectedSpan?: { from?: string; to?: string };
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
  // 预期属性
  private expectedTime = '';
  private expectedRepeat = '';
  private expectedSpanFrom = '';
  private expectedSpanTo = '';
  private expectedFieldsEl: HTMLElement | null = null;

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

    this.setTitle('新建节点');

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
      this.renderExpectedFields();
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

    // 预期属性字段区（按类型动态显示：事务=预期时间+预期重复；框架=预期时间段）
    this.expectedFieldsEl = contentEl.createDiv('seqtk-expected-fields');
    this.renderExpectedFields();

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

  /** 按当前类型渲染预期属性字段区：事务=预期时间+预期重复；框架=预期时间段 */
  private renderExpectedFields(): void {
    const el = this.expectedFieldsEl;
    if (!el) return;
    el.empty();
    if (isTransactionKind(this.kind)) {
      new Setting(el).setName('预期时间').addText((t) => {
        t.inputEl.type = 'date';
        t.setValue(this.expectedTime);
        t.onChange((v) => { this.expectedTime = v; });
      });
      const repDesc = this.expectedRepeat ? describeCycleRule(this.expectedRepeat) : '如 D-r3（每3日）、W-r2-i4D（每两周第4日）';
      const rep = new Setting(el).setName('预期重复').setDesc(repDesc);
      rep.addText((t) => {
        t.setPlaceholder('D-r3');
        t.setValue(this.expectedRepeat);
        t.onChange((v) => {
          this.expectedRepeat = v;
          rep.setDesc(v ? describeCycleRule(v) : '如 D-r3（每3日）、W-r2-i4D（每两周第4日）');
        });
      });
    } else if (isFrameworkKind(this.kind)) {
      new Setting(el).setName('预期时间段').setDesc('起止日期').addText((t) => {
        t.inputEl.type = 'date';
        t.setPlaceholder('起');
        t.setValue(this.expectedSpanFrom);
        t.onChange((v) => { this.expectedSpanFrom = v; });
      }).addText((t) => {
        t.inputEl.type = 'date';
        t.setPlaceholder('止');
        t.setValue(this.expectedSpanTo);
        t.onChange((v) => { this.expectedSpanTo = v; });
      });
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
      ...(isTransactionKind(this.kind) ? {
        ...(this.expectedTime ? { expectedTime: this.expectedTime } : {}),
        ...(this.expectedRepeat ? { expectedRepeat: this.expectedRepeat } : {}),
      } : {}),
      ...(isFrameworkKind(this.kind) && (this.expectedSpanFrom || this.expectedSpanTo) ? {
        expectedSpan: {
          ...(this.expectedSpanFrom ? { from: this.expectedSpanFrom } : {}),
          ...(this.expectedSpanTo ? { to: this.expectedSpanTo } : {}),
        },
      } : {}),
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
  // 预期属性
  private expectedTime = '';
  private expectedRepeat = '';
  private expectedSpanFrom = '';
  private expectedSpanTo = '';

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
    this.expectedTime = (opts.node as any).expectedTime ?? '';
    this.expectedRepeat = (opts.node as any).expectedRepeat ?? '';
    const span = (opts.node as any).expectedSpan;
    this.expectedSpanFrom = span?.from ?? '';
    this.expectedSpanTo = span?.to ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('seqtk-modal');

    this.setTitle(`编辑 · ${NODE_KIND_LABELS[this.opts.node.kind]}`);

    // 名称靠左，状态靠右（类似节点行的展示形式）；展示名不可在属性模态框中更改（改名走行内重命名）
    const row = contentEl.createDiv('seqtk-inline-row');
    const left = row.createDiv('seqtk-inline-left');

    const nameInput = new TextComponent(left);
    nameInput.setValue(this.desc);
    nameInput.inputEl.readOnly = true;
    nameInput.inputEl.addClass('seqtk-modal-name-readonly');

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

    // 预期属性字段区（事务=预期时间+预期重复；框架=预期时间段）
    this.renderExpectedFields(contentEl);

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

  /** 按节点类型渲染预期属性字段区：事务=预期时间+预期重复；框架=预期时间段 */
  private renderExpectedFields(container: HTMLElement): void {
    if (isTransactionKind(this.opts.node.kind)) {
      new Setting(container).setName('预期时间').addText((t) => {
        t.inputEl.type = 'date';
        t.setValue(this.expectedTime);
        t.onChange((v) => { this.expectedTime = v; });
      });
      const repDesc = this.expectedRepeat ? describeCycleRule(this.expectedRepeat) : '如 D-r3（每3日）、W-r2-i4D（每两周第4日）';
      const rep = new Setting(container).setName('预期重复').setDesc(repDesc);
      rep.addText((t) => {
        t.setPlaceholder('D-r3');
        t.setValue(this.expectedRepeat);
        t.onChange((v) => {
          this.expectedRepeat = v;
          rep.setDesc(v ? describeCycleRule(v) : '如 D-r3（每3日）、W-r2-i4D（每两周第4日）');
        });
      });
    } else if (isFrameworkKind(this.opts.node.kind)) {
      new Setting(container).setName('预期时间段').setDesc('起止日期').addText((t) => {
        t.inputEl.type = 'date';
        t.setPlaceholder('起');
        t.setValue(this.expectedSpanFrom);
        t.onChange((v) => { this.expectedSpanFrom = v; });
      }).addText((t) => {
        t.inputEl.type = 'date';
        t.setPlaceholder('止');
        t.setValue(this.expectedSpanTo);
        t.onChange((v) => { this.expectedSpanTo = v; });
      });
    }
  }

  /** 保存元数据并跳转到文件编辑正文 */
  private confirmAndOpen(): void {
    if (!this.desc.trim()) return;
    this.opts.onSubmit({
      desc: this.desc.trim(),
      state: this.state,
      ...(this.opts.node.kind === 'event' ? { nature: this.nature } : {}),
      // 编辑场景无条件发送预期字段，空值由保存方删除键以支持清空
      ...(isTransactionKind(this.opts.node.kind) ? {
        expectedTime: this.expectedTime,
        expectedRepeat: this.expectedRepeat,
      } : {}),
      ...(isFrameworkKind(this.opts.node.kind) ? {
        expectedSpan: { from: this.expectedSpanFrom, to: this.expectedSpanTo },
      } : {}),
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
      // 编辑场景无条件发送预期字段，空值由保存方删除键以支持清空
      ...(isTransactionKind(this.opts.node.kind) ? {
        expectedTime: this.expectedTime,
        expectedRepeat: this.expectedRepeat,
      } : {}),
      ...(isFrameworkKind(this.opts.node.kind) ? {
        expectedSpan: { from: this.expectedSpanFrom, to: this.expectedSpanTo },
      } : {}),
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
