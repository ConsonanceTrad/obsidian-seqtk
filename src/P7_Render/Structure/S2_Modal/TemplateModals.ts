/**
 * TemplateModals — 模板相关共享模态框（事务设计右键「创建/使用模板」与模板模式共用）
 *
 * 自 old/0.1.2/src/views/components/TemplateModals.ts 迁入。
 * 保持 Obsidian 原生 Modal + Setting 实现、不 React 化（决策 dec-db13741643639699）。
 *
 * - SelectFrameworkModal：选择目标框架（模板框架 / 目标框架）
 * - listTemplateUnits / TemplateUnitSelectModal：「使用模板」时选择模板单元
 *
 * 数据面：只依赖 DataPipe 的只读门面（GET_ByKind / GET_Children / COLLECT_Descendants），
 * 不直接持有 NodeCache。
 */

import { App, Modal, Setting } from 'obsidian';
import { NODE_KIND } from '../../../P4_Nodes/NodeKind/NodeKind';
import { NODE_KIND_LABELS } from '../../../P4_Nodes/NodeKind/NodeLabel';
import type { SeqtkNode } from '../../../P4_Nodes/Node';
import type { DataPipe } from '../../../P5_Data/CoPipe/DataPipe';

/** 框架下拉候选 */
export interface FrameworkOption {
  nodeId: string;
  label: string;
}

