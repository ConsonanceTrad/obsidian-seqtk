/**
 * design/menus — 设计视图右键菜单构建切片
 *
 * 从 DesignView 拆出的全部右键/空白菜单构建:
 * - showFrameMenu:框架行菜单(左栏：新建子框架/重命名；右栏：行内新建子项入口)
 * - showRowMenu:普通节点行菜单(新建子项/重命名/编辑描述/修改属性/状态/模板/打开/归档/删除)
 * - showLeftBlankMenu / showRightBlankMenu:左右栏空白处右键
 * - showStateMenu:状态圆点右键的完整状态菜单
 * - appendEvidenceMenu:「追加信息」二级子菜单(对象/条件/信息/状态)
 *
 * 功能增补指引:
 * - 新增右键菜单项 → 在此文件对应菜单构建函数中追加 menu.addItem
 * - 新增菜单动作的数据写 → 引 design/actions.ts;行内交互 → 引 design/inline.ts
 */

import { Menu, Notice } from 'obsidian';
import type { DesignView } from '../DesignView';
import type { NodeKind } from '../../types/index';
import { NODE_KIND_LABELS, NODE_STATE_LABELS, STATE_VALUES, getAllowedChildKinds } from '../../types/index';
import { kindUsesState } from '../components/TransactionModals';
import type { TreeNode } from './tree';
import { EVIDENCE_KINDS } from './drag';
import { appendTemplateMenu } from './templateActions';
import { openEdit, openNodeFile, archiveNode, deleteNodeTree, setNodeState } from './actions';
import {
  beginInlineCreate,
  beginInlineCreateBlank,
  beginInlineEdit,
  beginInlineEditFrame,
  beginInlineEditBody,
} from './inline';

/**
 * 追加信息：二级子菜单（对象/条件/信息/状态），点击后执行 onPick(kind) 行内创建对应证据类型。
 * 节点行菜单、右侧框架菜单、右栏空白菜单共用。
 */
export function appendEvidenceMenu(menu: Menu, onPick: (k: NodeKind) => void): void {
  const EVIDENCE_ICONS: Record<string, string> = {
    factor: 'box',
    requirement: 'check-square',
    clue: 'info',
    snapshot: 'camera',
  };
  let usedEvidenceSubmenu = false;
  menu.addItem((item) => {
    item.setTitle('追加信息').setIcon('plus');
    const setSubmenu = (item as any).setSubmenu as (() => Menu) | undefined;
    if (typeof setSubmenu === 'function') {
      const sub = setSubmenu.call(item) as Menu;
      for (const k of EVIDENCE_KINDS) {
        sub.addItem((si) =>
          si.setTitle(NODE_KIND_LABELS[k]).setIcon(EVIDENCE_ICONS[k]).onClick(() => onPick(k)));
      }
      usedEvidenceSubmenu = true;
    } else {
      item.setIsLabel(true);
    }
  });
  if (!usedEvidenceSubmenu) {
    for (const k of EVIDENCE_KINDS) {
      menu.addItem((item) =>
        item.setTitle(NODE_KIND_LABELS[k]).setIcon(EVIDENCE_ICONS[k]).onClick(() => onPick(k)));
    }
  }
}

/** 左栏空白右键：新建框架（行内）+ 从磁盘刷新 */
export function showLeftBlankMenu(view: DesignView, e: MouseEvent): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle('新建框架').setIcon('folder-plus')
      .onClick(() => beginInlineCreateBlank(view, 'framework-transaction', view.leftEl)));
  menu.addSeparator();
  menu.addItem((item) =>
    item.setTitle('从磁盘刷新').setIcon('refresh-cw')
      .onClick(async () => {
        if (!view.nodeCache.isInitialized) {
          new Notice('查询缓存尚未就绪，请稍候');
          return;
        }
        await view.nodeCache.verifyWithDisk(view.fileManager);
        new Notice('已从磁盘刷新');
      }));
  menu.showAtMouseEvent(e);
}

