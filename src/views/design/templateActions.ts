/**
 * design/templateActions — 设计视图模板操作切片
 *
 * 从 DesignView 拆出的右键菜单「存为模板 / 使用模板」编排(整棵子树),
 * 底层克隆逻辑在 core/template.ts(cloneSubtree / parameterizeText)。
 * 菜单项构建函数 appendTemplateMenu 也归此处,供菜单切片(menus.ts)调用。
 *
 * 功能增补指引:
 * - 新增模板类操作(模板预览、批量替换)→ 在此新增 export function 并在
 *   menus.ts 的 appendTemplateMenu 中接线
 */

import { Notice, Menu } from 'obsidian';
import type { DesignView } from '../DesignView';
import {
  cloneSubtree,
  parameterizeText,
  TEMPLATE_FRAMEWORK_NAME_TOKEN,
} from '../../core/template';
import {
  SelectFrameworkModal,
  TemplateUnitSelectModal,
  listTemplateUnits,
} from '../components/TemplateModals';
import { getAllowedChildKinds } from '../../types/index';
import type { TreeNode } from './tree';

/**
 * 右键菜单模板操作组（普通节点行 / 框架行共用）：
 * - 存为模板：将当前节点整棵子树复制进所选模板框架（源根名自动参数化为 {{框架名}}）
 * - 使用模板：选择模板单元，克隆到当前节点/框架下（{{框架名}} 替换为当前节点名）
 * 「打开模板库」不在右键提供：模板库管理请用中控台/命令面板的「模板模式」。
 */
export function appendTemplateMenu(menu: Menu, view: DesignView, node: TreeNode): void {
  menu.addItem((item) =>
    item.setTitle('存为模板').setIcon('save')
      .onClick(() => void saveAsTemplate(view, node.nodeId)));
  menu.addItem((item) =>
    item.setTitle('使用模板').setIcon('paste')
      .onClick(() => useTemplate(view, node.nodeId)));
}

/** 存为模板：子树整体存入所选模板框架，成为该框架下新的模板单元 */
export async function saveAsTemplate(view: DesignView, sourceId: string): Promise<void> {
  if (!view.nodeCache.isInitialized) {
    new Notice('查询缓存尚未就绪，请稍候');
    return;
  }
  const source = view.nodeCache.getNode(sourceId);
  if (!source) return;

  const templates = view.nodeCache.getByKind('framework-template');
  if (templates.length === 0) {
    new Notice('暂无模板框架：请先在模板模式中创建模板框架');
    return;
  }

  new SelectFrameworkModal(view.app, {
    title: '存为模板 · 选择模板框架',
    frameworks: templates.map((t) => ({ nodeId: t.nodeId, label: t.data.desc })),
    onSelect: async (targetTemplateId) => {
      // 克隆整棵子树；源根名出现处参数化为 {{框架名}}（含 body），复用后替换为目标名
      const newRootId = await cloneSubtree({
        sourceId,
        parentId: targetTemplateId,
        nodeCache: view.nodeCache,
        fileManager: view.fileManager,
        operationQueue: view.operationQueue,
        resolveText: (text) => parameterizeText(text, source.desc),
      });
      new Notice(newRootId ? '已存入模板框架' : '存为模板失败');
    },
  }).open();
}

/** 使用模板：选择可用模板单元克隆到当前节点/框架下（插入为其直属子项，末尾追加） */
export function useTemplate(view: DesignView, targetParentId: string): void {
  if (!view.nodeCache.isInitialized) {
    new Notice('查询缓存尚未就绪，请稍候');
    return;
  }
  const parent = view.nodeCache.getNode(targetParentId);
  if (!parent) return;

  const allowedKinds = getAllowedChildKinds(parent.kind);
  const units = listTemplateUnits(view.nodeCache).filter((e) => allowedKinds.includes(e.unit.data.kind));

  if (units.length === 0) {
    new Notice(view.nodeCache.getByKind('framework-template').length === 0
      ? '暂无模板单元：可先右键「存为模板」创建'
      : '现有模板均无法插入该位置（类型不匹配）');
    return;
  }

  new TemplateUnitSelectModal(view.app, view.nodeCache, {
    units,
    onSelect: (entry) => void applyTemplateUnit(view, entry, { nodeId: targetParentId, desc: parent.desc }),
  }).open();
}

/** 应用模板单元：整棵子树克隆到目标父下，{{框架名}} 替换为目标父名，随后展开目标 */
export async function applyTemplateUnit(
  view: DesignView,
  entry: { unit: { nodeId: string } },
  targetParent: { nodeId: string; desc: string },
): Promise<void> {
  const newRootId = await cloneSubtree({
    sourceId: entry.unit.nodeId,
    parentId: targetParent.nodeId,
    nodeCache: view.nodeCache,
    fileManager: view.fileManager,
    operationQueue: view.operationQueue,
    resolveText: (text) => text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(targetParent.desc),
  });
  if (!newRootId) {
    new Notice('应用模板失败');
    return;
  }
  // 插入后展开目标父，供查看新建的子树
  view.expandedLeft.add(targetParent.nodeId);
  view.expandedRight.add(targetParent.nodeId);
  view.renderLeft();
  view.renderRight();
  new Notice('模板已应用');
}
