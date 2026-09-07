/**
 * dual/DualPaneView — 双栏视图基座（可复用模式）
 *
 * 目的：把「双栏视图」固化为固定骨架，后续视图只实现差异、布局与生命周期保持一致。
 * 本基座只负责：
 * - .seqtk-split 双栏容器创建与 leftEl / rightEl 暴露
 * - onOpen / onClose 生命周期（含子类清理钩子）
 * - 统一的整体刷新入口 refresh()
 *
 * 内容自由度：
 * - 左栏：可复用 dual/leftTree 的树渲染内核（固定“树”形态，行内容由视图定制）
 * - 右栏：完全自由 —— 节点列表、CanvasBoard 白板、泳道、线路图等皆可，
 *   只需要实现 renderRight()
 *
 * 用法：
 *   class XxxView extends DualPaneView {
 *     protected cssClass = 'seqtk-xxx-view';
 *     protected onPanesReady(): void { ... }   // 挂事件监听 / nodeStore 订阅
 *     protected renderLeft(): void { ... }     // 树形态建议走 renderLeftTree
 *     protected renderRight(): void { ... }    // 完全自由
 *   }
 *
 * 渐进迁移清单（后续双栏视图逐个收敛到本基座，本次未迁移）：
 *   TemplateView / FocusView / AppendView / RouteView / FlowView / FlowDraftView
 *   证据等视图右栏需渲染 CanvasBoard 白板时,在 renderRight 内直接 new CanvasBoard 即可(防回归,先不迁移)。
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';

export abstract class DualPaneView extends ItemView {
  /** 挂到视图容器的附加 CSS 类；留空则不 addClass */
  protected cssClass = '';

  /** 左栏 DOM（.seqtk-split-left） */
  protected leftEl!: HTMLElement;
  /** 右栏 DOM（.seqtk-split-right） */
  protected rightEl!: HTMLElement;

  /** onClose 时依次执行的清理钩子（取消订阅 / 移除全局监听） */
  private closeHandlers: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    if (this.cssClass) container.addClass(this.cssClass);

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');
    this.rightEl = split.createDiv('seqtk-split-right');

    this.onPanesReady();
    this.renderLeft();
    this.renderRight();
  }

  /**
   * 两栏 DOM 就绪后调用一次：在此挂事件监听 / 数据订阅 / registerOnClose 清理钩子。
   * 不要再覆写 onOpen。
   */
  protected onPanesReady(): void {}

  /** 左栏渲染（子类实现；树形态可复用 dual/leftTree.renderLeftTree） */
  protected abstract renderLeft(): void;

  /** 右栏渲染（子类实现；完全自由，可渲染白板等任意内容） */
  protected abstract renderRight(): void;

  /** 注册 onClose 清理钩子（取消订阅 / 移除 document 级监听等） */
  protected registerOnClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async onClose(): Promise<void> {
    for (const h of this.closeHandlers) h();
    this.closeHandlers = [];
  }

  /** 整体刷新（设置变更 / 数据订阅触发时调用） */
  refresh(): void {
    this.renderLeft();
    this.renderRight();
  }
}