/** 右栏空白右键：新建构想/清单/事件（行内）+ 从磁盘刷新（选中框架时以框架为父） */
export function showRightBlankMenu(view: DesignView, e: MouseEvent): void {
  const menu = new Menu();
  const parentId = view.selectedFrameworkId ?? undefined;

  menu.addItem((item) =>
    item.setTitle('新建构想').setIcon('plus')
      .onClick(() => beginInlineCreateBlank(view, 'concept', view.rightEl, parentId)));
  menu.addItem((item) =>
    item.setTitle('新建清单').setIcon('plus')
      .onClick(() => beginInlineCreateBlank(view, 'checklist', view.rightEl, parentId)));
  menu.addItem((item) =>
    item.setTitle('新建事件').setIcon('plus')
      .onClick(() => beginInlineCreateBlank(view, 'event', view.rightEl, parentId)));
  // 追加信息：二级子菜单（对象/条件/信息/状态），行内创建证据类型（插入右栏末尾）
  appendEvidenceMenu(menu, (k) => beginInlineCreateBlank(view, k, view.rightEl, parentId));
  menu.addSeparator();

  menu.addItem((item) =>
    item.setTitle('从磁盘刷新').setIcon('refresh-cw')
      .onClick(async () => {
        if (!view.nodeCache.isInitialized) {
          new Notice('查询缓存尚未就绪，请稍候');
          return;
        }
        await view.nodeCache.verifyWithDisk(view.fileManager);
        new Notice('已从磁盘刷新');
      }));

  menu.showAtMouseEvent(e);
}

export function showFrameMenu(view: DesignView, e: MouseEvent, node: TreeNode, side: 'left' | 'right' = 'left'): void {
  const menu = new Menu();
  // 展开/收起置顶：描述与图标随即将执行的行为变化（折叠→展开，展开→收起）；展开状态按栏独立
  if (node.children.length > 0) {
    const isExpanded = (side === 'left' ? view.expandedLeft : view.expandedRight).has(node.nodeId);
    menu.addItem((item) =>
      item.setTitle(isExpanded ? '收起' : '展开').setIcon(isExpanded ? 'fold-vertical' : 'unfold-vertical')
        .onClick(() => view.toggleExpandAll(node, side)));
  }
  const splitCreate = side === 'right';
  if (splitCreate) {
    // 右侧框架菜单：新建子项拆分为四个行内创建入口（不开模态框）
    const inlineCreate = (k: NodeKind): void => {
      const row = (e.target as HTMLElement).closest('.seqtk-row');
      if (row) beginInlineCreate(view, node, row as HTMLElement, [k], 'right');
    };
    menu.addItem((item) =>
      item.setTitle('新建构思').setIcon('lightbulb').onClick(() => inlineCreate('concept')));
    menu.addItem((item) =>
      item.setTitle('新建清单').setIcon('list-checks').onClick(() => inlineCreate('checklist')));
    menu.addItem((item) =>
      item.setTitle('新建事件').setIcon('calendar').onClick(() => inlineCreate('event')));
    appendEvidenceMenu(menu, inlineCreate);
  } else {
    // 左栏框架菜单：新建子框架（行内添加，蓝色"框架"预览标签 + 名称输入，保持旧版行为）
    menu.addItem((item) =>
      item.setTitle('新建子框架').setIcon('folder-plus')
        .onClick(() => {
          const row = (e.target as HTMLElement).closest('.seqtk-frame-item');
          if (row) beginInlineCreate(view, node, row as HTMLElement, ['framework-transaction'], 'left');
        }));
  }
  menu.addItem((item) =>
    item.setTitle('重命名').setIcon('pencil')
      .onClick(() => {
        // 右栏框架行为 .seqtk-row，左栏为 .seqtk-frame-item，按行类选择对应行内编辑
        const row = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
        if (!row) return;
        if (row.classList.contains('seqtk-frame-item')) {
          beginInlineEditFrame(view, node, row);
        } else {
          beginInlineEdit(view, node, row);
        }
      }));
  menu.addItem((item) =>
    item.setTitle('修改属性').setIcon('settings-2')
      .onClick(() => openEdit(view, node.nodeId)));
  menu.addSeparator();
  // 模板操作组：存为模板 / 使用模板（框架行同样可整体存为模板）
  appendTemplateMenu(menu, view, node);
  menu.addSeparator();
  menu.addItem((item) =>
    item.setTitle('归档').setIcon('archive')
      .onClick(() => archiveNode(view, node.nodeId)));
  menu.addItem((item) =>
    item.setTitle('删除').setIcon('trash')
      .onClick(() => deleteNodeTree(view, node)));
  menu.showAtMouseEvent(e);
}

