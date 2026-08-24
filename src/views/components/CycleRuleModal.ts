/**
 * CycleRuleModal — 循环规则编辑模态框
 *
 * 支持两种模式：
 *   - taskitem：规则存储在任务项自身 frontmatter（cycleRule/cycleRuleBase/cycleRuleTarget）
 *   - rite：规则存储在所属 Cycle 的 cycleRules 扁平列表中
 *
 * 表单包含：
 *   - 主单位选择（年/月/周/日/时/分）+ 间隔数输入
 *   - 附加规则列表（子间隔，支持倒数模式）
 *   - 基准日期时间选择
 *   - 触发后目标状态选择（pending/doing）
 *   - 实时预览：描述文字 + 未来 5 次触发时间
 *   - 保存/清除/取消按钮
 */

import { Modal, Notice } from 'obsidian';
import type { NodeCache } from '../../core/NodeCache';
import type { NodeFileManager } from '../../core/NodeFileManager';
import type { OperationQueue } from '../../core/OperationQueue';
import type { CycleRuleEntry } from '../../types/index';
import { unpackCycleRules, packCycleRules } from '../../types/index';
import type { CycleSubInterval, CycleRule } from '../../utils/cycleRuleParser';
import {
  parseCycleRule,
  buildCycleRuleString,
  validateCycleRule,
  getUpcomingTriggers,
  describeCycleRule,
} from '../../utils/cycleRuleParser';

// ============================================================
// 单位层级（用于联动过滤）
// ============================================================

const UNIT_HIERARCHY: Record<string, number> = {
  Y: 6, M: 5, W: 4, D: 3, h: 2, m: 1,
};

const UNIT_RANGE: Record<string, { min: number; max: number }> = {
  Y: { min: 1, max: 999 },
  M: { min: 1, max: 12 },
  W: { min: 1, max: 5 },
  D: { min: 1, max: 31 },
  h: { min: 0, max: 23 },
  m: { min: 0, max: 59 },
};

const ALL_UNITS = [
  { value: 'Y', label: '年' },
  { value: 'M', label: '月' },
  { value: 'W', label: '周' },
  { value: 'D', label: '日' },
  { value: 'h', label: '时' },
  { value: 'm', label: '分' },
];

// ============================================================
// 模态框选项
// ============================================================

export interface CycleRuleModalOptions {
  /** 目标类型 */
  targetType: 'taskitem' | 'rite';
  /** 目标节点 ID */
  nodeId: string;
  /** rite 模式下必须提供所属 Cycle 的 ID */
  cycleId?: string;
  /** NodeCache 实例 */
  nodeCache: NodeCache;
  /** NodeFileManager 实例 */
  fileManager: NodeFileManager;
  /** OperationQueue 实例 */
  operationQueue: OperationQueue;
  /** 保存后的回调 */
  onSave?: () => void;
}

// ============================================================
// CycleRuleModal
// ============================================================

export class CycleRuleModal extends Modal {
  private options: CycleRuleModalOptions;

  // 表单状态
  private unit: string;
  private intervalNum: number;
  private subIntervals: CycleSubInterval[];
  private baseTimeStr: string;
  private targetState: 'pending' | 'doing';
  private onlyCompleted: boolean;

  // DOM 引用
  private previewEl: HTMLElement | null = null;
  private addSubBtn: HTMLElement | null = null;
  private subListEl: HTMLElement | null = null;

  constructor(app: import('obsidian').App, options: CycleRuleModalOptions) {
    super(app);
    this.options = options;

    // 从已有规则初始化表单状态
    const existing = this.loadExistingRule();
    if (existing) {
      const parsed = parseCycleRule(existing.rule);
      if (parsed) {
        this.unit = parsed.unit;
        this.intervalNum = parsed.interval;
        this.subIntervals = parsed.subIntervals.map(s => ({ ...s }));
      } else {
        this.unit = 'D';
        this.intervalNum = 1;
        this.subIntervals = [];
      }
      this.baseTimeStr = existing.base;
      this.targetState = existing.target;
      this.onlyCompleted = existing.onlyCompleted;
    } else {
      this.unit = 'D';
      this.intervalNum = 1;
      this.subIntervals = [];
      this.baseTimeStr = window.moment().format('YYYY-MM-DD HH:mm');
      this.targetState = 'doing';
      this.onlyCompleted = true;
    }
  }

