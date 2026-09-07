/**
 * design/inline — 设计视图行内交互切片
 *
 * 从 DesignView 拆出的行内编辑/新建能力:
 * - 行内重命名(beginInlineRename + beginInlineEdit / beginInlineEditFrame):覆盖层输入框,
 *   不参与行布局、不遮挡下方行;Enter 保存、Esc/blur 取消
 * - 行内新建(beginInlineCreateBlank / beginInlineCreate):在容器或子列表末尾插入附加行
 *   （类型预览/下拉 + 名称输入）,创建成功后局部替换为新行
 * - 行内正文编辑(beginInlineEditBody):行下覆盖式 textarea,Ctrl+Enter 保存
 *
 * 功能增补指引:
 * - 新增行内快捷操作(行内改状态、行内换类型)→ 参考 beginInlineEditBody 的覆盖层模式
 * - 调整新建后插入位置/展开行为 → 改 beginInlineCreateBlank / beginInlineCreate
 */

import type { DesignView } from '../DesignView';
import type { NodeKind } from '../../types/index';
import { NODE_KIND_LABELS, getCategoryOf, getAllowedChildKinds } from '../../types/index';
import type { TreeNode } from './tree';
import { buildNode, buildFrameworkNode } from './tree';
import { createNode, saveNodeDesc, saveNodeBody } from './actions';

/**
 * 行内编辑节点名：在行上叠加绝对定位输入框（覆盖层，不参与行布局）。
 * 行内元素与行高保持不变，避免下方行位移；输入框从类型徽章右缘覆盖至行尾，
 * 保留类型徽章可见。Enter 保存、Esc 取消、失焦（blur）保存。
 */
export function beginInlineEdit(view: DesignView, node: TreeNode, row: HTMLElement): void {
  beginInlineRename(view, node, row, () => view.renderRight());
}

/**
 * 行内编辑框架名：同上覆盖层方式；完成后重绘左栏。
 */
export function beginInlineEditFrame(view: DesignView, node: TreeNode, row: HTMLElement): void {
  beginInlineRename(view, node, row, () => view.renderLeft());
}

/**
 * 覆盖层式行内重命名公共实现：
 * - 不改动行内任何元素（行高/布局零变化，不遮挡下方内容布局）
 * - 输入框 position:absolute 追加到行尾，left 定为类型徽章右缘、right 固定到行尾
 * - 类型徽章保留可见；右侧预期徽章/状态圆点/按钮在编辑期被覆盖层遮住
 */
export function beginInlineRename(view: DesignView, node: TreeNode, row: HTMLElement, afterDone: () => void): void {
  if (row.querySelector('.seqtk-inline-edit-overlay')) return;

  const overlay = document.createElement('input');
  overlay.className = 'seqtk-inline-edit-overlay';
  overlay.value = node.data.desc;
  row.appendChild(overlay);

  // 定位左边界：类型徽章右缘（保留徽章可见；徽章靠左且行不换行，此值在编辑期间稳定）
  const badge = row.querySelector<HTMLElement>('.seqtk-kind-badge');
  if (badge) {
    const rowRect = row.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    overlay.style.left = `${badgeRect.right - rowRect.left + 4}px`;
  } else {
    overlay.style.left = `${parseFloat(row.style.paddingLeft) || 8}px`;
  }

  overlay.focus();
  overlay.select();

  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    const newDesc = overlay.value.trim();
    if (save && newDesc && newDesc !== node.data.desc) {
      saveNodeDesc(view, node, newDesc);
    }
    afterDone();
  };

  // 编辑期间阻止行级单击/双击（不触发展开/再次编辑）
  overlay.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('dblclick', (e) => e.stopPropagation());
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
  });
  overlay.addEventListener('blur', () => finish(true));
}

/**
 * 行内创建（空白区域右键）：在容器末尾插入附加行（类型预览 + 名称输入），
 * Enter 创建、Esc/blur 取消。
 */
