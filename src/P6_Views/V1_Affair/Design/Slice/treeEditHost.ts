/**
 * design/treeEditHost — 拖拽 / 排序类操作对「视图」的最小依赖
 *
 * 拖拽执行（Slice/drag）与拖拽事件（Slice/dragHandlers）原先直接收 `DesignView`，
 * 实际上只用到下面这几个成员。本接口只写**超出 NodeEditHost 的那部分**：
 * 数据面（pipe）、两组展开集合与两个重绘入口已经在 NodeEditHost 里，这里继承过来 ——
 * 平行再声明一遍必然与前者慢慢分叉（两处都改才生效，而且没有编译错误提醒）。
 *
 * 继承链（见 Design/Slice 各切片）：
 *   NodeEditHost           数据面 + 展开集合 + 左右栏重绘
 *    ├─ InlineEditView     + 行内新建 / 重命名态
 *    │   └─ MenuHost       + 正文编辑态 / 右栏来路栈（菜单声明用）
 *    └─ TreeEditHost       选中框架 / 顶级顺序 / 拖拽态 + 整体重绘（本文件）
 *
 * 线路模式的左栏框架树就是这样复用的：它与事务设计左栏是同一棵树，样式由 NodeTreePane 统一，
 * 改归属 / 排序这套逻辑不必再写第二遍。
 */

import type { NodeEditHost } from './actions';
import type { DragSource } from '../../../../P7_Render/Composition/C2_Tree/drag';

export interface TreeEditHost extends NodeEditHost {
    /** 视图容器（右栏空白高亮要往它里面找容器） */
    readonly containerEl: HTMLElement;
    /** 当前选中的框架（右栏空白落点的目标就是它） */
    readonly selectedFrameworkId: string | null;

    /** 顶级框架顺序（顶级排序用；读当前值即可） */
    topOrder: string[];
    /** 顶级顺序变更后回调（由装配层写回设置）；不关心持久化的视图可以不实现 */
    onTopOrderChange?(order: string[]): void;

    /** 正在拖拽的源（dragstart 写入，dragend 清空） */
    dragSource: DragSource | null;
    /** 正在拖拽的行 nodeId（行组件据此高亮） */
    draggingId: string | null;

    /** 整体重渲（拖拽提示等即时态收尾用） */
    refresh(): void;
}
