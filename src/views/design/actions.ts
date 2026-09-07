/**
 * design/actions — 设计视图数据动作切片
 *
 * 从 DesignView 拆出的「节点数据写操作」:创建 / 修改属性 / 状态切换 /
 * 归档 / 级联删除 / 保存名称与正文 / 跳转打开节点文件。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读/写 view 上公开的
 *   状态与能力(renderLeft/renderRight、expandedLeft/Right、nodeCache、
 *   fileManager、operationQueue),不新增任何 UI 状态
 * - 所有写盘统一走 view.operationQueue(cacheOp 立即更新缓存 / fileOp 延迟写盘)
 *
 * 功能增补指引:
 * - 新增节点级数据操作(改字段、批量处理)→ 在此新增 export function 并在
 *   菜单切片(menus.ts)/行内切片(inline.ts)中接线
 */

import { Notice, TFile, MarkdownView, getFrontMatterInfo } from 'obsidian';
import type { DesignView } from '../DesignView';
import {
  TransactionCreateModal,
  TransactionEditModal,
  kindUsesState,
} from '../components/TransactionModals';
import type { TreeNode } from './tree';
import type { EventNature, NodeKind, SeqtkState, SeqtkNode } from '../../types/index';
import {
  getAllowedChildKinds,
  isTransactionKind,
  isFrameworkKind,
} from '../../types/index';

/** 创建节点输入(模态框 / 行内新建共用) */
export interface CreateInput {
  kind: NodeKind;
  desc: string;
  state: SeqtkState;
  nature?: EventNature;
  expectedTime?: string;
  expectedRepeat?: string;
  expectedSpan?: { from?: string; to?: string };
  afterCreate: 'direct' | 'edit-body';
}

/** 修改属性输入(TransactionEditModal 提交) */
export interface EditInput {
  desc: string;
  state: SeqtkState;
  nature?: EventNature;
  expectedTime?: string;
  expectedRepeat?: string;
  expectedSpan?: { from?: string; to?: string };
}

/**
 * 打开创建模态框
 *
 * @param view      设计视图
 * @param fixedKind 固定类型（工具栏）
 * @param parentId  父节点 ID（创建下属时）
 * @param parentKind 父节点类型（决定可创建的子类型）
 */
export function openCreate(view: DesignView, fixedKind?: NodeKind, parentId?: string, parentKind?: NodeKind): void {
  if (!view.nodeCache.isInitialized) {
    new Notice('查询缓存尚未就绪，请稍候');
    return;
  }
  let kinds: NodeKind[];
  if (fixedKind) {
    kinds = [fixedKind];
  } else if (parentId && parentKind) {
    kinds = getAllowedChildKinds(parentKind);
  } else {
    // 无父节点：构想 / 清单 / 框架
    kinds = ['concept', 'checklist', 'framework-transaction', 'framework-info'];
  }
  if (kinds.length === 0) return;

  new TransactionCreateModal(view.app, {
    kinds,
    onSubmit: (input) => createNode(view, input, parentId),
  }).open();
}

/** 创建节点：写盘 → 维护双向关系 → 更新缓存 →（按选项）跳转文件编辑正文；返回新节点 id（失败返回 undefined） */
export async function createNode(
  view: DesignView,
  input: CreateInput,
  parentId?: string,
  opts?: { skipRender?: boolean; side?: 'left' | 'right' },
): Promise<string | undefined> {
  const now = new Date().toISOString();
  const data = {
    kind: input.kind,
    desc: input.desc,
    open: true,
    ...(kindUsesState(input.kind) ? { state: input.state } : {}),
    create: now,
    modify: now,
    ...(input.kind === 'event' && input.nature ? { nature: input.nature } : {}),
    // 状态（快照）节点：自动附加时间点 at（创建时刻）
    ...(input.kind === 'snapshot' ? { at: now } : {}),
    // 预期属性（事务→预期时间+预期重复；框架→预期时间段）
    ...(isTransactionKind(input.kind) ? {
      ...(input.expectedTime ? { expectedTime: input.expectedTime } : {}),
      ...(input.expectedRepeat ? { expectedRepeat: input.expectedRepeat } : {}),
    } : {}),
    ...(isFrameworkKind(input.kind) && input.expectedSpan ? { expectedSpan: input.expectedSpan } : {}),
    ...(parentId ? { parent: parentId } : {}),
  } as SeqtkNode;

  let nodeId: string;
  try {
    nodeId = await view.fileManager.createNode(input.kind, data, '');
  } catch (err) {
    console.error('[SeqTK] 创建节点失败:', err);
    new Notice(`[SeqTK] 创建节点失败: ${err}`);
    return;
  }

  // 子节点：在父节点 follows 中追加引用（双向维护）
  if (parentId) {
    const parent = view.nodeCache.getNode(parentId);
    if (parent) {
      const follows = [...(parent.follows ?? []), nodeId];
      view.operationQueue.enqueue(
        () => view.nodeCache.updateNode(parentId, { follows }),
        async () => { await view.fileManager.updateNode(parent.kind, parentId, { follows }); },
      );
    }
  }

  view.operationQueue.enqueueCacheOp(() => view.nodeCache.addNode(nodeId, data, ''));

  // 新建子项后默认展开父节点，供查看新节点（行内新建由调用方局部插入，跳过全量渲染）
  if (parentId) {
    // 展开状态按栏维护：side 指定时仅展开对应栏，缺省（模态框创建）两栏都展开
    if (opts?.side === 'left') view.expandedLeft.add(parentId);
    else if (opts?.side === 'right') view.expandedRight.add(parentId);
    else { view.expandedLeft.add(parentId); view.expandedRight.add(parentId); }
    if (!opts?.skipRender) {
      view.renderLeft();
      view.renderRight();
    }
  }

  if (input.afterCreate === 'edit-body') {
    await openNodeFile(view, nodeId);
  }
  return nodeId;
}

