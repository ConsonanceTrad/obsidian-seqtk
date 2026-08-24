/**
 * FlowPushView — 流程推送（右侧边栏阅览，不在主编辑区显现）
 *
 * 选择流程脚本 → 展示由其在时间轴上实例化的推送任务序列（按时间排序）。
 * 仅手动刷新/选择性调用（window.SeqTK.pushFlow），不做自动到点提醒。
 */

import { DropdownComponent, ItemView, Setting, WorkspaceLeaf } from 'obsidian';
import type { NodeCache } from '../core/NodeCache';
import { parseFlowScript } from '../core/flow/parser';
import { generatePushTasks } from '../core/flow/push';
import type { FlowPushTask } from '../core/flow/push';

export const VIEW_TYPE_FLOW_PUSH = 'seqtk-flow-push';

export class FlowPushView extends ItemView {
  private listEl!: HTMLElement;
  private selectEl: DropdownComponent | null = null;
  private currentScriptId = '';

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FLOW_PUSH;
  }

  getDisplayText(): string {
    return '流程推送';
  }

  getIcon(): string {
    return 'bell';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.createEl('div', { cls: 'seqtk-push-title', text: '流程推送' });

    // 脚本选择 + 刷新
    const set = new Setting(container);
    set.addDropdown((dd) => {
      this.selectEl = dd;
      const scripts = this.nodeCache.getByKind('script-flow');
      dd.addOption('', '（选择流程脚本）');
      for (const { nodeId, data } of scripts) {
        dd.addOption(nodeId, data.desc);
      }
      dd.onChange((v) => {
        this.currentScriptId = v;
        this.renderTasks();
      });
      return dd;
    }).addButton((b) => {
      b.setButtonText('刷新').onClick(() => {
        this.reloadSelect();
        this.renderTasks();
      });
      return b;
    });

    this.listEl = container.createDiv('seqtk-push-list');
    this.renderTasks();
  }

  async onClose(): Promise<void> {
    // 无订阅，无需清理
  }

  private reloadSelect(): void {
    const dd = this.selectEl;
    if (!dd) return;
    dd.selectEl.empty();
    dd.addOption('', '（选择流程脚本）');
    for (const { nodeId, data } of this.nodeCache.getByKind('script-flow')) {
      dd.addOption(nodeId, data.desc);
    }
    dd.setValue(this.currentScriptId);
  }

  private renderTasks(): void {
    this.listEl.empty();
    if (!this.currentScriptId) {
      this.listEl.createEl('div', { cls: 'seqtk-empty', text: '请选择流程脚本' });
      return;
    }
    const node = this.nodeCache.getNode(this.currentScriptId);
    if (!node) {
      this.listEl.createEl('div', { cls: 'seqtk-empty', text: '脚本不存在' });
      return;
    }
    const body = this.nodeCache.getNodeBody(this.currentScriptId);
    const ast = parseFlowScript(body);
    if (ast.errors.length > 0) {
      for (const err of ast.errors) {
        this.listEl.createEl('div', {
          cls: 'seqtk-push-err',
          text: `第 ${err.line} 行：${err.message}`,
        });
      }
      return;
    }
    const tasks = generatePushTasks(ast);
    if (tasks.length === 0) {
      this.listEl.createEl('div', { cls: 'seqtk-empty', text: '该脚本没有可推送的任务' });
      return;
    }
    for (const task of tasks) {
      this.renderTask(task);
    }
  }

  private renderTask(task: FlowPushTask): void {
    const row = this.listEl.createDiv('seqtk-push-task');
    const head = row.createDiv('seqtk-push-task-head');
    head.createEl('span', {
      cls: `seqtk-push-time seqtk-push-time-${task.nodeType}`,
      text: task.time,
    });
    if (task.label) head.createEl('span', { cls: 'seqtk-push-label', text: task.label });
    for (const item of task.items) {
      const line = row.createDiv('seqtk-push-item');
      line.createEl('span', { cls: 'seqtk-lad-content-kind', text: item.kind });
      line.createSpan({ text: ` ${item.text}` });
    }
  }
}
