/**
 * FlowView — 事务设计 · 流程设计
 *
 * 双栏：左栏流程脚本（script-flow）列表；右栏「脚本程序」与「LAD 程序」切换制。
 * - 脚本为事实源（节点正文存放 flow 语法文本）
 * - 脚本态：textarea 编辑 + 解析错误红标
 * - LAD 态：LadRenderer 母线投影渲染 + 逆向转换（步骤拖拽重排 / 时间节点
 *   上移下移 / 增删内容块与步骤），修改经序列化写回脚本文本
 */

import { App, ItemView, Menu, Modal, Notice, Setting, TextComponent, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { parseFlowScript } from '../core/flow/parser';
import type { FlowScript, FlowLine, FlowLineItem, FlowTimeNode, FlowContentBlock } from '../core/flow/parser';
import { serializeFlowScript } from '../core/flow/serialize';
import { renderLad } from './components/LadRenderer';
import { TransactionCreateModal } from './components/TransactionModals';

export const VIEW_TYPE_FLOW = 'seqtk-flow';

/** 拖拽诊断日志前缀（定位拖放问题，验证后移除） */
const DIAG = '[SeqTK][Flow-DnD] ';

/** 通用多字段输入弹窗（替代 window.prompt，Obsidian Electron 不支持 prompt()） */
class FlowPromptModal extends Modal {
  constructor(
    app: App,
    private fields: { label: string; defaultValue?: string }[],
    private onConfirm: (values: string[]) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('seqtk-modal');
    this.setTitle('输入');
    const inputs: TextComponent[] = [];
    for (const f of this.fields) {
      new Setting(contentEl).setName(f.label).addText((tc) => {
        if (f.defaultValue) tc.setValue(f.defaultValue);
        inputs.push(tc);
        return tc;
      });
    }
    new Setting(contentEl).addButton((b) => {
      b.setButtonText('确认').setCta().onClick(() => {
        this.onConfirm(inputs.map((i) => i.getValue()));
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

export class FlowView extends ItemView {
  private leftEl!: HTMLElement;
  private flowContent!: HTMLElement;
  private modeBtn: HTMLButtonElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private textArea: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;
  private mode: 'script' | 'lad' = 'script';
  private currentScriptId: string | null = null;
  private currentText = '';
  private currentAst: FlowScript | null = null;
  private unsub: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FLOW;
  }

  getDisplayText(): string {
    return '流程设计';
  }

  getIcon(): string {
    return 'workflow';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');

    const right = split.createDiv('seqtk-split-right');
    // 标题行：单一模式切换按钮 + 保存
    const titleRow = right.createDiv('seqtk-board-titlebar');
    this.modeBtn = titleRow.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '切换到 LAD 程序' });
    this.modeBtn.addEventListener('click', () => this.switchMode(this.mode === 'script' ? 'lad' : 'script'));
    this.saveBtn = titleRow.createEl('button', { cls: 'seqtk-btn seqtk-btn-small seqtk-btn-primary', text: '保存' });
    this.saveBtn.addEventListener('click', () => this.save());

    // 右栏内容区（直接在 right 内创建，避免移动继承的 contentEl 导致父级嵌套）
    this.flowContent = right.createDiv('seqtk-flow-content');

    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.renderLeft();
      this.syncTitle();
    });
    this.renderLeft();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
  }

  // ============================================================
  // 左栏：流程脚本列表
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '流程脚本' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    const scripts = this.nodeCache.getByKind('script-flow');
    if (scripts.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无流程脚本（右键此处新建）' });
    } else {
      for (const { nodeId, data } of scripts) {
        const row = this.leftEl.createDiv('seqtk-flow-item');
        if (nodeId === this.currentScriptId) row.addClass('seqtk-flow-item-active');
        row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[data.kind] });
        row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
        row.addEventListener('click', () => this.selectScript(nodeId));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showScriptMenu(nodeId, data, e);
        });
      }
    }

    this.leftEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-flow-item')) return;
      e.preventDefault();
      this.showScriptMenu(null, null, e);
    });
  }

  private selectScript(nodeId: string): void {
    this.currentScriptId = nodeId;
    this.currentText = this.nodeCache.getNodeBody(nodeId);
    this.renderLeft();
    this.renderContent();
  }

  private showScriptMenu(nodeId: string | null, data: SeqtkNode | null, e: MouseEvent): void {
    const menu = new Menu();
    if (nodeId && data) {
      menu.addItem((item) =>
        item.setTitle('编辑').setIcon('pencil')
          .onClick(() => this.selectScript(nodeId)));
      menu.addItem((item) =>
        item.setTitle('打开文件').setIcon('file-text')
          .onClick(() => this.openNodeFile(data.kind, nodeId)));
      menu.addItem((item) =>
        item.setTitle('归档').setIcon('archive')
          .onClick(() => {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
              async () => { await this.fileManager.updateNode(data.kind, nodeId, { open: false }); },
            );
          }));
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle('删除').setIcon('trash')
          .onClick(() => {
            this.operationQueue.enqueueCacheOp(() => this.nodeCache.removeNode(nodeId));
            this.operationQueue.enqueueFileOp(async () => { await this.fileManager.deleteNode(data.kind, nodeId); });
          }));
    } else {
      menu.addItem((item) =>
        item.setTitle('新建流程脚本').setIcon('plus')
          .onClick(() => this.createScript()));
    }
    menu.showAtMouseEvent(e);
  }

  private createScript(): void {
    new TransactionCreateModal(this.app, {
      kinds: ['script-flow'],
      onSubmit: (input) => {
        const now = new Date().toISOString();
        const data = {
          kind: input.kind,
          desc: input.desc,
          open: true,
          create: now,
          modify: now,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          this.selectScript(nodeId);
        }).catch((e) => {
          console.error('[SeqTK] 新建流程脚本失败:', e);
          new Notice('新建流程脚本失败，请查看控制台');
        });
      },
    }).open();
  }

  private openNodeFile(kind: NodeKind, nodeId: string): void {
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(kind, nodeId));
    if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
  }

  // ============================================================
  // 右栏：模式切换与内容
  // ============================================================

  private switchMode(mode: 'script' | 'lad'): void {
    this.mode = mode;
    if (this.modeBtn) {
      this.modeBtn.setText(this.mode === 'script' ? '切换到 LAD 程序' : '切换到脚本程序');
      this.modeBtn.toggleClass('seqtk-btn-active', this.mode === 'lad');
    }
    this.renderContent();
  }

  private syncTitle(): void {
    // 标题随当前脚本显示（占位：无额外标题栏）
  }

  private renderContent(): void {
    this.flowContent.empty();
    if (!this.currentScriptId) {
      this.flowContent.createEl('div', { cls: 'seqtk-empty', text: '请在左侧选择流程脚本' });
      return;
    }
    if (this.mode === 'script') this.renderScriptMode();
    else this.renderLadMode();
  }

  // ---- 脚本态 ----

  private renderScriptMode(): void {
    const wrap = this.flowContent.createDiv('seqtk-flow-script');
    this.textArea = wrap.createEl('textarea', {
      cls: 'seqtk-flow-textarea',
      attr: { spellcheck: 'false' },
    });
    this.textArea.value = this.currentText;
    this.textArea.addEventListener('input', () => {
      this.currentText = this.textArea?.value ?? '';
      this.showParseErrors();
    });
    this.errorEl = wrap.createDiv('seqtk-flow-errors');
    this.showParseErrors();
  }

  private showParseErrors(): void {
    if (!this.errorEl) return;
    this.errorEl.empty();
    const ast = parseFlowScript(this.currentText);
    if (ast.errors.length === 0) {
      this.errorEl.createEl('div', { cls: 'seqtk-flow-ok', text: '语法正确' });
    } else {
      for (const err of ast.errors) {
        this.errorEl.createEl('div', {
          cls: 'seqtk-flow-err',
          text: `第 ${err.line} 行：${err.message}`,
        });
      }
    }
  }

  // ---- LAD 态（投影 + 逆向转换） ----

  private renderLadMode(): void {
    this.flowContent.empty();
    this.currentAst = parseFlowScript(this.currentText);
    const ast = this.currentAst;
    const wrap = this.flowContent.createDiv('seqtk-flow-lad');
    if (ast.errors.length > 0) {
      for (const err of ast.errors) {
        wrap.createEl('div', { cls: 'seqtk-flow-err', text: `第 ${err.line} 行：${err.message}` });
      }
      wrap.createEl('div', { cls: 'seqtk-empty', text: '存在语法错误，无法渲染 LAD（请在脚本态修正）' });
      return;
    }
    this.renderLadWithOps(wrap, ast);
  }

  /** 渲染 LAD 并挂逆向转换操作（右侧组件面板 + 拖拽添加） */
  private renderLadWithOps(wrap: HTMLElement, ast: FlowScript): void {
    wrap.createEl('div', {
      cls: 'seqtk-lad-hint',
      text: '提示：从右侧面板拖入组件添加；拖动步骤块重排顺序；时间节点可用 ↑↓ 移动；块内可增删内容块与步骤。修改即时写回脚本。',
    });
    const layout = wrap.createDiv('seqtk-lad-layout');
    const editArea = layout.createDiv('seqtk-lad-edit');
    this.renderPalette(layout);
    // 编辑区任意空白按类型智能归位：时间节点→时间轴、步骤类→第一条线路行、内容块→第一个时间节点
    const handleEditDrop = (type: string): void => {
      if (this.isTimeNodeType(type)) {
        this.addTimeNodeByDrop(type, ast.timeNodes);
      } else if (type === 'line') {
        this.addLineByDrop(() => ast.lines);
      } else if (type === 'step' || type === 'if' || type === 'not' || type === 'do') {
        if (ast.lines.length > 0) this.addLineItemByDrop(type, ast.lines[0]);
      } else if (ast.timeNodes.length > 0) {
        this.addContentByDrop(type, ast.timeNodes[0]);
      }
    };
    // 整个内容区（含 hint 下方、编辑区）空白处均可投放，悬停高亮
    this.attachDrop(editArea, handleEditDrop, 'seqtk-lad-zone-active');
    this.attachDrop(wrap, handleEditDrop, 'seqtk-lad-zone-active');
    this.renderLadStructure(editArea, ast);
  }

  /** 右侧预设组件面板（拖拽添加到编辑区） */
  private renderPalette(layout: HTMLElement): void {
    const palette = layout.createDiv('seqtk-lad-palette');
    palette.createEl('div', { cls: 'seqtk-lad-palette-title', text: '组件' });
    const items: { type: string; label: string; cls: string }[] = [
      { type: 'line', label: '例程', cls: 'seqtk-lad-line' },
      { type: 'step', label: '步骤', cls: 'seqtk-lad-step' },
      { type: 'if', label: 'IF 条件', cls: 'seqtk-lad-if' },
      { type: 'not', label: 'NOT 条件', cls: 'seqtk-lad-not' },
      { type: 'do', label: 'DO 动作', cls: 'seqtk-lad-do' },
      { type: 'lst', label: '清单内容', cls: 'seqtk-lad-content-kind' },
      { type: 'task', label: '事项内容', cls: 'seqtk-lad-content-kind' },
      { type: 'at', label: '时间点 at', cls: 'seqtk-lad-tn-time' },
      { type: 'span', label: '时间段 span', cls: 'seqtk-lad-tn-time' },
      { type: 'repeat', label: '周期 repeat', cls: 'seqtk-lad-tn-time' },
      { type: 'when', label: '条件使能 when', cls: 'seqtk-lad-tn-time' },
    ];
    for (const it of items) {
      const el = document.createElement('div');
      el.className = `seqtk-lad-palette-item ${it.cls}`;
      el.textContent = it.label;
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('seqtk/elem', it.type);
        e.dataTransfer!.effectAllowed = 'copy';
        console.log(DIAG, 'dragstart', 'type=', it.type);
      });
      palette.appendChild(el);
    }
    palette.createEl('div', {
      cls: 'seqtk-lad-palette-hint',
      text: '拖到线路行/时间节点/时间轴区域',
    });
  }

  /** 挂载拖放目标：dragover + drop 分发（drogover 用 types 判断组件拖拽，避免 getData 在 dragover 不可靠导致被禁止） */
  private attachDrop(el: HTMLElement, onDrop: (type: string) => void, hoverClass?: string): void {
    el.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? [];
      const hasType = types.includes('seqtk/elem');
      console.log(DIAG, 'dragover', 'target=', el.className, 'types=', types.join(','), 'pd=', hasType);
      if (!hasType) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (hoverClass) el.classList.add(hoverClass);
    });
    el.addEventListener('dragleave', () => {
      if (hoverClass) el.classList.remove(hoverClass);
    });
    el.addEventListener('drop', (e) => {
      const type = e.dataTransfer?.getData('seqtk/elem') ?? '';
      console.log(DIAG, 'drop', 'target=', el.className, 'type=', type);
      e.preventDefault();
      e.stopPropagation();
      if (hoverClass) el.classList.remove(hoverClass);
      if (type) onDrop(type);
    });
  }

  /** 时间节点类型判断 */
  private isTimeNodeType(type: string): boolean {
    return type === 'at' || type === 'span' || type === 'repeat' || type === 'when';
  }

  /** 投放插槽：时间节点块之间的空白条，拖时间节点类型可插入该位置 */
  private renderInsertSlot(parent: HTMLElement, onInsert: (type: string) => void): void {
    const slot = document.createElement('div');
    slot.className = 'seqtk-lad-slot';
    slot.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? [];
      const hasType = types.includes('seqtk/elem');
      console.log(DIAG, 'slot dragover', 'types=', types.join(','), 'pd=', hasType);
      if (!hasType) return;
      e.preventDefault();
      e.stopPropagation();
      slot.classList.add('seqtk-lad-slot-active');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('seqtk-lad-slot-active'));
    slot.addEventListener('drop', (e) => {
      const type = e.dataTransfer?.getData('seqtk/elem') ?? '';
      console.log(DIAG, 'slot drop', 'type=', type);
      if (this.isTimeNodeType(type)) {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('seqtk-lad-slot-active');
        onInsert(type);
      }
    });
    parent.appendChild(slot);
  }

  /** 根据拖入类型在时间节点列表插入节点（insertIndex 指定位置；缺省追加末尾） */
  private addTimeNodeByDrop(type: string, siblings: FlowTimeNode[], insertIndex?: number): void {
    const commit = (node: FlowTimeNode): void => {
      if (insertIndex !== undefined) siblings.splice(insertIndex, 0, node);
      else siblings.push(node);
      this.commitAst();
    };
    switch (type) {
      case 'at':
        new FlowPromptModal(this.app, [{ label: '时间点（如 08:00）', defaultValue: '08:00' }], ([time]) => {
          if (!time) return;
          commit({ type: 'at', time, lines: [], contents: [], children: [] });
        }).open();
        break;
      case 'span':
        new FlowPromptModal(this.app, [
          { label: '时间段名称', defaultValue: '' },
          { label: '开始（如 09:00）', defaultValue: '09:00' },
          { label: '结束（如 12:00）', defaultValue: '12:00' },
        ], ([name, from, to]) => {
          if (!from || !to) return;
          commit({ type: 'span', name: name || undefined, from, to, lines: [], contents: [], children: [] });
        }).open();
        break;
      case 'repeat':
        new FlowPromptModal(this.app, [
          { label: '周期规则名称', defaultValue: '' },
          { label: '周期（如 day/week）', defaultValue: 'day' },
          { label: '时刻（如 18:00）', defaultValue: '18:00' },
        ], ([name, every, time]) => {
          if (!every || !time) return;
          commit({ type: 'repeat', name: name || undefined, every, time, lines: [], contents: [], children: [] });
        }).open();
        break;
      case 'when':
        new FlowPromptModal(this.app, [{ label: '条件（如 工作日）', defaultValue: '' }], ([cond]) => {
          if (!cond) return;
          commit({ type: 'when', when: cond, lines: [], contents: [], children: [] });
        }).open();
        break;
      default:
        return;
    }
  }

  /** 拖入线路行元素：step / if / not / do */
  private addLineItemByDrop(type: string, line: FlowLine): void {
    const commit = (item: FlowLineItem): void => {
      line.items.push(item);
      this.commitAst();
    };
    switch (type) {
      case 'step':
        new FlowPromptModal(this.app, [{ label: '步骤名称', defaultValue: '' }], ([name]) => {
          if (!name) return;
          commit({ type: 'step', name, next: '', nextKind: 'seq' });
        }).open();
        break;
      case 'if':
      case 'not':
        new FlowPromptModal(this.app, [{ label: type === 'not' ? 'NOT 条件' : 'IF 条件', defaultValue: '' }], ([cond]) => {
          if (!cond) return;
          commit({ type: 'if', not: type === 'not', cond, do: undefined });
        }).open();
        break;
      case 'do':
        new FlowPromptModal(this.app, [{ label: 'DO 动作', defaultValue: '' }], ([act]) => {
          if (!act) return;
          commit({ type: 'if', not: false, cond: 'true', do: act });
        }).open();
        break;
      default:
        return;
    }
  }

  /** 拖入例程：新建线路行到指定数组（弹窗询问名称） */
  private addLineByDrop(getTarget: () => FlowLine[]): void {
    new FlowPromptModal(this.app, [{ label: '例程名称', defaultValue: '' }], ([name]) => {
      getTarget().push({ type: 'line', name: name || undefined, items: [] });
      this.commitAst();
    }).open();
  }

  /** 拖入内容块：lst / task → 归位到 do 输出 */
  private addContentByDrop(type: string, node: FlowTimeNode): void {
    if (type !== 'lst' && type !== 'task') return;
    new FlowPromptModal(this.app, [{ label: `${type.toUpperCase()} 内容文本`, defaultValue: '' }], ([text]) => {
      if (!text) return;
      this.addContentToNode(node, { kind: type, text: text.trim() } as FlowContentBlock);
      this.commitAst();
    }).open();
  }

  /** 将内容块归位到时间节点的 do 输出（无线路行/do 则自动创建） */
  private addContentToNode(node: FlowTimeNode, block: FlowContentBlock): void {
    if (node.lines.length === 0) {
      node.lines.push({ type: 'line', items: [] });
    }
    const line = node.lines[0];
    let doItem: FlowLineItem | null = null;
    for (let k = line.items.length - 1; k >= 0; k--) {
      const it = line.items[k];
      if (it.type === 'if' && it.do !== undefined) {
        doItem = it;
        break;
      }
    }
    if (!doItem) {
      const item: FlowLineItem = { type: 'if', not: false, cond: 'true', do: '', contents: [] };
      line.items.push(item);
      doItem = item;
    }
    if (doItem.type === 'if') {
      doItem.contents = [...(doItem.contents ?? []), block];
    }
  }

  /** 右键菜单删除（LAD 不显示删除按钮，保持视觉干净） */
  private attachDeleteMenu(el: HTMLElement, onDelete: () => void): void {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle('删除').setIcon('trash')
          .onClick(() => {
            onDelete();
            this.commitAst();
          }));
      menu.showAtMouseEvent(e);
    });
  }

  private renderLadStructure(parent: HTMLElement, ast: FlowScript): void {
    // 手动构建（复用 LadRenderer 的视觉，但挂载编辑控件）
    // 例程区（最上方常通线路区）始终渲染，无论是否设置例程
    const top = document.createElement('div');
    top.className = 'seqtk-lad-top';
    const axis = document.createElement('div');
    axis.className = 'seqtk-lad-axis';
    const title = document.createElement('div');
    title.className = 'seqtk-lad-section-title';
    title.textContent = '例程（始终激活）';
    top.appendChild(title);
    if (ast.lines.length > 0) {
      ast.lines.forEach((line, i) => this.renderLineEditable(top, line, i, () => { ast.lines.splice(i, 1); }));
    } else {
      // 空例程区：占位引导（点击新建线路行）
      const ph = document.createElement('div');
      ph.className = 'seqtk-lad-placeholder';
      ph.textContent = '点击添加例程，或从右侧拖入组件';
      ph.addEventListener('click', () => {
        new FlowPromptModal(this.app, [{ label: '例程名称', defaultValue: '' }], ([name]) => {
          ast.lines.push({ type: 'line', name: name || undefined, items: [] });
          this.commitAst();
        }).open();
      });
      top.appendChild(ph);
    }
    parent.appendChild(top);

    if (ast.timeNodes.length > 0) {
      const tTitle = document.createElement('div');
      tTitle.className = 'seqtk-lad-section-title';
      tTitle.textContent = '时间轴';
      axis.appendChild(tTitle);
      ast.timeNodes.forEach((node, i) => {
        this.renderInsertSlot(axis, (type) => this.addTimeNodeByDrop(type, ast.timeNodes, i));
        this.renderTimeNodeEditable(axis, node, i, ast.timeNodes);
      });
      // 末尾插槽（追加）
      this.renderInsertSlot(axis, (type) => this.addTimeNodeByDrop(type, ast.timeNodes, ast.timeNodes.length));
      parent.appendChild(axis);
    }
  }

  /** 线路行（可编辑）：步骤拖拽重排 + 增删步骤（删除走右键菜单） */
  private renderLineEditable(
    parent: HTMLElement,
    line: FlowLine,
    lineIdx: number,
    deleteFn: () => void,
  ): void {
    const row = document.createElement('div');
    row.className = 'seqtk-lad-line';
    const head = document.createElement('div');
    head.className = 'seqtk-lad-line-head';
    head.textContent = `例程：${line.name ?? '(未命名)'}`;
    if (line.on) {
      const span = document.createElement('span');
      span.className = 'seqtk-lad-on';
      span.textContent = ` on <${line.on}>`;
      head.appendChild(span);
    }
    row.appendChild(head);
    // 右键线路行删除
    this.attachDeleteMenu(row, deleteFn);

    const items = document.createElement('div');
    items.className = 'seqtk-lad-items';
    line.items.forEach((it, idx) => {
      const itemEl = this.renderLineItemEditable(it, idx, line, items);
      items.appendChild(itemEl);
    });
    row.appendChild(items);

    // 空线路行显示占位文字（点击添加；内部有块后不再显示引导）
    if (line.items.length === 0) {
      const ph = document.createElement('div');
      ph.className = 'seqtk-lad-placeholder';
      ph.textContent = '点击添加步骤/条件，或从右侧拖入组件';
      ph.addEventListener('click', (e) => this.showAddLineMenu(e, line));
      row.appendChild(ph);
    }
    // 整行作为拖放目标：step / if / not / do → 追加到该线路行
    this.attachDrop(row, (type) => this.addLineItemByDrop(type, line));
    parent.appendChild(row);
  }

  /** 线路行占位文字点击：添加菜单（步骤 / IF / NOT / DO） */
  private showAddLineMenu(e: MouseEvent, line: FlowLine): void {
    const menu = new Menu();
    const promptOne = (label: string, onVal: (v: string) => void): void => {
      new FlowPromptModal(this.app, [{ label, defaultValue: '' }], ([v]) => {
        if (!v) return;
        onVal(v);
        this.commitAst();
      }).open();
    };
    menu.addItem((item) => item.setTitle('步骤').setIcon('plus')
      .onClick(() => promptOne('步骤名称', (name) => {
        line.items.push({ type: 'step', name, next: '', nextKind: 'seq' });
      })));
    menu.addItem((item) => item.setTitle('IF 条件').setIcon('plus')
      .onClick(() => promptOne('IF 条件', (cond) => {
        line.items.push({ type: 'if', not: false, cond, do: undefined });
      })));
    menu.addItem((item) => item.setTitle('NOT 条件').setIcon('plus')
      .onClick(() => promptOne('NOT 条件', (cond) => {
        line.items.push({ type: 'if', not: true, cond, do: undefined });
      })));
    menu.addItem((item) => item.setTitle('DO 动作').setIcon('plus')
      .onClick(() => promptOne('DO 动作', (act) => {
        line.items.push({ type: 'if', not: false, cond: 'true', do: act });
      })));
    menu.showAtMouseEvent(e);
  }

  /** 线路行内元素（步骤可拖拽重排；IF/NOT/DO 只读展示） */
  private renderLineItemEditable(
    it: any,
    idx: number,
    line: FlowLine,
    items: HTMLElement,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'seqtk-lad-item';
    if (it.type === 'step') {
      const step = document.createElement('div');
      step.className = 'seqtk-lad-step';
      step.textContent = it.name;
      step.draggable = true;
      step.title = '拖动重排';
      step.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(idx));
      });
      step.addEventListener('dragover', (e) => e.preventDefault());
      step.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10);
        if (Number.isNaN(from) || from === idx) return;
        const moved = line.items.splice(from, 1)[0];
        line.items.splice(idx, 0, moved);
        this.commitAst();
      });
      // 右键步骤删除
      this.attachDeleteMenu(step, () => { line.items.splice(idx, 1); });
      wrap.appendChild(step);
    } else {
      const elem = document.createElement('div');
      const cls = it.not ? 'seqtk-lad-not' : it.cond === 'true' && it.do ? 'seqtk-lad-do' : 'seqtk-lad-if';
      elem.className = `seqtk-lad-elem ${cls}`;
      elem.textContent = it.not
        ? `NOT ${it.cond}`
        : it.cond === 'true' && it.do
          ? `DO ${it.do}`
          : `IF ${it.cond}`;
      wrap.appendChild(elem);
      if (it.do && !(it.cond === 'true')) {
        const doEl = document.createElement('div');
        doEl.className = 'seqtk-lad-elem seqtk-lad-do';
        doEl.textContent = `DO ${it.do}`;
        wrap.appendChild(doEl);
      }
      // 右键元件删除（含 do 输出内容）
      this.attachDeleteMenu(wrap, () => { line.items.splice(idx, 1); });
      // do 的输出内容块紧跟其后（右键删除）
      const itIf = it as { type: 'if'; not: boolean; cond: string; do?: string; contents?: FlowContentBlock[] };
      if (itIf.do !== undefined && itIf.contents) {
        itIf.contents.forEach((c, ci) => {
          const cRow = document.createElement('div');
          cRow.className = 'seqtk-lad-content';
          const kind = document.createElement('span');
          kind.className = 'seqtk-lad-content-kind';
          kind.textContent = c.kind;
          cRow.appendChild(kind);
          cRow.appendChild(document.createTextNode(` ${c.text}`));
          this.attachDeleteMenu(cRow, () => { itIf.contents?.splice(ci, 1); });
          wrap.appendChild(cRow);
        });
      }
    }
    void items;
    return wrap;
  }

  /** 时间节点（可编辑）：↑↓ 移动 + 增删内容块/嵌套 */
  private renderTimeNodeEditable(
    parent: HTMLElement,
    node: FlowTimeNode,
    idx: number,
    siblings: FlowTimeNode[],
  ): void {
    const block = document.createElement('div');
    block.className = `seqtk-lad-timenode seqtk-lad-tn-${node.type}`;
    const head = document.createElement('div');
    head.className = 'seqtk-lad-tn-head';
    const label = this.timeLabel(node);
    const icon = document.createElement('span');
    icon.className = 'seqtk-lad-tn-icon';
    icon.textContent = label.icon;
    head.appendChild(icon);
    const time = document.createElement('span');
    time.className = 'seqtk-lad-tn-time';
    time.textContent = label.text;
    head.appendChild(time);
    if (label.name) {
      const name = document.createElement('span');
      name.className = 'seqtk-lad-tn-name';
      name.textContent = label.name;
      head.appendChild(name);
    }
    // ↑↓ 移动
    const up = document.createElement('button');
    up.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
    up.textContent = '↑';
    up.title = '上移';
    up.disabled = idx === 0;
    up.addEventListener('click', () => {
      const [m] = siblings.splice(idx, 1);
      siblings.splice(idx - 1, 0, m);
      this.commitAst();
    });
    head.appendChild(up);
    const down = document.createElement('button');
    down.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
    down.textContent = '↓';
    down.title = '下移';
    down.disabled = idx === siblings.length - 1;
    down.addEventListener('click', () => {
      const [m] = siblings.splice(idx, 1);
      siblings.splice(idx + 1, 0, m);
      this.commitAst();
    });
    head.appendChild(down);
    block.appendChild(head);
    // 右键时间节点删除
    this.attachDeleteMenu(block, () => { siblings.splice(idx, 1); });

    const body = document.createElement('div');
    body.className = 'seqtk-lad-tn-body';
    node.lines.forEach((line, li) => this.renderLineEditable(body, line, li, () => { node.lines.splice(li, 1); }));
    // 内容块不再直接挂时间节点，随线路行 DO 显示（旧数据 node.contents 兼容渲染，右键删除）
    node.contents.forEach((c, ci) => {
      const cRow = document.createElement('div');
      cRow.className = 'seqtk-lad-content';
      const kind = document.createElement('span');
      kind.className = 'seqtk-lad-content-kind';
      kind.textContent = c.kind;
      cRow.appendChild(kind);
      cRow.appendChild(document.createTextNode(` ${c.text}`));
      this.attachDeleteMenu(cRow, () => { node.contents.splice(ci, 1); });
      body.appendChild(cRow);
    });
    node.children.forEach((child, ci) => {
      this.renderInsertSlot(body, (type) => this.addTimeNodeByDrop(type, node.children, ci));
      this.renderTimeNodeEditable(body, child, ci, node.children);
    });
    // 末尾插槽（追加）
    this.renderInsertSlot(body, (type) => this.addTimeNodeByDrop(type, node.children, node.children.length));

    const addContent = document.createElement('div');
    addContent.className = 'seqtk-lad-placeholder';
    addContent.textContent = '点击添加输出内容，或从右侧拖入组件';
    addContent.addEventListener('click', () => {
      new FlowPromptModal(this.app, [
        { label: '内容块类型（lst/task/...）', defaultValue: 'lst' },
        { label: '内容文本', defaultValue: '' },
      ], ([kind, text]) => {
        if (!kind || !text) return;
        this.addContentToNode(node, { kind: kind.trim().toLowerCase(), text: text.trim() } as FlowContentBlock);
        this.commitAst();
      }).open();
    });
    // 内部有块（线路行/内容/子节点）后不显示占位引导
    const hasBlocks = node.lines.length > 0 || node.contents.length > 0 || node.children.length > 0;
    if (!hasBlocks) body.appendChild(addContent);
    // 整块为拖放目标：line → 新建嵌套线路行；lst/task → 内容块（归位到 do 输出）；step/if/not/do → 归位到内部线路行（无则自动创建）
    body.appendChild(addContent);
    this.attachDrop(block, (type) => {
      if (type === 'line') {
        this.addLineByDrop(() => node.lines);
      } else if (type === 'lst' || type === 'task') {
        this.addContentByDrop(type, node);
      } else if (type === 'step' || type === 'if' || type === 'not' || type === 'do') {
        if (node.lines.length === 0) {
          node.lines.push({ type: 'line', items: [] });
        }
        this.addLineItemByDrop(type, node.lines[0]);
      }
    });
    block.appendChild(body);
    parent.appendChild(block);
  }

  private timeLabel(node: FlowTimeNode): { icon: string; text: string; name?: string } {
    switch (node.type) {
      case 'at':
        return { icon: '●', text: node.time ?? '' };
      case 'span':
        return { icon: '●', text: `${node.from ?? ''} → ${node.to ?? ''}`, name: node.name };
      case 'repeat':
        return { icon: '◇', text: `每${node.every ?? ''} ${node.time ?? ''}`, name: node.name };
      case 'when':
        return { icon: '◈', text: `当 [${node.when ?? ''}]` };
    }
  }

  /** LAD 修改 → 序列化写回脚本文本并重渲染 */
  private commitAst(): void {
    if (!this.currentAst) return;
    this.currentText = serializeFlowScript(this.currentAst);
    this.renderLadMode();
  }

  // ============================================================
  // 保存
  // ============================================================

  private save(): void {
    if (!this.currentScriptId) return;
    const node = this.nodeCache.getNode(this.currentScriptId);
    if (!node) return;
    // 脚本态下取 textarea 值；LAD 态下取 currentText（commitAst 已同步）
    if (this.mode === 'script' && this.textArea) {
      this.currentText = this.textArea.value;
    }
    this.operationQueue.enqueue(
      () => this.nodeCache.setNodeBody(this.currentScriptId!, this.currentText),
      async () => {
        await this.fileManager.updateNodeBody(node.kind, this.currentScriptId!, this.currentText);
      },
    );
    new Notice('流程脚本已保存');
  }
}
