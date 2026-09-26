/**
 * FlowPushView — 流程推送（右侧边栏阅览，不在主编辑区显现）
 *
 * 多流程并行：启用的流程脚本合并为**当日单流**，顶部聚焦「当前活跃项」，
 * 下方是完整当日序列（可勾选启用哪些流程参与推送）。
 *
 * 本视图只做装配与转发：重算、条件求值、到点 Notice、状态栏、完成回写
 * 全在 PushRuntime（非视图服务，由 main 启停）—— 视图打开与否推送都在跑。
 *
 * 逻辑与渲染分离：本文件（逻辑）管装配与回调转发，渲染在 FlowPushPanel.tsx。
 * 数据流：PushRuntime(重算) → SimpleStore<PushRuntimeState> → Panel(useStore)
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { FlowPushPanel } from "./FlowPushPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";
import type { PushRuntime } from "./PushRuntime";

export const VIEW_TYPE_FLOW_PUSH = 'seqtk-flow-push';

@AutoView()
@AutoRegister()
export class FlowPushView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_FLOW_PUSH, title: '流程推送', icon: 'bell', description: '根据指定流程脚本，在右侧边栏展示被推送的任务序列。', category: '规则设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): FlowPushView {
        return new FlowPushView(leaf, plugin.pushRuntime);
    }

    /** 打开命令（手写；侧栏面板打开于右侧） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-flow-push',
            name: '打开流程推送',
            callback: () => plugin.activateView(VIEW_TYPE_FLOW_PUSH, 'right'),
        });
    }

    constructor(
        leaf: WorkspaceLeaf,
        /** 推送运行时（视图只订阅其状态、转发用户动作） */
        private runtime: PushRuntime,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_FLOW_PUSH;
    }

    getDisplayText(): string {
        return '流程推送';
    }

    getIcon(): string {
        return 'bell';
    }

    /** 渲染件在 FlowPushPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(FlowPushPanel, {
            state: this.runtime.state,
            onToggleScript: (scriptId: string, enabled: boolean) => {
                this.runtime.TOGGLE_SCRIPT(scriptId, enabled);
            },
            onComplete: (nodeId: string) => {
                this.runtime.COMPLETE(nodeId);
            },
            onRefresh: () => {
                // 用户主动动作记行为日志；推送产物的流水由运行时在到点时记
                this.runtime.LOG_MANUAL_REFRESH();
                void this.runtime.RECOMPUTE();
            },
        });
    }

    protected onMounted(): void {
        void this.runtime.RECOMPUTE();
    }
}
