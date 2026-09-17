/**
 * Template/Slice/templateModel — 模板模式「数据 → 视图状态」构建（视图层职责）
 *
 * 复用事务设计那套树构建与行模型（design/tree 的 buildTemplateTree、design/viewModel 的
 * buildTreeItems / buildFrameLine，形参都是 **DataPipe 只读门面**）：模板模式的左栏是
 * 「模板框架树」，与设计视图左栏同构，因此不必另写一套渲染数据构建。
 *
 * 本文件只做两件事：选数据（模板框架）、清掉模板模式未实现的交互标记（拖拽）。
 * 行的外观仍全部由 P7_Render（C1_NodeLine / C2_Tree）决定。
 */

import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { TreeNodeItem } from '../../../../P7_Render/Composition/C2_Tree/NodeTree';
import { buildTemplateTree } from '../../Design/Tool/tree';
import { buildFrameLine, buildTreeItems } from '../../Design/Tool/viewModel';

/**
 * 清掉视图未接线的交互标记
 *
 * 行模型来自设计视图（那里每行都可拖），模板模式不提供拖拽回调 —— 行若仍带 `draggable`，
 * 拖起来毫无反应，看起来像坏了。这里统一摘掉，免得以后在两处各记一遍。
 */
function CLEAR_Interactions(items: TreeNodeItem[]): TreeNodeItem[] {
    return items.map((item) => ({
        line: { ...item.line, draggable: false },
        children: CLEAR_Interactions(item.children),
    }));
}

/** 左栏：全部模板框架（含嵌套的模板子框架），选中态来自 selectedId */
export function BUILD_TemplateLeftItems(
    pipe: DataPipe,
    expanded: Set<string>,
    selectedId: string | null,
): TreeNodeItem[] {
    const roots = buildTemplateTree(pipe);
    return CLEAR_Interactions(
        buildTreeItems(pipe, '', roots, expanded, (node, flags) =>
            buildFrameLine(pipe, node, flags, node.nodeId === selectedId),
        ),
    );
}