export function beginInlineCreateBlank(view: DesignView, kind: NodeKind, container: HTMLElement, parentId?: string): void {
  if (container.querySelector('.seqtk-inline-add')) return;
  const addRow = container.createDiv('seqtk-inline-add');
  addRow.style.paddingLeft = '8px';
  // 框架类型：显示"框架"标签 + 蓝色语义类；证据类型：橙色（与行徽章一致）
  const isFw = kind === 'framework-transaction';
  const catCls = isFw ? ' kind-framework' : getCategoryOf(kind) === 'evidence' ? ' kind-evidence' : '';
  const previewCls = `seqtk-inline-kind-preview${catCls}`;
  const previewText = isFw ? '框架' : NODE_KIND_LABELS[kind];
  addRow.createEl('span', { cls: previewCls, text: previewText });
  const input = addRow.createEl('input', { cls: 'seqtk-inline-name', placeholder: `输入${NODE_KIND_LABELS[kind]}名称…` });
  input.focus();

  let finished = false;
  const finish = (confirm: boolean): void => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (!confirm || !name) {
      addRow.remove();
      return;
    }
    // 右栏「全部事务总览」模式（无父）：不提前移除 addRow，由缓存订阅触发的全量渲染一次到位
    if (container === view.rightEl && !parentId) {
      void createNode(view, { kind, desc: name, state: 'plan', afterCreate: 'direct' })
        .then((ok) => { if (!ok) addRow.remove(); });
      return;
    }
    // 其余行内新建：抑制全量重渲染，创建成功后原地替换为新行（避免画面闪烁）
    void (async () => {
      view.suppressRender = true;
      try {
        const side = container === view.leftEl ? 'left' : 'right';
        const nodeId = await createNode(
          view,
          { kind, desc: name, state: 'plan', afterCreate: 'direct' },
          parentId,
          { skipRender: true, side },
        );
        if (!nodeId) { addRow.remove(); return; }
        const nodeData = view.nodeCache.getNode(nodeId);
        if (!nodeData) { addRow.remove(); return; }
        let newRow: HTMLElement;
        if (kind === 'framework-transaction') {
          // 左栏空白新建框架：渲染顶级框架行并原地替换
          newRow = view.renderFrameNode(buildFrameworkNode(view.nodeCache, nodeId, nodeData), 0);
        } else {
          newRow = view.renderNode(buildNode(view.nodeCache, nodeId, nodeData), 0, view.rightEl, false, parentId);
          newRow.style.paddingLeft = addRow.style.paddingLeft || '8px';
        }
        // 清理由空列表展示的占位提示（首次创建场景）
        container.querySelectorAll('.seqtk-empty').forEach((el) => el.remove());
        addRow.replaceWith(newRow);
      } finally {
        view.suppressRender = false;
      }
    })();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
}

/**
 * 行内新建子节点：若父节点收起则先展开；在子列表末尾插入附加行
 * （类型预览 + 名称输入），Enter 创建、Esc/blur 取消。
 *
 * @param kindsOverride 固定子类型列表（如「追加信息」菜单），缺省按父节点类型推导
 * @param side 所在栏（左栏 .seqtk-frame-item / 右栏 .seqtk-row），决定展开状态与渲染方式
 */