  /**
   * 加载已有的循环规则
   */
  private loadExistingRule(): { rule: string; base: string; target: 'pending' | 'doing'; onlyCompleted: boolean } | null {
    const { targetType, nodeId, cycleId, nodeCache } = this.options;

    if (targetType === 'taskitem') {
      const data = nodeCache.getNode(nodeId) as any;
      if (!data?.cycleRule) return null;
      return {
        rule: data.cycleRule,
        base: data.cycleRuleBase || data.executionTime || '',
        target: data.cycleRuleTarget || 'doing',
        onlyCompleted: data.cycleRuleOnlyCompleted !== false,
      };
    } else {
      // rite 模式
      if (!cycleId) return null;
      const info = nodeCache.getRiteCycleRuleInfo(cycleId, nodeId);
      if (!info) return null;
      // 从 CycleRuleEntry 读取 onlyCompleted
      const entries = nodeCache.getCycleRuleEntries(cycleId);
      const entry = entries.find(e => e.nodeId === nodeId);
      return {
        rule: info.rule,
        base: info.baseTime,
        target: info.target,
        onlyCompleted: entry?.onlyCompleted !== false,
      };
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    const { targetType, nodeId, nodeCache } = this.options;
    const nodeData = nodeCache.getNode(nodeId);
    const nodeName = nodeData?.name ?? nodeId;

    this.setTitle(`♺ 设置循环规则: ${nodeName}`);

    // ── 重复规则区域 ──
    const ruleSection = contentEl.createEl('div', { cls: 'cycle-rule-section' });

    // 主要重复
    const mainRow = ruleSection.createEl('div', { cls: 'cycle-rule-row' });
    mainRow.createEl('span', { text: '每 ' });

    const intervalInput = mainRow.createEl('input', {
      cls: 'cycle-rule-input-number',
      attr: { type: 'number', min: '1', max: '999' },
    });
    intervalInput.value = String(this.intervalNum);
    intervalInput.addEventListener('change', () => {
      const v = parseInt(intervalInput.value, 10);
      this.intervalNum = isNaN(v) || v < 1 ? 1 : v;
      this.updatePreview();
    });

    const unitSelect = mainRow.createEl('select', { cls: 'cycle-rule-select' });
    for (const u of ALL_UNITS) {
      unitSelect.createEl('option', { value: u.value, text: u.label });
    }
    unitSelect.value = this.unit;
    unitSelect.addEventListener('change', () => {
      this.unit = unitSelect.value;
      // 当主单位变小时，移除不合法的子间隔
      this.subIntervals = this.subIntervals.filter(s =>
        UNIT_HIERARCHY[s.unit] < UNIT_HIERARCHY[this.unit],
      );
      this.rebuildSubIntervalUI();
      this.updatePreview();
      this.updateAddBtnVisibility();
    });

    // 附加规则列表
    this.subListEl = ruleSection.createEl('div', { cls: 'cycle-rule-sub-list' });
    this.rebuildSubIntervalUI();

    // 添加附加规则按钮
    this.addSubBtn = ruleSection.createEl('button', {
      cls: 'cycle-rule-add-sub',
      text: '＋ 附加重复',
    });
    this.addSubBtn.addEventListener('click', () => {
      const availableUnit = this.getLargestAvailableUnit();
      if (!availableUnit) return;
      this.subIntervals.push({ reverse: false, count: 1, unit: availableUnit });
      this.rebuildSubIntervalUI();
      this.updatePreview();
    });
    this.updateAddBtnVisibility();

    // ── 基准日期 ──
    const baseSection = contentEl.createEl('div', { cls: 'cycle-rule-section' });
    const baseRow = baseSection.createEl('div', { cls: 'cycle-rule-row' });
    baseRow.createEl('span', { text: '起始于 ' });
    const baseInput = baseRow.createEl('input', {
      cls: 'cycle-rule-input-datetime',
      attr: { type: 'datetime-local' },
    });
    baseInput.value = this.baseTimeStr.replace(' ', 'T');
    baseInput.addEventListener('change', () => {
      this.baseTimeStr = baseInput.value.replace('T', ' ');
      this.updatePreview();
    });

    // ── 目标状态 ──
    const targetSection = contentEl.createEl('div', { cls: 'cycle-rule-section' });
    const targetRow = targetSection.createEl('div', { cls: 'cycle-rule-row' });
    targetRow.createEl('span', { text: '触发后 ' });
    const targetSelect = targetRow.createEl('select', { cls: 'cycle-rule-select' });
    targetSelect.createEl('option', { value: 'doing', text: '自动开始执行（进行中）' });
    targetSelect.createEl('option', { value: 'pending', text: '重置为待处理' });
    targetSelect.value = this.targetState;
    targetSelect.addEventListener('change', () => {
      this.targetState = targetSelect.value as 'pending' | 'doing';
    });

    // ── 仅已完成触发 ──
    const onlyRow = targetSection.createEl('div', { cls: 'cycle-rule-row' });
    const onlyLabel = onlyRow.createEl('label', { cls: 'cycle-rule-checkbox-label' });
    const onlyCheckbox = onlyLabel.createEl('input', { attr: { type: 'checkbox' } });
    onlyCheckbox.checked = this.onlyCompleted;
    onlyCheckbox.addEventListener('change', () => {
      this.onlyCompleted = onlyCheckbox.checked;
    });
    onlyLabel.createEl('span', { text: ' 仅对已完成状态生效' });

    // ── 规则预览 ──
    const previewSection = contentEl.createEl('div', { cls: 'cycle-rule-section' });
    this.previewEl = previewSection.createEl('div', { cls: 'cycle-rule-preview' });
    this.updatePreview();

    // ── 操作按钮 ──
    const actionRow = contentEl.createEl('div', { cls: 'cycle-rule-actions' });

    const saveBtn = actionRow.createEl('button', {
      cls: 'cycle-rule-btn cycle-rule-btn-primary',
      text: '✓ 保存',
    });
    saveBtn.addEventListener('click', () => this.saveRule());

  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ============================================================
  // 附加间隔 UI
  // ============================================================

  private rebuildSubIntervalUI(): void {
    const subListEl = this.subListEl;
    if (!subListEl) return;
    subListEl.empty();

    if (this.subIntervals.length === 0) {
      subListEl.createEl('div', {
        cls: 'cycle-rule-sub-empty',
        text: '暂无附加规则',
      });
      return;
    }

    const mainLevel = UNIT_HIERARCHY[this.unit];

    for (let i = 0; i < this.subIntervals.length; i++) {
      const sub = this.subIntervals[i];
      const row = subListEl.createEl('div', { cls: 'cycle-rule-row cycle-rule-sub-row' });

      row.createEl('span', { text: '第 ' });

      // 位置输入
      const range = UNIT_RANGE[sub.unit] ?? { min: 0, max: 999 };
      const countInput = row.createEl('input', {
        cls: 'cycle-rule-input-number',
        attr: { type: 'number', min: String(range.min), max: String(range.max) },
      });
      countInput.value = String(sub.count);
      countInput.addEventListener('change', () => {
        const v = parseInt(countInput.value, 10);
        const r = UNIT_RANGE[this.subIntervals[i].unit] ?? { min: 0, max: 999 };
        this.subIntervals[i].count = isNaN(v) ? r.min : Math.max(r.min, Math.min(r.max, v));
        this.updatePreview();
      });

      row.createEl('span', { text: ' ' });

      // 单位选择
      const subUnitSelect = row.createEl('select', { cls: 'cycle-rule-select' });
      const availableUnits = ALL_UNITS.filter(u => UNIT_HIERARCHY[u.value] < mainLevel);
      for (const u of availableUnits) {
        subUnitSelect.createEl('option', { value: u.value, text: u.label });
      }
      subUnitSelect.value = sub.unit;
      subUnitSelect.addEventListener('change', () => {
        this.subIntervals[i].unit = subUnitSelect.value;
        const newRange = UNIT_RANGE[subUnitSelect.value] ?? { min: 0, max: 999 };
        countInput.min = String(newRange.min);
        countInput.max = String(newRange.max);
        if (this.subIntervals[i].count < newRange.min || this.subIntervals[i].count > newRange.max) {
          this.subIntervals[i].count = newRange.min;
          countInput.value = String(newRange.min);
        }
        this.updatePreview();
      });

      // 行末操作按钮
      const spacer = row.createEl('span', { cls: 'cycle-rule-row-spacer' });

      // 倒数文字按钮
      const reverseBtn = row.createEl('span', {
        cls: `cycle-rule-text-btn${sub.reverse ? ' active' : ''}`,
        text: '倒数',
      });
      reverseBtn.addEventListener('click', () => {
        this.subIntervals[i].reverse = !this.subIntervals[i].reverse;
        this.rebuildSubIntervalUI();
        this.updatePreview();
      });

      // 删除文字按钮
      const delBtn = row.createEl('span', {
        cls: 'cycle-rule-text-btn cycle-rule-text-btn-danger',
        text: '删除',
      });
      delBtn.addEventListener('click', () => {
        this.subIntervals.splice(i, 1);
        this.rebuildSubIntervalUI();
        this.updatePreview();
      });
    }
    this.updateAddBtnVisibility();
  }

  private updateAddBtnVisibility(): void {
    if (!this.addSubBtn) return;
    const available = this.getLargestAvailableUnit();
    this.addSubBtn.style.display = available ? '' : 'none';
  }

  private getLargestAvailableUnit(): string | null {
    const mainLevel = UNIT_HIERARCHY[this.unit];
    const usedLevels = new Set(this.subIntervals.map(s => UNIT_HIERARCHY[s.unit]));
    // 从大到小找第一个未使用且小于主单位的
    for (const u of ALL_UNITS) {
      const level = UNIT_HIERARCHY[u.value];
      if (level < mainLevel && !usedLevels.has(level)) {
        return u.value;
      }
    }
    return null;
  }

  // ============================================================
  // 预览
  // ============================================================

  private updatePreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();

    const rule: CycleRule = {
      unit: this.unit,
      interval: this.intervalNum,
      subIntervals: this.subIntervals.map(s => ({ ...s })),
    };
    const ruleString = buildCycleRuleString(rule);
    const error = validateCycleRule(ruleString);

    if (error) {
      this.previewEl.createEl('div', {
        cls: 'cycle-rule-preview-error',
        text: `⚠ ${error}`,
      });
      return;
    }

    // 描述
    const desc = describeCycleRule(ruleString);
    this.previewEl.createEl('div', {
      cls: 'cycle-rule-preview-desc',
      text: desc,
    });

    // 未来触发时间
    const baseTime = window.moment(this.baseTimeStr, 'YYYY-MM-DD HH:mm');
    const now = window.moment();

    if (baseTime.isValid()) {
      const upcoming = getUpcomingTriggers(ruleString, baseTime, now, 5);
      if (upcoming.length > 0) {
        const listEl = this.previewEl.createEl('div', { cls: 'cycle-rule-preview-triggers' });
        for (const t of upcoming) {
          listEl.createEl('div', {
            cls: 'cycle-rule-preview-trigger-item',
            text: t.format('YYYY-MM-DD HH:mm (ddd)'),
          });
        }
      } else {
        this.previewEl.createEl('div', {
          cls: 'cycle-rule-preview-error',
          text: '⚠ 无法计算触发时间',
        });
      }
    }
  }

  // ============================================================
  // 保存 / 清除
  // ============================================================

  private async saveRule(): Promise<void> {
    const rule: CycleRule = {
      unit: this.unit,
      interval: this.intervalNum,
      subIntervals: this.subIntervals.map(s => ({ ...s })),
    };
    const ruleString = buildCycleRuleString(rule);
    const error = validateCycleRule(ruleString);
    if (error) {
      new Notice(`⚠ 规则无效: ${error}`);
      return;
    }

    const { targetType, nodeId, cycleId, nodeCache, fileManager, operationQueue } = this.options;

    if (targetType === 'taskitem') {
      // 保存到 taskitem 自身
      const updates = {
        cycleRule: ruleString,
        cycleRuleBase: this.baseTimeStr,
        cycleRuleTarget: this.targetState,
        cycleRuleOnlyCompleted: this.onlyCompleted,
      };

      operationQueue.enqueue(
        () => nodeCache.updateNode(nodeId, updates as any),
        async () => { await fileManager.updateNode('taskitem', nodeId, updates as any); },
      );
    } else if (targetType === 'rite' && cycleId) {
      // 保存到 Cycle 的 cycleRules
      const entry: CycleRuleEntry = {
        nodeId,
        rule: ruleString,
        base: this.baseTimeStr,
        target: this.targetState,
        onlyCompleted: this.onlyCompleted,
      };

      const entries = nodeCache.getCycleRuleEntries(cycleId);
      const idx = entries.findIndex(e => e.nodeId === nodeId);
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
      const newFlat = packCycleRules(entries);
      const currentPs = (nodeCache.getNode(cycleId) as any)?.periodStates;

      operationQueue.enqueue(
        () => nodeCache.updateNode(cycleId, { cycleRules: newFlat } as any),
        async () => { await fileManager.updateNode('cycle', cycleId, { cycleRules: newFlat, periodStates: currentPs } as any); },
      );
    }

    this.close();
    this.options.onSave?.();
  }

  private async clearRule(): Promise<void> {
    const { targetType, nodeId, cycleId, nodeCache, fileManager, operationQueue } = this.options;

    if (targetType === 'taskitem') {
      const updates = {
        cycleRule: undefined,
        cycleRuleBase: undefined,
        cycleRuleTarget: undefined,
      };

      operationQueue.enqueue(
        () => nodeCache.updateNode(nodeId, updates as any),
        async () => { await fileManager.updateNode('taskitem', nodeId, updates as any); },
      );
    } else if (targetType === 'rite' && cycleId) {
      nodeCache.removeCycleRuleEntry(cycleId, nodeId);

      // 获取更新后的 cycleRules 用于文件写入
      const entries = nodeCache.getCycleRuleEntries(cycleId);
      const newFlat = entries.length > 0 ? packCycleRules(entries) : undefined;
      const currentPs = (nodeCache.getNode(cycleId) as any)?.periodStates;

      operationQueue.enqueueFileOp(async () => {
        await fileManager.updateNode('cycle', cycleId, { cycleRules: newFlat, periodStates: currentPs } as any);
      });
    }

    this.close();
    this.options.onSave?.();
  }
}
