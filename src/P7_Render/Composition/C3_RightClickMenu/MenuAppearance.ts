/**
 * C3_RightClickMenu/MenuAppearance — 右键菜单的外观集中层
 *
 * 只放**跨菜单复用**的外观件：图标名、分组标识、易变文案。
 * 单菜单独有的图标留在各自的声明里 —— 集中是为了让「改这里会波及哪几个菜单」
 * 一眼可见，而不是把每个字符串都搬进常量表。
 *
 * 本文件不含 action、不引用视图：它回答「长什么样」，不回答「点了做什么」。
 */

import { NODE_KIND } from '../../../P4_Nodes/NodeFacade';

/**
 * 证据类型（追加信息子菜单）的图标
 *
 * 键由 NODE_KIND 算出，而不是手写字符串：这几个常量的值长这样
 * （`EVIDENCE_FACTOR` / `EVIDENCE_REQUEST` / …），此前按 `factor` / `requirement`
 * 手写键，改名后查表全部落空 —— 表现为追加信息子菜单四项一个图标都没有。
 * 用计算键后，类型值再改也不会与图标表失配。
 */
export const EVIDENCE_ICONS: Record<string, string> = {
    [NODE_KIND.FACTOR]: 'box',
    [NODE_KIND.REQUEST]: 'check-square',
    [NODE_KIND.CLUE]: 'info',
    [NODE_KIND.SNAPSHOT]: 'camera',
};

/**
 * 分组标识
 *
 * 相邻且 section 相同的项归为一组，组间由装配器（MenuDefinition.BUILD_Menu）插入分隔符。
 * 用标识而不是「在某一项上打分隔标记」：分组是**关系**，不是某一项的属性 ——
 * 调整顺序时它自己跟着走，不会留下错位的分隔。
 *
 * 声明里每一项都要显式取一个值：undefined 不表示「默认组」，
 * 装配器拿它判断首项，混用会让某一处的分隔凭空消失。
 */
export const SECTION = {
    /** 主体操作：新建 / 编辑 / 状态 */
    main: 'main',
    /** 工具：模板与外部信息（节点行菜单的第二组） */
    tools: 'tools',
    /** 模板：存为 / 使用 */
    template: 'template',
    /** 元信息：归属、导出、打开文件 */
    meta: 'meta',
    /** 归档 */
    danger: 'danger',
    /** 从磁盘刷新 */
    refresh: 'refresh',
    /** 以文本编辑框架内容（右栏空白菜单独有） */
    framework: 'framework',
} as const;

/** 跨菜单复用的图标（同一图标出现在多个菜单里时才收进来） */
export const ICON = {
    newFramework: 'folder-plus',
    newChild: 'plus',
    evidence: 'plus',
    newConcept: 'lightbulb',
    newCheck: 'list-checks',
    newEvent: 'calendar',
    rename: 'pencil',
    editAttrs: 'settings-2',
    editDesc: 'file-text',
    editFrameworkContent: 'file-text',
    /** 批量文本编辑（整棵子树来回改） */
    batchEdit: 'file-edit',
    /** 模板组的入口 */
    templateGroup: 'bookmark',
    /** 外部信息组的入口 */
    externalGroup: 'link',
    /** 变更归属 */
    changeParent: 'move',
    /** 复制为文本 */
    copyText: 'clipboard-copy',
    /** 打开文件 */
    openFile: 'external-link',
    saveAsTemplate: 'bookmark-plus',
    useTemplate: 'bookmark-check',
    archive: 'archive',
    syncFromFiles: 'refresh-cw',
    changeState: 'refresh-cw',
} as const;

/**
 * 状态圆点 / 状态菜单项的图标（四态各一）
 *
 * 与行上的圆点同源：圆点用颜色区分，菜单里既要颜色又要图标，于是给状态项配这一组。
 */
export const STATE_ICON: Record<string, string> = {
    plan: 'circle',
    open: 'loader',
    done: 'check-circle',
    drop: 'x-circle',
};

/** 展开：标题与图标随即将执行的行为变化（无子项的行不出现） */
export const EXPAND_ITEM = { name: '展开', icon: 'unfold-vertical' } as const;

/** 收起：同上 */
export const COLLAPSE_ITEM = { name: '收起', icon: 'fold-vertical' } as const;
