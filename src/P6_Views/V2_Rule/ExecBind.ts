/**
 * ExecBindView — 执行绑定 · 双栏骨架（占位）
 *
 * 基于 DualPane 的双栏可视化占位：将执行行为绑定到指定时间点，
 * 或绑定到某事件（节点）完成后自动触发。
 * - 左栏：绑定规则（定时触发 / 事件后触发）
 * - 右栏：规则编辑与触发记录
 *
 * 后续接入功能时只需替换 ExecBindPanel 的内容；当前无功能、无订阅。
 * 逻辑与渲染分离：本文件只负责注册与生命周期，渲染在 ExecBindPanel.tsx。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { VIEW_TYPE_EXEC_BIND } from "../V0_Common/Blank";
import { ExecBindPanel } from "./ExecBindPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";

@AutoView()
@AutoRegister()
export class ExecBindView extends ReactViewBase {
    /** 面板目录条目（规划中占位） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_EXEC_BIND, title: '执行绑定', icon: 'cable', description: '将执行行为绑定到指定时间点，或绑定到某事件（节点）完成后自动触发；绑定规则的编辑与阅览。', category: '规则设计', placeholder: true},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): ExecBindView {
        return new ExecBindView(leaf);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-exec-bind',
            name: '打开执行绑定',
            callback: () => plugin.activateView(VIEW_TYPE_EXEC_BIND),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_EXEC_BIND;
    }

    getDisplayText(): string {
        return '执行绑定';
    }

    getIcon(): string {
        return 'cable';
    }

    /** 渲染件在 ExecBindPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(ExecBindPanel);
    }
}
