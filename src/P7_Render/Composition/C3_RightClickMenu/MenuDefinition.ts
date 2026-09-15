/**
 * C3_RightClickMenu/MenuDefinition — 右键菜单的声明契约与装配器
 *
 * 形态对标 Obsidian 的设置面板注册（`getSettingDefinitions()`）：
 *   - 声明方（视图）实现一个返回**声明数组**的方法，不接触 Menu
 *   - 装配器读取声明并渲染，声明长什么样就画成什么样
 *
 * 由此把两件事彻底分开：
 *   「执行行为」——点什么执行什么，写在声明项的 action 里，仍属于视图
 *   「渲染效果」——图标怎么显示、分组怎么隔开、子菜单怎么展开，全在装配器
 *
 * 合同上一个关键约束：声明里**只能**出现「叫什么、长什么样、点了做什么」，
 * 不能出现 DOM 或 Menu 对象。视图因此看不见渲染细节，装配器也看不见业务。
 *
 * 与 `getSettingDefinitions()` 的差别（不是疏漏，是对方没有对应能力）：
 *   - 设置项的值由框架接管保存（getControlValue / setControlValue），菜单没有接管方，
 *     所以 action 必须由声明方给出，无法像 key 那样只写一个字段名
 *   - 设置项会进全局搜索索引，菜单不需要
 */

import { Menu, type MenuItem } from 'obsidian';

/**
 * 一个菜单项的定义
 *
 * 纯声明：不含 DOM、不含 Menu。字段命名对齐设置面板的 SettingDefinition ——
 * 都用 `name` 表示显示名，都用 `items` 表示嵌套内容。
 */
export interface MenuDefinition {
    /** 显示名（对应 SettingDefinition.name） */
    name: string;
    icon?: string;
    /**
     * 分组标识：相邻且 section 相同的项归为一组，组之间由装配器插入分隔符。
     * 留空视为默认组。用标识而不是「在某一项上打分隔标记」，
     * 是因为分组是**关系**，不是某一项的属性 —— 前者不会因为调整顺序而错位。
     */
    section?: string;
    /** true = 仅作分组标题，不可点 */
    label?: boolean;
    /** 勾选态（用于「当前状态」这类互斥项） */
    checked?: boolean;
    /** 子菜单（对应 SettingDefinition.items 的嵌套语义） */
    items?: MenuDefinition[];
    /** 点击执行；缺省则该项不响应（见装配器的说明） */
    action?: () => void;
}

/** 一个菜单的声明（对应 getSettingDefinitions 的返回值） */
export type MenuDefinitions = MenuDefinition[];

/** 把一条定义画成菜单项；子菜单能力缺失时平铺，避免出现点不动的空壳 */
function renderDefinition(menu: Menu, def: MenuDefinition): void {
    menu.addItem((item: MenuItem) => {
        item.setTitle(def.name);
        if (def.icon) item.setIcon(def.icon);
        if (def.label) item.setIsLabel(true);
        if (def.checked) item.setChecked(true);

        if (def.items && def.items.length > 0) {
            const setSubmenu = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
            if (typeof setSubmenu === 'function') {
                const sub = setSubmenu.call(item);
                for (const child of def.items) renderDefinition(sub, child);
                return;
            }
            // 旧运行时没有子菜单：平铺到父菜单，而不是留一个点不动的项
            item.setIsLabel(true);
            for (const child of def.items) renderDefinition(menu, child);
            return;
        }

        // 没有 action 的项仍然显示但不响应 —— 刻意如此：
        // 菜单里有东西而点了没反应，应该在开发时就看得出来，而不是让整项凭空消失。
        if (def.action) item.onClick(() => def.action?.());
    });
}

/**
 * 把声明装配成菜单并弹出
 *
 * 分组由 section 的「相邻同组」决定：遍历时发现 section 变化就插一个分隔符。
 * 因此声明方调整顺序后不需要回头看分隔符是否还落在正确的位置 —— 它自己跟着走。
 */
export function BUILD_Menu(defs: MenuDefinitions, e: MouseEvent): void {
    const menu = new Menu();
    let lastSection: string | undefined;

    for (const def of defs) {
        // 首项之前不加分隔；同一个 section 连续出现时也不加
        if (lastSection !== undefined && def.section !== lastSection) menu.addSeparator();
        lastSection = def.section;
        renderDefinition(menu, def);
    }

    menu.showAtMouseEvent(e);
}
