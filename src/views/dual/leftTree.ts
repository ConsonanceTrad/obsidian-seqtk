/**
 * dual/leftTree — 通用左栏树渲染内核（左栏固定形态的“树”）
 *
 * 把「树怎么画」固定下来，把「每一行放什么」交给视图：
 * - 形态：自上而下顺序排列，递归渲染子树；展开行之后紧跟其子树行；折叠行不渲染子树
 * - 行：完全由调用方 makeRow 构建（徽章 / 预览 / 状态 / 按钮 / 拖拽 / 右键菜单皆可自定），
 *   左树不预设行内容 —— 数据来源与节点表示由调用方负责（如 DesignView 用
 *   buildFrameworkTree，TemplateView 用模板框架树，来源不同但树形态一致）
 * - 空态 / 占位提示由调用方在调用前自行处理
 *
 * 用法：
 *   renderLeftTree(this.leftEl, roots, {
 *     isExpanded: (id) => this.expandedLeft.has(id),
 *     makeRow: (ctx) => {
 *       const row = createTreeRow(this.leftEl, ctx);
 *       row.style.paddingLeft = `${8 + ctx.depth * 14}px`;
 *       if (ctx.hasChildren) row.createSpan('seqtk-collapse-mark');
 *       /* …行内容、事件、拖拽等由视图补充… *​/
 *       return row;
 *     },
 *   });
 */

import type { TreeNode } from '../design/tree';

/** 树行渲染上下文（一行 = 一个节点在树中的一次出现） */
export interface TreeRowContext {
  node: TreeNode;
  /** 缩进层级（顶级为 0） */
  depth: number;
  /** 是否处于某展开祖先链内（非顶级行恒为 true） */
  inExpandedTree: boolean;
  /** 父节点 nodeId；顶级行为空串 */
  parentNodeId: string;
  /** 是否有子节点（决定折叠标识是否出现 / 能否展开） */
  hasChildren: boolean;
  /** 当前是否展开（决定子树是否渲染） */
  isExpanded: boolean;
  /** 是否是其父节点 children 中的最后一项（引导线父列在转角收尾，└） */
  isLast?: boolean;
  /** 是否是其父节点 children 中的第一项（父列竖线额外上探到父行横线连接，TS 注入 --guide-rise） */
  isFirst?: boolean;
}

export interface LeftTreeOptions {
  /** 判定某节点当前是否展开 */
  isExpanded: (nodeId: string) => boolean;
  /**
   * 构建一行：创建行元素并追加到 ctx 所在容器（容器可用 ctx.node 之外另行获取，
   * 约定为渲染入口传入的 container）。返回 null 表示该节点不渲染在左树。
   */
  makeRow: (ctx: TreeRowContext) => HTMLElement | null;
}

/** 顺序递归渲染左树（固定树形态：行 + 按展开状态递归子树） */
export function renderLeftTree(container: HTMLElement, roots: TreeNode[], opts: LeftTreeOptions): void {
  for (const root of roots) visit(root, 0, false, '', false, false);

  function visit(node: TreeNode, depth: number, inExpandedTree: boolean, parentNodeId: string, isLast: boolean, isFirst: boolean): void {
    const hasChildren = node.children.length > 0;
    const isExpanded = opts.isExpanded(node.nodeId);
    const ctx: TreeRowContext = { node, depth, inExpandedTree, parentNodeId, hasChildren, isExpanded, isLast, isFirst };
    const row = opts.makeRow(ctx);
    if (row) container.appendChild(row);
    if (hasChildren && isExpanded) {
      node.children.forEach((child, i) => {
        visit(child, depth + 1, true, node.nodeId, i === node.children.length - 1, i === 0);
      });
    }
  }
}

/** 创建一行基础元素（仅建元素 + dataset.nodeId / parentId；样式 / 内容 / 事件由调用方续写） */
export function createTreeRow(container: HTMLElement, ctx: TreeRowContext, rowClass = 'seqtk-frame-item'): HTMLElement {
  const row = container.createDiv(rowClass);
  row.dataset.nodeId = ctx.node.nodeId;
  row.dataset.parentId = ctx.parentNodeId ?? '';
  return row;
}
