/**
 * LogView — 日志阅览
 *
 * 左栏：日志类型 × 日期；右栏：当日条目（最新在上）+ 搜索。
 * 数据面：RUNTIME 日志是**文件基准通道**，取数只有 `SCAN_Files` 扫盘一条路；
 * 写入面见 P5_Data/Log/LogStore（按日聚合追加），本视图只读。
 *
 * 自动刷新：订阅 `SUB_FileChange`（事件源对日志文件的变化通知），
 * 日志一落盘视图即刷新，无需手动重扫。
 *
 * 逻辑与渲染分离：本文件（逻辑）管扫盘、选择态与状态重算，渲染在 LogPanel.tsx；
 * 状态构建的纯函数在 Slice/buildState.ts。数据流：
 * SCAN_Files → 本类(重算) → SimpleStore<LogViewState> → Panel(useStore)
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { VIEW_TYPE_LOG } from "../../../Special/Blank/Blank";
import { LogPanel } from "./LogPanel";
import { BUILD_LogState, LOG_KINDS, type LogSelection, type LogViewState } from "../Slice/buildState";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { WorkspaceLeaf } from "obsidian";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { NodeRuntimeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";

@AutoView()
@AutoRegister()
export class LogView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {
            viewType: VIEW_TYPE_LOG,
            title: '日志阅览',
            icon: 'scroll-text',
            description: '阅览和搜索日志：用户行为、流程推送与机器运行的流水记录。',
            category: '节点通用',
        },
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): LogView {
        return new LogView(leaf, plugin.allDeps.dataPipe);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-log',
            name: '打开日志阅览',
            callback: () => plugin.activateView(VIEW_TYPE_LOG),
        });
    }

    /** 渲染件订阅的唯一状态源（由本类重算后写入） */
    private readonly state = new SimpleStore<LogViewState>({
        groups: [],
        selectedKind: '',
        selectedDate: '',
        entries: [],
        search: '',
        emptyText: '暂无日志',
    });

    /** 选择态（buildState 的输入；缺省自动落位到最新） */
    private sel: LogSelection = { kind: '', date: '', search: '' };

    /** 文件变化退订 */
    private unsubFileChange: (() => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口 */
        private pipe: DataPipe,
    ) {
        super(leaf);
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
        return createElement(LogPanel, {
            state: this.state,
            onSelectKind: (kind: NodeRuntimeKindValue) => {
                // 换类型即回到该类型的最新一天
                this.sel = { ...this.sel, kind, date: '' };
                void this.recompute();
            },
            onSelectDate: (date: string) => {
                this.sel = { ...this.sel, date };
                void this.recompute();
            },
            onSearch: (search: string) => {
                this.sel = { ...this.sel, search };
                void this.recompute();
            },
            onRefresh: () => void this.recompute(),
        });
    }

    protected onMounted(): void {
        this.unsubFileChange = this.pipe.SUB_FileChange(() => void this.recompute());
        void this.recompute();
    }

    protected onBeforeUnmount(): void {
        this.unsubFileChange?.();
        this.unsubFileChange = null;
    }

    /** 状态重算（数据 → 视图状态） */
    private async recompute(): Promise<void> {
        let files: Awaited<ReturnType<DataPipe['SCAN_Files']>> = [];
        try {
            files = await this.pipe.SCAN_Files(LOG_KINDS);
        } catch (e) {
            console.error('[SeqTK] 扫描日志失败:', e);
        }
        const next = BUILD_LogState(files, this.sel);
        // 缺省选择被自动补位后回填，保持后续筛选稳定
        this.sel = { ...this.sel, kind: next.selectedKind || this.sel.kind, date: next.selectedDate || this.sel.date };
        this.state.set(next);
    }
}