export function showRowMenu(view: DesignView, e: MouseEvent, node: TreeNode): void {
  const menu = new Menu();

  if (node.children.length > 0) {
    const isExpanded = view.expandedRight.has(node.nodeId);
    // 描述与图标随即将执行的行为变化：折叠→显示"展开"，展开→显示"收起"
    menu.addItem((item) =>
      item.setTitle(isExpanded ? '收起' : '展开').setIcon(isExpanded ? 'fold-vertical' : 'unfold-vertical')
        .onClick(() => view.toggleExpandAll(node, 'right')));
  }
  if (getAllowedChildKinds(node.data.kind).length > 0) {
    menu.addItem((item) =>
      item.setTitle('新建子项').setIcon('plus')
        .onClick(() => {
          const row = (e.target as HTMLElement).closest('.seqtk-row');
          if (!row) return;
          // target（目标）新建子项固定为工序（process）
          const kinds: NodeKind[] | undefined = node.data.kind === 'target' ? ['process'] : undefined;
          beginInlineCreate(view, node, row as HTMLElement, kinds);
        }));
  }
  // 追加信息：二级子菜单（对象/条件/信息/状态），点击后行内创建对应证据类型（不开模态框）
  appendEvidenceMenu(menu, (k) => {
    const row = (e.target as HTMLElement).closest('.seqtk-row');
    if (row) beginInlineCreate(view, node, row as HTMLElement, [k]);
  });
  menu.addItem((item) =>
    item.setTitle('重命名').setIcon('pencil')
      .onClick(() => {
        const row = (e.target as HTMLElement).closest('.seqtk-row');
        if (row) beginInlineEdit(view, node, row as HTMLElement);
      }));
  menu.addItem((item) =>
    item.setTitle('编辑描述').setIcon('file-text')
      .onClick(() => {
        const row = (e.target as HTMLElement).closest('.seqtk-row');
        if (row) beginInlineEditBody(view, node, row as HTMLElement);
      }));
  menu.addItem((item) =>
    item.setTitle('修改属性').setIcon('settings-2')
      .onClick(() => openEdit(view, node.nodeId)));
  if (kindUsesState(node.data.kind)) {
    // 状态更改：二级子菜单（运行时支持 setSubmenu 则用子菜单，否则回退内联状态项）
    let usedSubmenu = false;
    menu.addItem((item) => {
      item.setTitle('状态更改').setIcon('refresh-cw');
      const setSubmenu = (item as any).setSubmenu as (() => Menu) | undefined;
      if (typeof setSubmenu === 'function') {
        const sub = setSubmenu.call(item) as Menu;
        for (const s of [...STATE_VALUES]) {
          sub.addItem((si) => {
            si.setTitle(NODE_STATE_LABELS[s]);
            if (node.data.state === s) si.setChecked(true);
            si.onClick(() => setNodeState(view, node.nodeId, s));
          });
        }
        usedSubmenu = true;
      } else {
        item.setIsLabel(true);
      }
    });
    if (!usedSubmenu) {
      for (const s of [...STATE_VALUES]) {
        menu.addItem((item) => {
          item.setTitle(NODE_STATE_LABELS[s]);
          if (node.data.state === s) item.setChecked(true);
          item.onClick(() => setNodeState(view, node.nodeId, s));
        });
      }
    }
  }
  menu.addSeparator();
  // 模板操作组：存为模板 / 使用模板（右键当前节点子树）
  appendTemplateMenu(menu, view, node);
  menu.addSeparator();
  menu.addItem((item) =>
    item.setTitle('打开文件').setIcon('external-link')
      .onClick(() => void openNodeFile(view, node.nodeId)));
  menu.addItem((item) =>
    item.setTitle('归档').setIcon('archive')
      .onClick(() => archiveNode(view, node.nodeId)));
  menu.addItem((item) =>
    item.setTitle('删除').setIcon('trash')
      .onClick(() => deleteNodeTree(view, node)));

  menu.showAtMouseEvent(e);
}

/** 状态圆点右键：完整状态菜单（单击状态圆点本身是循环切换，不经过此菜单） */
export function showStateMenu(view: DesignView, e: MouseEvent, node: TreeNode): void {
  const menu = new Menu();
  for (const s of [...STATE_VALUES]) {
    menu.addItem((item) => {
      item.setTitle(NODE_STATE_LABELS[s]);
      if (node.data.state === s) item.setChecked(true);
      item.onClick(() => setNodeState(view, node.nodeId, s));
    });
  }
  menu.showAtMouseEvent(e);
}
