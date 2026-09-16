/**
 * design/actions — 设计视图数据动作切片
 *
 * 从 DesignView 拆出的「节点数据写操作」:创建 / 时间规则 / 状态切换 /
 * 归档 / 级联删除 / 保存名称与正文 / 跳转打开节点文件。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读/写 view 上公开的
 *   状态与能力(renderLeft/renderRight、expandedLeft/Right、**pipe**),不新增任何 UI 状态
 * - 所有写盘统一走 **view.pipe**（EXEC_Mutation 缓存立即 + 文件慢序列 / EXEC_Create 新建 /
 *   EXEC_RemoveMany 批量删除），本文件不再直连 nodeCache / fileManager / operationQueue
 *
 * 功能增补指引:
 * - 新增节点级数据操作(改字段、批量处理)→ 在此新增 export function 并在
 *   菜单声明（Design.ts 的 getXxxMenuDefinitions）中接线
 */

import { NODE_KIND } from '../../../P4_Nodes/NodeFacade';
import { GET_FileByPath } from '../../../P5_Data/MdFile/PathTools/PathParse';
import { Notice, TFile, MarkdownView, getFrontMatterInfo } from 'obsidian';
import type { DesignView } from '../Design';
import {
  TransactionCreateModal,
  TransactionEditModal,
  kindUsesState,
} from '../../../P7_Render/Structure/S2_Modal/TransactionModals';
import type { TreeNode } from './tree';
import type { EventNature, NodeKind, SeqtkState, SeqtkNode } from '../../../P4_Nodes/NodeFacade';
import { COMPUTE_Propagation } from '../../../P4_Nodes/NodeField/Propagation';
import { NEEDS_Confirm, STRICT_CONFIRM_WORD } from '../../../P4_Nodes/NodeField/DeletionPolicy';
import { DestructiveConfirmModal } from '../../../P7_Render/Structure/S2_Modal/DestructiveModals';
import {
  getAllowedChildKinds,
  isTransactionKind,
  isFrameworkKind,
} from '../../../P4_Nodes/NodeFacade';

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

/** 「时间规则」输入（TransactionEditModal 提交）—— 只含时间与事件性质：名称走行内重命名，状态走状态圆点 */
export interface EditInput {
  /** 事件性质（仅 EVENT 节点提供） */
  nature?: EventNature;
  expectedTime?: string;
  expectedRepeat?: string;
  expectedSpan?: { from?: string; to?: string };
}

/**
 * 这些动作需要的最小宿主能力
 *
 * 原先签名直接要 `DesignView`，于是「被委托的框架树」这类宿主拿不到同一套行为
 * （它没有视图实例，却同样要新建 / 重命名 / 归档）。改成最小接口后视图与控制器都能满足，
 * 行为仍只有一份 —— 多一个入口不会长出第二套实现。
 * 成员类型用 `DesignView[...]` 索引取，避免为此新增 import。
 */
export interface NodeEditHost {
  pipe: DesignView['pipe'];
  app: DesignView['app'];
  settings: DesignView['settings'];
  /** 左右栏展开集合（新建子项后要展开父节点） */
  expandedLeft: Set<string>;
  expandedRight: Set<string>;
  renderLeft(): void;
  renderRight(): void;
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
  if (!view.pipe.isInitialized) {
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
    kinds = [NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.TRANS, NODE_KIND.INFO];
  }
  if (kinds.length === 0) return;

  new TransactionCreateModal(view.app, {
    kinds,
    onSubmit: (input) => createNode(view, input, parentId),
  }).open();
}

/** 创建节点：写盘 → 维护双向关系 → 更新缓存 →（按选项）跳转文件编辑正文；返回新节点 id（失败返回 undefined） */
export async function createNode(
  view: NodeEditHost,
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
    ...(input.kind === NODE_KIND.EVENT && input.nature ? { nature: input.nature } : {}),
    // 状态（快照）节点：自动附加时间点 at（创建时刻）
    ...(input.kind === NODE_KIND.SNAPSHOT ? { at: now } : {}),
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
    // 文件先行 + 父 follows 双向维护 + 缓存写入，全部由 pipe 承担
    nodeId = await view.pipe.EXEC_Create({
      kind: input.kind,
      data,
      parentId: parentId || undefined,
    });
  } catch (err) {
    console.error('[SeqTK] 创建节点失败:', err);
    new Notice(`[SeqTK] 创建节点失败: ${err}`);
    return;
  }

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

/** 打开「时间规则」模态框 */
export function openEdit(view: DesignView, nodeId: string): void {
  if (!view.pipe.isInitialized) return;
  const node = view.pipe.GET_Node(nodeId);
  if (!node) return;

  new TransactionEditModal(view.app, {
    node,
    onSubmit: (input) => editNode(view, nodeId, node, input),
    onOpenFile: () => void openNodeFile(view, nodeId),
  }).open();
}