/** 打开「修改属性」模态框 */
export function openEdit(view: DesignView, nodeId: string): void {
  if (!view.nodeCache.isInitialized) return;
  const node = view.nodeCache.getNode(nodeId);
  if (!node) return;

  new TransactionEditModal(view.app, {
    node,
    onSubmit: (input) => editNode(view, nodeId, node, input),
    onOpenFile: () => void openNodeFile(view, nodeId),
  }).open();
}

/** 修改属性：diff 出变更字段并写队列（无变化则跳过） */
export function editNode(
  view: DesignView,
  nodeId: string,
  node: SeqtkNode,
  input: EditInput,
): void {
  const updates: Partial<SeqtkNode> = {};
  if (input.desc !== node.desc) updates.desc = input.desc;
  if (kindUsesState(node.kind) && input.state !== node.state) updates.state = input.state;
  if (node.kind === 'event' && input.nature && input.nature !== (node as any).nature) {
    updates.nature = input.nature;
  }
  if (isTransactionKind(node.kind)) {
    if ((input.expectedTime ?? '') !== ((node as any).expectedTime ?? '')) {
      updates.expectedTime = input.expectedTime || undefined;
    }
    if ((input.expectedRepeat ?? '') !== ((node as any).expectedRepeat ?? '')) {
      updates.expectedRepeat = input.expectedRepeat || undefined;
    }
  }
  if (isFrameworkKind(node.kind)) {
    const span = (node as any).expectedSpan;
    const from = input.expectedSpan?.from ?? '';
    const to = input.expectedSpan?.to ?? '';
    if (from !== (span?.from ?? '') || to !== (span?.to ?? '')) {
      updates.expectedSpan = (from || to)
        ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
        : undefined;
    }
  }

  if (Object.keys(updates).length === 0) return;

  view.operationQueue.enqueue(
    () => view.nodeCache.updateNode(nodeId, { ...updates, modify: new Date().toISOString() }),
    async () => { await view.fileManager.updateNode(node.kind, nodeId, updates); },
  );
}

/** 切换节点状态（无变化直接跳过） */
export function setNodeState(view: DesignView, nodeId: string, state: SeqtkState): void {
  const node = view.nodeCache.getNode(nodeId);
  if (!node || node.state === state) return;
  view.operationQueue.enqueue(
    () => view.nodeCache.updateNode(nodeId, { state, modify: new Date().toISOString() }),
    async () => { await view.fileManager.updateNode(node.kind, nodeId, { state }); },
  );
}

/** 保存节点名（desc）变更 */
export function saveNodeDesc(view: DesignView, node: TreeNode, newDesc: string): void {
  view.operationQueue.enqueue(
    () => view.nodeCache.updateNode(node.nodeId, { desc: newDesc, modify: new Date().toISOString() }),
    async () => { await view.fileManager.updateNode(node.data.kind, node.nodeId, { desc: newDesc }); },
  );
}

/** 保存节点正文（body）变更 */
export function saveNodeBody(view: DesignView, node: TreeNode, body: string): void {
  view.operationQueue.enqueue(
    () => view.nodeCache.setNodeBody(node.nodeId, body),
    async () => { await view.fileManager.updateNodeBody(node.data.kind, node.nodeId, body); },
  );
}

/** 归档节点：置 open:false（从快速缓存移除，保留于全量缓存供回收/决策视图） */
export function archiveNode(view: DesignView, nodeId: string): void {
  const node = view.nodeCache.getNodeFull(nodeId);
  if (!node) return;
  if (node.open === false) return;
  view.operationQueue.enqueue(
    () => view.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
    async () => { await view.fileManager.updateNode(node.kind, nodeId, { open: false }); },
  );
  new Notice('已归档（可在回收模式中还原）');
}

/** 级联删除：先捕获子树结构，再同步清缓存、异步删文件 */
export function deleteNodeTree(view: DesignView, node: TreeNode): void {
  const collect = (n: TreeNode): { kind: NodeKind; nodeId: string }[] => [
    ...n.children.flatMap(collect),
    { kind: n.data.kind, nodeId: n.nodeId },
  ];
  const targets = collect(node);

  view.operationQueue.enqueueCacheBatch(
    targets.map((t) => () => view.nodeCache.removeNode(t.nodeId)),
  );
  view.operationQueue.enqueueFileBatch(
    targets.map((t) => async () => { await view.fileManager.deleteNode(t.kind, t.nodeId); }),
  );

  new Notice(`已删除 ${targets.length} 个节点`);
}

/** 在 Obsidian 编辑器中打开节点文件（source 模式），定位光标到正文起始 */
export async function openNodeFile(view: DesignView, nodeId: string): Promise<void> {
  const node = view.nodeCache.getNode(nodeId);
  if (!node) return;
  const filePath = view.fileManager.getNodeFilePath(node.kind, nodeId);
  const file = view.app.vault.getFileByPath(filePath);
  if (!(file instanceof TFile)) return;

  const leaf = view.app.workspace.getLeaf('tab');
  if (!leaf) return;
  await leaf.openFile(file, { state: { mode: 'source' } });

  try {
    const view2 = view.app.workspace.getActiveViewOfType(MarkdownView);
    if (view2 && view2.file?.path === filePath) {
      const info = getFrontMatterInfo(view2.data);
      view2.editor.setCursor(view2.editor.offsetToPos(info.contentStart ?? 0));
    }
  } catch (err) {
    console.warn('[SeqTK] 定位正文光标失败:', err);
  }
}
