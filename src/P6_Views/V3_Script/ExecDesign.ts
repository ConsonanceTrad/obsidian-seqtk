/**
 * ExecDesignView — 执行设计 · 双栏骨架（占位）
 *
 * 未实现但需要双栏的功能口：先给出无需功能的可视化界面，
 * 后续接入功能时只需替换 ExecDesignPanel 的内容：
 * - 左栏：执行程序 / 脚本（可视化程序以脚本为事实源）
 * - 右栏：双栏编辑器（连接 Obsidian 右侧附属信息叶子窗口）
 *
 * 当前为占位说明，无数据订阅、无功能逻辑。
 * 逻辑与渲染分离：本文件只负责注册与生命周期，渲染在 ExecDesignPanel.tsx。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { VIEW_TYPE_EXEC_DESIGN } from "../V0_Common/Blank";
import { ExecDesignPanel } from "./ExecDesignPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";

@AutoView()
@AutoRegister()
export class ExecDesignView extends ReactViewBase {
    /** 面板目录条目（规划中占位） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_EXEC_DESIGN, title: '执行设计', icon: 'play', description: '可视化执行程序/执行脚本程序（脚本为事实源），提供触发式或手动式的自动程序；双栏编辑器。', category: '规则设计', placeholder: true},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): ExecDesignView {
        return new ExecDesignView(leaf);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-exec-design',
            name: '打开执行设计',
            callback: () => plugin.activateView(VIEW_TYPE_EXEC_DESIGN),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_EXEC_DESIGN;
    }

    getDisplayText(): string {
        return '执行设计';
    }

    getIcon(): string {
        return 'play';
    }

    /** 渲染件在 ExecDesignPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(ExecDesignPanel);
    }
}
