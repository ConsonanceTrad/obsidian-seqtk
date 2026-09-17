/**
 * LogView — 日志阅览 · 双栏骨架（占位）
 *
 * 基于 P7_Render 的 DualPane 结构：条目化的阅览和搜索日志；
 * 定义部分日志是否需要缓存，以及如何被脚本或自动化获取调用。
 * - 左栏：日志分类（分类来源 / 缓存策略）
 * - 右栏：日志条目（阅览搜索 / 自动化获取）
 *
 * 逻辑与渲染分离：本文件只负责注册、生命周期与状态，渲染在 LogPanel.tsx。
 * 后续接入功能时替换 LogPanel 内容即可；当前无功能、无订阅。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { VIEW_TYPE_LOG } from "../Special/Blank/Blank";
import { LogPanel } from "./LogPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";

@AutoView()
@AutoRegister()
export class LogView extends ReactViewBase {
    /** 面板目录条目（规划中占位） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_LOG, title: '日志阅览', icon: 'scroll-text', description: '阅览和搜索日志，管理日志可见权限。', category: '节点通用', placeholder: true},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): LogView {
        return new LogView(leaf);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-log',
            name: '打开日志阅览',
            callback: () => plugin.activateView(VIEW_TYPE_LOG),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_LOG;
    }

    getDisplayText(): string {
        return '日志阅览';
    }

    getIcon(): string {
        return 'scroll-text';
    }

    /** 渲染件在 LogPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(LogPanel);
    }
}
