/**
 * FlowPushView — 流程推送（右侧边栏阅览，不在主编辑区显现）
 *
 * 选择流程脚本 → 展示由其在时间轴上实例化的推送任务序列（按时间排序）。
 * 仅手动刷新/选择性调用（window.SeqTK.pushFlow），不做自动到点提醒。
 *
 * 逻辑与渲染分离：本文件只负责注册、数据读取与状态重算，渲染在 FlowPushPanel.tsx。
 * 数据流：pipe → 本类(重算) → SimpleStore<FlowPushState> → Panel(useStore)
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：只读一律经 **DataPipe** 门面。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { parseFlowScript } from "../../P2_Tools/Script/parser";
import { generatePushTasks } from "../../P2_Tools/Script/push";
import { FlowPushPanel, type FlowPushState } from "./FlowPushPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";

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
        return new FlowPushView(leaf, plugin.allDeps.dataPipe);
    }

    /** 打开命令（手写；侧栏面板打开于右侧） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-flow-push',
            name: '打开流程推送',
            callback: () => plugin.activateView(VIEW_TYPE_FLOW_PUSH, 'right'),
        });
    }

    /** 渲染件订阅的唯一状态源（由本类重算后写入） */
    private readonly state = new SimpleStore<FlowPushState>({
        scripts: [],
        scriptId: '',
        errors: [],
        tasks: [],
    });

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口 */
        private pipe: DataPipe,
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
            state: this.state,
            onSelect: (scriptId: string) => {
                this.scriptId = scriptId;
                this.recompute();
            },
            onRefresh: () => this.recompute(),
        });
    }

    protected onMounted(): void {
        this.recompute();
    }

    /** 当前选中的流程脚本 nodeId（空串 = 未选） */
    private scriptId = '';

    // ============================================================
    // 状态重算（数据 → 视图状态）
    // ============================================================

    private recompute(): void {
        const scripts = this.pipe
            .GET_ByKind(NODE_KIND.FLOW)
            .map(({ nodeId, data }) => ({ nodeId, desc: data.desc }));

        const next: FlowPushState = { scripts, scriptId: this.scriptId, errors: [], tasks: [] };

        if (!this.scriptId) {
            next.emptyText = '请选择流程脚本';
            this.state.set(next);
            return;
        }
        if (!this.pipe.GET_Node(this.scriptId)) {
            next.emptyText = '脚本不存在';
            this.state.set(next);
            return;
        }

        const body = this.pipe.GET_NodeBody(this.scriptId);
        const ast = parseFlowScript(body);
        if (ast.errors.length > 0) {
            next.errors = ast.errors.map((err) => `第 ${err.line} 行：${err.message}`);
            this.state.set(next);
            return;
        }

        const tasks = generatePushTasks(ast);
        if (tasks.length === 0) {
            next.emptyText = '该脚本没有可推送的任务';
            this.state.set(next);
            return;
        }

        next.tasks = tasks.map((t) => ({
            time: t.time,
            nodeType: t.nodeType,
            label: t.label,
            items: t.items.map((i) => ({ kind: i.kind, text: i.text })),
        }));
        this.state.set(next);
    }
}
