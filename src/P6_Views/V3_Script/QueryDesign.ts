/**
 * QueryDesignView — 查询设计 · 双栏骨架（占位）
 *
 * 基于 DualPane 的双栏可视化占位：使用内置脚本配合 db 实现相关信息查询，
 * 支持复杂语句，支持查询结果解析输出模块以供使用。
 * - 左栏：查询脚本（内置脚本库 / 复杂语句）
 * - 右栏：查询执行与结果解析
 *
 * 后续接入功能时只需替换 QueryDesignPanel 的内容；当前无功能、无订阅。
 * 逻辑与渲染分离：本文件只负责注册与生命周期，渲染在 QueryDesignPanel.tsx。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { VIEW_TYPE_QUERY_DESIGN } from "../V0_Common/Blank";
import { QueryDesignPanel } from "./QueryDesignPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";

@AutoView()
@AutoRegister()
export class QueryDesignView extends ReactViewBase {
    /** 面板目录条目（规划中占位） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_QUERY_DESIGN, title: '查询设计', icon: 'search', description: '使用内置脚本配合 db 实现相关信息查询，支持复杂语句，查询结果解析输出模块。', category: '规则设计', placeholder: true},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): QueryDesignView {
        return new QueryDesignView(leaf);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-query-design',
            name: '打开查询设计',
            callback: () => plugin.activateView(VIEW_TYPE_QUERY_DESIGN),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_QUERY_DESIGN;
    }

    getDisplayText(): string {
        return '查询设计';
    }

    getIcon(): string {
        return 'search';
    }

    /** 渲染件在 QueryDesignPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(QueryDesignPanel);
    }
}