export function beginInlineCreate(view: DesignView, node: TreeNode, row: HTMLElement, kindsOverride?: NodeKind[], side: 'left' | 'right' = 'right'): void {
  const isLeft = side === 'left';
  const rowSel = isLeft ? '.seqtk-frame-item' : '.seqtk-row';
  const expandedSet = isLeft ? view.expandedLeft : view.expandedRight;
  const containerEl = isLeft ? view.leftEl : view.rightEl;
  if (row.parentElement?.querySelector('.seqtk-inline-add')) return;
  const kinds = kindsOverride ?? getAllowedChildKinds(node.data.kind);
  if (kinds.length === 0) return;

  // 收起状态：先展开父节点并重渲染，再定位新行
  if (!expandedSet.has(node.nodeId)) {
    expandedSet.add(node.nodeId);
    if (isLeft) view.renderLeft(); else view.renderRight();
    const newRow = containerEl.querySelector<HTMLElement>(`${rowSel}[data-node-id="${node.nodeId}"]`);
    if (!newRow) return;
    row = newRow;
  }

  const addRow = row.parentElement!.createDiv('seqtk-inline-add');
  // 缩进对齐新子节点层级：父行缩进 + 步长（右栏行 18px / 左栏框架行 14px）
  addRow.style.paddingLeft = `${(parseFloat(row.style.paddingLeft) || 8) + (isLeft ? 14 : 18)}px`;
  // 附加行总高与父行（同层级普通行）精确对齐，避免插入时行高度跳动
  addRow.style.boxSizing = 'border-box';
  const rowHeight = row.offsetHeight;
  if (rowHeight > 0) addRow.style.minHeight = `${rowHeight}px`;

  // 定位子列表末尾：该节点子树渲染的最后一行之后
  const subtreeIds = new Set<string>();
  const collect = (n: TreeNode): void => {
    subtreeIds.add(n.nodeId);
    for (const c of n.children) collect(c);
  };
  collect(node);
  let anchor: HTMLElement = row;
  let sib = row.nextElementSibling;
  const rowCls = isLeft ? 'seqtk-frame-item' : 'seqtk-row';
  while (sib && sib.classList.contains(rowCls) && subtreeIds.has((sib as HTMLElement).dataset.nodeId ?? '')) {
    anchor = sib as HTMLElement;
    sib = sib.nextElementSibling;
  }
  anchor.after(addRow);

  let kind: NodeKind = kinds[0];
  if (kinds.length > 1) {
    // 多子类型：类型下拉（位于输入框前；点击不结束编辑，选完回到输入框）
    const sel = addRow.createEl('select', { cls: 'seqtk-inline-kind' });
    for (const k of kinds) sel.createEl('option', { value: k, text: NODE_KIND_LABELS[k] });
    sel.addEventListener('change', () => { kind = sel.value as NodeKind; setPlaceholder(); input.focus(); });
  } else {
    // 单子类型：类型预览标签（框架显示蓝色"框架"；证据类型橙色，与行徽章一致）
    const isFw = kind === 'framework-transaction';
    const catCls = isFw ? ' kind-framework' : getCategoryOf(kind) === 'evidence' ? ' kind-evidence' : '';
    const previewText = isFw ? '框架' : NODE_KIND_LABELS[kind];
    addRow.createEl('span', { cls: `seqtk-inline-kind-preview${catCls}`, text: previewText });
  }
  const input = addRow.createEl('input', { cls: 'seqtk-inline-name' });
  // 显式约束输入框高度 = 附加行内容区高度（border-box；左右栏纵向 padding 分别为 6/8px），
  // 避免输入框按字号放大而撑高附加行导致跳动（rowHeight 已在 addRow 创建处测得）
  if (rowHeight > 0) {
    const vPad = isLeft ? 8 : 6;
    input.style.height = `${rowHeight - vPad}px`;
    input.style.boxSizing = 'border-box';
  }
  const setPlaceholder = (): void => { input.placeholder = `输入${NODE_KIND_LABELS[kind]}名称…`; };
  setPlaceholder();
  input.focus();

  let finished = false;
  const finish = (confirm: boolean): void => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (!confirm || !name) {
      addRow.remove();
      return;
    }
    // 平滑创建：抑制全量重渲染，创建成功后原地替换为新行（避免画面闪烁）
    void (async () => {
      view.suppressRender = true;
      try {
        const nodeId = await createNode(
          view,
          { kind, desc: name, state: 'plan', afterCreate: 'direct' },
          node.nodeId,
          { skipRender: true, side },
        );
        if (!nodeId) { addRow.remove(); return; }
        if (isLeft) {
          // 左栏仅展示框架：重绘左栏即可（列表小、无闪烁；非框架子项不出现在左栏属正常语义）
          view.renderLeft();
          return;
        }
        const nodeData = view.nodeCache.getNode(nodeId);
        if (!nodeData) { addRow.remove(); return; }
        const container = row.parentElement!;
        const newRow = view.renderNode(buildNode(view.nodeCache, nodeId, nodeData), 0, container, true, node.nodeId);
        // 保持与附加行一致的层级缩进
        newRow.style.paddingLeft = addRow.style.paddingLeft || row.style.paddingLeft;
        // 清理由空列表展示的占位提示（首次创建场景）
        container.querySelectorAll('.seqtk-empty').forEach((el) => el.remove());
        addRow.replaceWith(newRow);
      } finally {
        view.suppressRender = false;
      }
    })();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  // 焦点移到附加行内（如类型下拉）不结束编辑
  input.addEventListener('blur', (e) => {
    const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
    if (related && addRow.contains(related)) return;
    finish(false);
  });
}

/**
 * 行内编辑正文：节点行紧邻下方覆盖式多行 textarea。
 * Ctrl+Enter 保存、Esc 取消、失焦（blur）保存。
 */
export function beginInlineEditBody(view: DesignView, node: TreeNode, row: HTMLElement): void {
  if (row.parentElement?.querySelector('.seqtk-inline-body')) return;
  const current = view.nodeCache.getNodeBody(node.nodeId) ?? '';

  const wrap = row.parentElement!.createDiv('seqtk-inline-body');
  row.after(wrap);

  const area = wrap.createEl('textarea', { cls: 'seqtk-inline-body-area' });
  area.value = current;
  area.focus();
  area.setSelectionRange(current.length, current.length);

  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    const body = area.value;
    wrap.remove();
    if (save && body !== current) {
      saveNodeBody(view, node, body);
    }
    view.renderRight();
  };
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  area.addEventListener('blur', () => finish(true));
}
