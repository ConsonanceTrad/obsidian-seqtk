/**
 * design/menuHost — 菜单声明对「视图」的最小依赖
 *
 * design/menuDefinitions 原先收 `DesignView`，实际只用到这几项：数据面、两组展开集合、
 * 当前选中的框架、行内编辑态，再加正文编辑态与右栏来路栈。抽成接口后，任何一棵「同一棵树」
 * 都能挂上同一套右键菜单，行为不会长出第二份。
 *
 * 与 treeEditHost 同一思路：只写**超出 BodyEditHost 的部分**。数据面、展开集合、重绘入口、
 * 行内新建 / 重命名态与正文编辑态都已在继承链上，不再重复声明。
 */

import type { BodyEditHost } from './inlineEdit';

export interface MenuHost extends BodyEditHost {
    /** 当前选中的框架（右栏菜单的落点就是它） */
    selectedFrameworkId: string | null;
    /** 右栏内下钻的来路栈（见 design/navigation.selectFramework） */
    frameworkNavStack: string[];
}
