/**
 * NodeEditorModal — 节点编辑模态框（替代 NodeEditorModal.svelte）
 * 
 * 使用 Obsidian Modal + Setting API 构建表单
 * 按 nodeType 动态渲染表单字段
 */

import { Modal, Setting } from 'obsidian';
import type { NodeType, AnyNode } from '../../types/index';
import { getStatusValues, isChainType, isJointStatusType } from '../../types/index';
import { getDisplayName } from '../../utils/timestamp';

export interface NodeEditorOptions {
  nodeType: NodeType;
  existingData?: AnyNode;
  existingNodeId?: string;
  /** 编辑模式下传入当前正文 */
  existingBody?: string;
  /** 链路节点：父节点候选列表 */
  parentCandidates?: { nodeId: string; data: AnyNode }[];
  presetParent?: string;
  /** 联合节点：子节点候选列表 */
  childCandidates?: { nodeId: string; data: AnyNode }[];
  /** 保存回调：frontmatter 变更 + 正文 */
  onSave: (data: Partial<AnyNode>, body: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理', doing: '进行中', paused: '已暂停',
  completed: '已完成', giveup: '已放弃',
  progress: '进行中', done: '已完成', cancelled: '已取消',
};

export class NodeEditorModal extends Modal {
  private options: NodeEditorOptions;
  private isEdit: boolean;

  // 表单数据
  private name = '';
  private body = '';
  private status = 'pending';
  private parent = '';
  private children: string[] = [];
  private deadline = '';
  private priority = 3;
  private estimatedTime = 0;
  private rule = '';
  private start = '';
  private end = '';

  constructor(app: import('obsidian').App, options: NodeEditorOptions) {
    super(app);
    this.options = options;
    this.isEdit = !!options.existingData;

    // 从已有数据初始化
    if (options.existingData) {
      const d = options.existingData as any;
      this.name = d.name ?? '';
      this.status = d.status ?? 'pending';
      this.parent = d.source ?? '';
      this.children = d.children ? [...d.children] : [];
      this.deadline = d.deadline ?? '';
      this.priority = d.priority ?? 3;
      this.estimatedTime = d.estimatedTime ?? 0;
      this.rule = d.rule ?? '';
      this.start = d.start ?? '';
      this.end = d.end ?? '';
    } else {
      this.status = getDefaultStatus(options.nodeType);
      this.parent = options.presetParent ?? '';
    }
    this.body = options.existingBody ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('node-editor-modal');

    // 标题
    contentEl.createEl('h3', { text: this.isEdit ? '编辑节点' : '新增节点' });

    const { nodeType } = this.options;

    // 名称
    new Setting(contentEl)
      .setName('名称')
      .setDesc('* 必填')
      .addText((text) => {
        text.setValue(this.name);
        text.setPlaceholder('输入节点名称');
        text.onChange((v) => { this.name = v; });
        setTimeout(() => text.inputEl.focus(), 100);
      });

    // 正文（描述）
    const bodySetting = new Setting(contentEl).setName('描述（正文）');
    const bodyArea = contentEl.createEl('textarea', {
      cls: 'node-editor-body-input',
      attr: { rows: '4', placeholder: '输入描述...' },
    });
    bodyArea.value = this.body;
    bodyArea.addEventListener('input', () => { this.body = bodyArea.value; });
    bodySetting.settingEl.appendChild(bodyArea);

    // 状态（期望/方向不显示）
    if (nodeType !== 'desire' && nodeType !== 'direct') {
      const statusOpts = getStatusValues(nodeType);
      // 一式多份语义：对 list/rite/event 类型，status 字段是「初始属性」
      // 而非「当前执行状态」。UI 标签相应改为「初始状态」并添加说明，
      // 让用户理解此值会在节点加入 Cycle 周期时作为周期状态的起始种子。
      // 非 list/rite/event 类型保持原「状态」标签不变。
      const isInitialStatus = isJointStatusType(nodeType);
      const setting = new Setting(contentEl)
        .setName(isInitialStatus ? '初始状态' : '状态');
      if (isInitialStatus) {
        setting.setDesc('此值将在节点加入周期时作为初始状态');
      }
      setting.addDropdown((dd) => {
          for (const opt of statusOpts) {
            dd.addOption(opt, STATUS_LABELS[opt] ?? opt);
          }
          dd.setValue(this.status);
          dd.onChange((v) => { this.status = v; });
        });
    }

    // 父节点（链路节点，非 desire）
    const needsParent = isChainType(nodeType) && nodeType !== 'desire';
    if (needsParent) {
      const candidates = this.options.parentCandidates ?? [];
      new Setting(contentEl)
        .setName('父节点')
        .addDropdown((dd) => {
          dd.addOption('', '（无）');
          for (const c of candidates) {
            const displayName = getDisplayName(c.nodeId);
            const wikilink = `[[${c.nodeId}]]`;
            dd.addOption(wikilink, displayName || c.data.name);
          }
          dd.setValue(this.parent);
          dd.onChange((v) => { this.parent = v; });
        });
    }

    // 子节点（联合节点：cycle/list/event）
    const needsChildren = nodeType === 'cycle' || nodeType === 'list' || nodeType === 'event';
    if (needsChildren) {
      const candidates = this.options.childCandidates ?? [];
      this.renderChildrenEditor(contentEl, candidates);
    }

    // 截止日期
    const needsDeadline = nodeType === 'taskchain' || nodeType === 'taskitem';
    if (needsDeadline) {
      new Setting(contentEl)
        .setName('截止日期')
        .addText((text) => {
          text.inputEl.type = 'date';
          text.setValue(this.deadline);
          text.onChange((v) => { this.deadline = v; });
        });
    }

    // 优先级
    const needsPriority = nodeType === 'taskchain' || nodeType === 'taskitem';
    if (needsPriority) {
      new Setting(contentEl)
        .setName('优先级')
        .addSlider((slider) => {
          slider.setLimits(1, 5, 1);
          slider.setValue(this.priority);
          slider.setDynamicTooltip();
          slider.onChange((v) => { this.priority = v; });
        });
    }

    // 预估耗时
    if (nodeType === 'taskitem') {
      new Setting(contentEl)
        .setName('预估耗时（小时）')
        .addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = '0';
          text.inputEl.step = '0.5';
          text.setValue(String(this.estimatedTime));
          text.onChange((v) => { this.estimatedTime = parseFloat(v) || 0; });
        });
    }