/** 时间规则：diff 出变更字段并写队列（无变化则跳过）。名称与状态不在这里改 —— 各有入口 */
export function editNode(
  view: DesignView,
  nodeId: string,
  node: SeqtkNode,
  input: EditInput,
): void {
  const updates: Partial<SeqtkNode> & { nature?: EventNature } = {};
  if (node.kind === NODE_KIND.EVENT && input.nature && input.nature !== (node as any).nature) {
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

  view.pipe.EXEC_Mutation({
    op: 'update',
    kind: node.kind,
    nodeId,
    updates: { ...updates, modify: new Date().toISOString() },
  });
}

/** 切换节点状态（无变化直接跳过）；随后按 stateRules 做父子状态传播 */
export function setNodeState(view: DesignView, nodeId: string, state: SeqtkState): void {
  const node = view.pipe.GET_Node(nodeId);
  if (!node || node.state === state) return;
  view.pipe.EXEC_Mutation({
    op: 'update',
    kind: node.kind,
    nodeId,
    updates: { state, modify: new Date().toISOString() },
  });
  applyStatePropagation(view, nodeId, state);
}

/**
 * 按设置里的 stateRules 把本次状态变更传播到父子节点
 *
 * 上下文（祖先链 / 后代 / 直接子）全部经 pipe 取好，判定交给纯函数 COMPUTE_Propagation；
 * 传播产生的写入与手动变更走同一条写意图，故缓存与源文件行为一致。
 * 规则为空（或全未启用）时直接返回，不产生任何额外查询。
 */
function applyStatePropagation(view: DesignView, nodeId: string, state: SeqtkState): void {
  const rules = view.settings.stateRules ?? [];
  if (rules.length === 0) return;

  // 祖先链（由近及远）；上限防御异常数据造成的环
  const ancestors: { nodeId: string; state: SeqtkState }[] = [];
  let cur = view.pipe.GET_Parent(nodeId);
  while (cur && ancestors.length < 64) {
    ancestors.push({ nodeId: cur.nodeId, state: cur.data.state ?? 'plan' });
    cur = view.pipe.GET_Parent(cur.nodeId);
  }

  const descendants = view.pipe.COLLECT_Descendants(nodeId).map((d) => ({
    nodeId: d.nodeId,
    state: d.data.state ?? 'plan',
  }));

  const changes = COMPUTE_Propagation(rules, {
    nodeId,
    state,
    ancestors,
    descendants,
    childrenOf: (id) =>
      view.pipe.GET_Children(id).flatMap((c) =>
        c.data ? [{ nodeId: c.nodeId, state: c.data.state ?? 'plan' }] : [],
      ),
  });

  for (const ch of changes) {
    const target = view.pipe.GET_Node(ch.nodeId);
    if (!target) continue;
    view.pipe.EXEC_Mutation({
      op: 'update',
      kind: target.kind,
      nodeId: ch.nodeId,
      updates: { state: ch.state, modify: new Date().toISOString() },
    });
  }
}

/** 保存节点名（desc）变更 */
export function saveNodeDesc(view: NodeEditHost, node: TreeNode, newDesc: string): void {
  view.pipe.EXEC_Mutation({
    op: 'update',
    kind: node.data.kind,
    nodeId: node.nodeId,
    updates: { desc: newDesc, modify: new Date().toISOString() },
  });
}

/** 保存节点正文（body）变更 */
export function saveNodeBody(view: DesignView, node: TreeNode, body: string): void {
  view.pipe.EXEC_Mutation({
    op: 'setBody',
    kind: node.data.kind,
    nodeId: node.nodeId,
    body,
  });
}

/**
 * 归档节点：置 open:false（从快速缓存移除，保留于全量缓存供回收/决策视图）
 *
 * 后代是否一并归档由设置 archiveChildren 决定；是否弹确认由 archiveConfirm 决定
 * （none 直接执行 / children 仅当含子节点时 / simple 确认 / strict 需输入确认词）。
 */
export function archiveNode(view: NodeEditHost, nodeId: string): void {
  const node = view.pipe.GET_Node(nodeId);
  if (!node) return;
  if (node.open === false) return;

  const s = view.settings;
  const alsoArchive = s.archiveChildren === 'archive';
  const descendants = alsoArchive
    ? view.pipe.COLLECT_Descendants(nodeId).filter((d) => d.data.open !== false)
    : [];

  const run = (): void => {
    const now = new Date().toISOString();
    view.pipe.EXEC_Mutation({
      op: 'update',
      kind: node.kind,
      nodeId,
      updates: { open: false, modify: now },
    });
    for (const d of descendants) {
      view.pipe.EXEC_Mutation({
        op: 'update',
        kind: d.kind,
        nodeId: d.nodeId,
        updates: { open: false, modify: now },
      });
    }
    new Notice(descendants.length > 0
      ? `已归档（含 ${descendants.length} 个后代，可在回收模式中还原）`
      : '已归档（可在回收模式中还原）');
  };

  // 「仅当含子节点时提示」那一档要的判据：有无子节点由数据层给，策略模块据此决定拦不拦
  const hasChildren = view.pipe.GET_Children(nodeId).some((c) => !!c.data);
  if (!NEEDS_Confirm(s.archiveConfirm, hasChildren)) {
    run();
    return;
  }
  new DestructiveConfirmModal(view.app, {
    title: '归档节点',
    message: alsoArchive && descendants.length > 0
      ? `「${node.desc}」及其 ${descendants.length} 个后代将一并归档（可在回收模式中还原）。`
      : `将归档「${node.desc}」（可在回收模式中还原）。`,
    requiredWord: s.archiveConfirm === 'strict' ? STRICT_CONFIRM_WORD : undefined,
    confirmText: '归档',
    onConfirm: run,
  }).open();
}

/**
 * 删除节点：后代如何处理由设置 deleteChildren 决定
 * （keep 只删自身、后代脱离父级；archive 后代改归档；delete 级联删除）。
 * 是否弹确认由 deleteConfirm 决定（none / children 仅当含子节点时 / simple / strict）。
 */
export function deleteNodeTree(view: DesignView, node: TreeNode): void {
  const s = view.settings;
  const mode = s.deleteChildren;
  const rootTarget = { kind: node.data.kind, nodeId: node.nodeId };
  const now = new Date().toISOString();

  /** 待处理的后代（未归档的）与直接子（keep 模式需要断开父子关系） */
  const descendants = view.pipe
    .COLLECT_Descendants(node.nodeId)
    .filter((d) => d.data.open !== false);
  const directChildren = view.pipe
    .GET_Children(node.nodeId)
    .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data);

  const run = (): void => {
    if (mode === 'archive') {
      // 自身删除、后代改为归档（内容保留，可回收）
      view.pipe.EXEC_Mutation({
        op: 'update',
        kind: node.data.kind,
        nodeId: node.nodeId,
        updates: { open: false, modify: now },
      });
      for (const d of descendants) {
        view.pipe.EXEC_Mutation({
          op: 'update',
          kind: d.kind,
          nodeId: d.nodeId,
          updates: { open: false, modify: now },
        });
      }
      new Notice(`已归档（含 ${descendants.length} 个后代）`);
      return;
    }

    if (mode === 'keep') {
      // 只删自身；直接子脱离父级，成为无父节点（否则 parent 会指向已删节点）
      view.pipe.EXEC_RemoveMany([rootTarget]);
      for (const c of directChildren) {
        view.pipe.EXEC_Mutation({
          op: 'update',
          kind: c.data.kind,
          nodeId: c.nodeId,
          updates: { parent: '', modify: now },
        });
      }
      new Notice(`已删除 1 个节点（${directChildren.length} 个直属子节点已脱离父级）`);
      return;
    }

    // delete：级联（缓存侧单次 REMOVE_NodeTree 以覆盖 active + archive 两库）
    const targets = [
      ...descendants.map((d) => ({ kind: d.kind, nodeId: d.nodeId })),
      rootTarget,
    ];
    view.pipe.EXEC_RemoveTree(node.nodeId, targets);
    new Notice(`已删除 ${targets.length} 个节点`);
  };

  // 同上：有无子节点决定「仅当含子节点时提示」这一档拦不拦
  if (!NEEDS_Confirm(s.deleteConfirm, directChildren.length > 0)) {
    run();
    return;
  }
  const scope = mode === 'delete'
    ? `「${node.data.desc}」及其 ${descendants.length} 个后代将被一并删除（文件移入系统回收站）。`
    : mode === 'archive'
      ? `「${node.data.desc}」将被删除，其 ${descendants.length} 个后代改为归档（可在回收模式中还原）。`
      : `将删除「${node.data.desc}」，其 ${directChildren.length} 个直属子节点将脱离父级。`;
  new DestructiveConfirmModal(view.app, {
    title: '删除节点',
    message: scope,
    requiredWord: s.deleteConfirm === 'strict' ? STRICT_CONFIRM_WORD : undefined,
    confirmText: '删除',
    onConfirm: run,
  }).open();
}

/** 在 Obsidian 编辑器中打开节点文件（source 模式），定位光标到正文起始 */
export async function openNodeFile(view: NodeEditHost, nodeId: string): Promise<void> {
  const node = view.pipe.GET_Node(nodeId);
  if (!node) return;
  const filePath = GET_FileByPath(node.kind, nodeId, view.settings);
  const file = view.app.vault.getFileByPath(filePath);
  if (!(file instanceof TFile)) return;

  const leaf = view.app.workspace.getLeaf('tab');
  if (!leaf) return;
  await leaf.openFile(file, { state: { mode: 'source' } });

  try {
    const active = view.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file?.path === filePath) {
      const info = getFrontMatterInfo(active.data);
      active.editor.setCursor(active.editor.offsetToPos(info.contentStart ?? 0));
    }
  } catch (err) {
    console.warn('[SeqTK] 定位正文光标失败:', err);
  }
}
