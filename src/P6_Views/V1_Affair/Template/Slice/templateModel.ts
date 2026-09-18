/**
 * Template/Slice/templateModel — 模板模式「数据 → 视图状态」构建（视图层职责）
 *
 * 复用事务设计那套树构建与行模型（design/tree 的 buildTemplateTree、design/viewModel 的
 * buildTreeItems / buildFrameLine，形参都是 **DataPipe 只读门面**）：模板模式的左栏是
 * 「模板框架树」，与设计视图左栏同构，因此不必另写一套渲染数据构建。
 *
 * 本文件只做三件事：选数据（模板框架）、标出「归类容器」行、清掉模板模式未实现的
 * 交互标记（拖拽）。行的外观仍全部由 P7_Render（C1_NodeLine / C2_Tree）决定。
 */

import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { TreeNodeItem } from '../../../../P7_Render/Composition/C2_Tree/NodeTree';
import { IS_TemplateContainer } from '../../../../P7_Render/Structure/S2_Modal/TemplateModals';
import { buildTemplateTree } from '../../Design/Tool/tree';
import { buildFrameLine, buildTreeItems, type LineOverlay } from '../../Design/Tool/viewModel';

/**
 * 左栏空态文案
 *
 * 模板视图左栏与委托面板那棵空树说的是同一件事（新建入口都是右键），
 * 两处共用一句，免得改了一处忘了另一处。刻意不写「上方 / 下方」这类方位词 ——
 * 同一个常量在左栏与委托面板里都出现，方位在那里并不一样。
 */
export const EMPTY_TemplateTreeText =
    '暂无模板框架：在空白处右键「新建模板框架」，或先在事务设计里「存为模板」';

/** 归类容器徽章：含子框架的模板框架只是分类目录，不能编辑、也不会被「使用模板」查到 */
const CONTAINER_BADGE = {
    icon: '',
    text: '分类',
    tooltip: '含子框架：纯归类容器，不能打开编辑，也不会出现在「使用模板」的候选里',
};

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

/**
 * 左栏：全部模板框架（含嵌套的模板子框架），选中态与行覆盖态由调用方给出
 *
 * `overlayFor` 用于行内重命名（委托面板里点了「重命名」要显示输入框）；
 * 模板视图侧自己那棵树不走行内编辑，因此可以不传。
 */
export function BUILD_TemplateLeftItems(
    pipe: DataPipe,
    expanded: Set<string>,
    selectedId: string | null,
    overlayFor?: (nodeId: string) => LineOverlay,
): TreeNodeItem[] {
    const roots = buildTemplateTree(pipe);
    return CLEAR_Interactions(
        buildTreeItems(pipe, '', roots, expanded, (node, flags) => {
            const line = buildFrameLine(pipe, node, flags, node.nodeId === selectedId, overlayFor?.(node.nodeId));
            // 归类容器：行上加一枚徽章，免得看着像「选不了是坏了」
            if (!IS_TemplateContainer(pipe, node.nodeId)) return line;
            return { ...line, badges: [...(line.badges ?? []), CONTAINER_BADGE] };
        }),
    );
}
