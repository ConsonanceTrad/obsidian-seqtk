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
import type { NodeFile } from "../../P4_Nodes/Node";

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
                void this.recompute();
            },
            onRefresh: () => void this.recompute(),
        });
    }

    protected onMounted(): void {
        void this.recompute();
    }

    /** 当前选中的流程脚本 nodeId（空串 = 未选） */
    private scriptId = '';

    // ============================================================
    // 状态重算（数据 → 视图状态）
    // ============================================================

    /**
     * 状态重算（数据 → 视图状态）
     *
     * 流程脚本走**文件基准通道**：列表与正文都只能靠扫盘拿到。
     * 此前这里用 `GET_ByKind` / `GET_Node` / `GET_NodeBody` —— 那三个都是缓存接口，
     * 对脚本恒为空，于是下拉永远空着、选中也读不出正文。一次扫描把三样一起解决。
     */
    private async recompute(): Promise<void> {
        let files: NodeFile[] = [];
        try {
            files = await this.pipe.SCAN_Files([NODE_KIND.FLOW]);
        } catch (e) {
            console.error('[SeqTK] 扫描流程脚本失败:', e);
        }
        const scripts = files.map((f) => ({ nodeId: f.nodeId, desc: f.data.desc }));

        const next: FlowPushState = { scripts, scriptId: this.scriptId, errors: [], tasks: [] };

        if (!this.scriptId) {
            next.emptyText = '请选择流程脚本';
            this.state.set(next);
            return;
        }
        const picked = files.find((f) => f.nodeId === this.scriptId);
        if (!picked) {
            next.emptyText = '脚本不存在';
            this.state.set(next);
            return;
        }

        const ast = parseFlowScript(picked.body);
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

        next.tasks = tasks;
        this.state.set(next);
    }
}