/** 选择框架模态框 */
export class SelectFrameworkModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string;
      /** 候选框架（nodeId + 展示名） */
      frameworks: FrameworkOption[];
      onSelect: (nodeId: string) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.opts.title);

    let selected = this.opts.frameworks[0]?.nodeId ?? '';
    new Setting(contentEl)
      .setName('目标框架')
      .addDropdown((dd) => {
        for (const f of this.opts.frameworks) {
          dd.addOption(f.nodeId, f.label);
        }
        dd.setValue(selected);
        dd.onChange((v) => { selected = v; });
      });

    new Setting(contentEl).addButton((b) => {
      b.setButtonText('确定').setCta().onClick(() => {
        if (selected) this.opts.onSelect(selected);
        this.close();
      });
    }).addButton((b) => {
      b.setButtonText('取消').onClick(() => this.close());
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 模板单元条目（顶层节点 + 所属模板框架 + 子树规模） */
export interface TemplateUnitEntry {
  /** 所属模板框架 */
  framework: { nodeId: string; desc: string };
  /** 模板单元（顶层节点） */
  unit: { nodeId: string; data: SeqtkNode };
  /** 子树规模（含自身） */
  subtreeSize: number;
}

/**
 * 枚举全部模板单元：各模板框架 follows 直接子节点按框架声明序排列。
 * 单元含整棵子树（后代节点）；后续「插入时行为」扩展（是否含证据等）在此集中调整。
 */
export function listTemplateUnits(pipe: DataPipe): TemplateUnitEntry[] {
  const units: TemplateUnitEntry[] = [];
  for (const f of pipe.GET_ByKind(NODE_KIND.TEMP)) {
    for (const child of pipe.GET_Children(f.nodeId)) {
      if (!child.data) continue;
      units.push({
        framework: { nodeId: f.nodeId, desc: f.data.desc },
        unit: { nodeId: child.nodeId, data: child.data },
        subtreeSize: 1 + pipe.COLLECT_Descendants(child.nodeId).length,
      });
    }
  }
  return units;
}

/**
 * 选择模板单元模态框：列出全部模板单元并支持展开预览其子树，选中后回调并关闭。
 *
 * 每单元一行：▸ 展开/收起直接子级（只读预览，可逐层展开）｜类型徽章｜名称与元信息｜「使用」按钮。
 */
export class TemplateUnitSelectModal extends Modal {
  constructor(
    app: App,
    private pipe: DataPipe,
    private opts: {
      units: TemplateUnitEntry[];
      /** 选定单元（含其所属模板框架）后的回调 */
      onSelect: (entry: TemplateUnitEntry) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('使用模板 · 选择模板单元');

    if (this.opts.units.length === 0) {
      contentEl.createEl('div', {
        cls: 'seqtk-empty',
        text: '暂无模板单元：可在右键「存为模板」或模板模式中创建',
      });
      return;
    }

    const listEl = contentEl.createDiv();
    listEl.style.maxHeight = '60vh';
    listEl.style.overflowY = 'auto';

    for (const entry of this.opts.units) {
      this.renderUnitRow(listEl, entry);
    }
  }

  /** 渲染一个模板单元条目行（含可展开的子树预览） */
  private renderUnitRow(listEl: HTMLElement, entry: TemplateUnitEntry): void {
    const row = listEl.createDiv();
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.padding = '6px 4px';
    row.style.cursor = 'pointer';
    row.style.borderBottom = '1px solid var(--background-modifier-border, #ddd)';

    const toggle = row.createEl('span');
    toggle.style.width = '12px';
    toggle.style.flexShrink = '0';
    toggle.setText('▸');

    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[entry.unit.data.kind] });

    const info = row.createDiv();
    info.style.minWidth = '0';
    const name = info.createEl('span');
    name.setText(entry.unit.data.desc);
    const meta = info.createEl('span');
    meta.style.opacity = '0.6';
    meta.style.fontSize = '0.85em';
    meta.setText(` · 来自「${entry.framework.desc}」 · 含 ${entry.subtreeSize} 节点`);
    meta.title = `模板单元：${entry.unit.data.desc}`;

    const spacer = row.createSpan();
    spacer.style.flex = '1';
    const useBtn = row.createEl('button', { text: '使用', cls: 'seqtk-btn' });
    useBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onSelect(entry);
      this.close();
    });

    // 子树预览容器（惰性渲染，仅列存在子级的层级）
    const subEl = listEl.createDiv();
    subEl.style.display = 'none';
    subEl.style.paddingLeft = '8px';
    subEl.style.borderLeft = '2px solid var(--background-modifier-border, #ddd)';
    subEl.style.marginLeft = '6px';

    let previewRendered = false;
    const renderPreview = () => {
      if (previewRendered) return;
      previewRendered = true;
      this.renderSubtreePreview(subEl, entry.unit.nodeId, 1);
    };

    row.addEventListener('click', () => {
      const open = subEl.style.display !== 'none';
      subEl.style.display = open ? 'none' : 'block';
      toggle.setText(open ? '▸' : '▾');
      if (!open) renderPreview();
    });
  }

  /** 递归渲染子树预览（只读，节点行同样支持逐层展开） */
  private renderSubtreePreview(container: HTMLElement, parentNodeId: string, depth: number): void {
    const children = this.pipe.GET_Children(parentNodeId);
    if (children.length === 0) {
      container.createEl('div', {
        text: '（无下级节点）',
      }).style.opacity = '0.5';
      return;
    }
    for (const child of children) {
      if (!child.data) continue;
      const childRow = container.createDiv();
      childRow.style.display = 'flex';
      childRow.style.alignItems = 'center';
      childRow.style.gap = '6px';
      childRow.style.padding = '3px 2px';
      childRow.style.cursor = 'pointer';

      const childToggle = childRow.createEl('span');
      childToggle.style.width = '12px';
      childToggle.style.flexShrink = '0';
      childToggle.setText(this.hasChildren(child.nodeId) ? '▸' : '');

      const badge = childRow.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[child.data.kind] });
      badge.style.fontSize = '0.8em';

      childRow.createEl('span', { text: child.data.desc }).style.opacity = '0.9';

      const subEl = container.createDiv();
      subEl.style.display = 'none';
      subEl.style.paddingLeft = `${depth * 14}px`;

      if (this.hasChildren(child.nodeId)) {
        childRow.addEventListener('click', () => {
          const open = subEl.style.display !== 'none';
          subEl.style.display = open ? 'none' : 'block';
          childToggle.setText(open ? '▸' : '▾');
          if (!open) this.renderSubtreePreview(subEl, child.nodeId, depth + 1);
        });
      }
    }
  }

  private hasChildren(nodeId: string): boolean {
    return this.pipe.GET_Children(nodeId).some((c) => !!c.data);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