    // 循环规则信息（只读，taskitem 编辑时显示）
    if (nodeType === 'taskitem' && this.isEdit) {
      const raw = this.options.existingData as any;
      if (raw?.cycleRule) {
        const ruleSetting = new Setting(contentEl)
          .setName('♺ 循环规则');
        const targetLabel = raw.cycleRuleTarget === 'pending' ? '重置为待处理' : '自动开始执行';
        ruleSetting.setDesc(`${raw.cycleRule} | 触发后${targetLabel}`);
      }
    }

    // 规则
    const needsRule = nodeType === 'cycle' || nodeType === 'rite';
    if (needsRule) {
      new Setting(contentEl)
        .setName('规则')
        .addText((text) => {
          text.setValue(this.rule);
          text.setPlaceholder('如：每天、每周一三五');
          text.onChange((v) => { this.rule = v; });
        });
    }

    // 事件时间
    if (nodeType === 'event') {
      new Setting(contentEl)
        .setName('开始时间')
        .addText((text) => {
          text.inputEl.type = 'datetime-local';
          text.setValue(this.start);
          text.onChange((v) => { this.start = v; });
        });
      new Setting(contentEl)
        .setName('结束时间')
        .addText((text) => {
          text.inputEl.type = 'datetime-local';
          text.setValue(this.end);
          text.onChange((v) => { this.end = v; });
        });
    }

    // 底部按钮
    const footerEl = contentEl.createEl('div', { cls: 'node-editor-footer' });

    const cancelBtn = footerEl.createEl('button', { cls: 'btn cancel', text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = footerEl.createEl('button', { cls: 'btn primary', text: this.isEdit ? '保存' : '创建' });
    saveBtn.addEventListener('click', () => this.handleSave());

    // Ctrl+Enter 保存，Escape 取消
    this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter' && e.ctrlKey) this.handleSave();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private handleSave(): void {
    if (!this.name.trim()) return;

    const noStatus = this.options.nodeType === 'desire' || this.options.nodeType === 'direct';
    const data: Record<string, any> = {
      type: this.options.nodeType,
      name: this.name.trim(),
    };
    if (!noStatus) data.status = this.status;

    const needsParent = isChainType(this.options.nodeType) && this.options.nodeType !== 'desire';
    if (needsParent) data.source = this.parent;

    const needsChildren = this.options.nodeType === 'cycle' || this.options.nodeType === 'list' || this.options.nodeType === 'event';
    if (needsChildren) data.children = this.children.filter(p => p);

    const needsDeadline = this.options.nodeType === 'taskchain' || this.options.nodeType === 'taskitem';
    if (needsDeadline && this.deadline) data.deadline = this.deadline;

    const needsPriority = this.options.nodeType === 'taskchain' || this.options.nodeType === 'taskitem';
    if (needsPriority) data.priority = this.priority;

    if (this.options.nodeType === 'taskitem' && this.estimatedTime > 0) data.estimatedTime = this.estimatedTime;

    const needsRule = this.options.nodeType === 'cycle' || this.options.nodeType === 'rite';
    if (needsRule && this.rule) data.rule = this.rule;

    if (this.options.nodeType === 'event') {
      if (this.start) data.start = this.start;
      if (this.end) data.end = this.end;
    }

    this.options.onSave(data as Partial<AnyNode>, this.body.trim());
    this.close();
  }

  private renderChildrenEditor(container: HTMLElement, candidates: { nodeId: string; data: AnyNode }[]): void {
    const setting = new Setting(container).setName('子节点（可多选）');

    const listEl = container.createEl('div', { cls: 'node-editor-children-list' });

    const renderList = () => {
      listEl.empty();
      for (let i = 0; i < this.children.length; i++) {
        const row = listEl.createEl('div', { cls: 'node-editor-child-row' });

        const dd = row.createEl('select');
        dd.createEl('option', { value: '', text: '（无）' });
        for (const c of candidates) {
          const displayName = getDisplayName(c.nodeId);
          const wikilink = `[[${c.nodeId}]]`;
          const opt = dd.createEl('option', { value: wikilink, text: displayName || c.data.name });
          if (wikilink === this.children[i]) opt.selected = true;
        }
        dd.value = this.children[i] ?? '';
        dd.addEventListener('change', () => { this.children[i] = dd.value; });

        const removeBtn = row.createEl('button', { cls: 'node-editor-remove-btn', text: '×' });
        removeBtn.addEventListener('click', () => {
          this.children.splice(i, 1);
          renderList();
        });
      }
    };

    renderList();

    const addBtn = listEl.createEl('button', { cls: 'node-editor-add-btn', text: '+ 添加子节点' });
    addBtn.addEventListener('click', () => {
      this.children.push('');
      renderList();
    });
  }
}

function getDefaultStatus(nodeType: NodeType): string {
  return nodeType === 'event' ? 'pending' : 'pending';
}
