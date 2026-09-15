/**
 * RecycleView — 节点通用 · 回收模式
 *
 * 展示归档节点（open: false，来自弃置缓存），提供还原与彻底删除：
 * - 还原：置 open: true，节点回到活跃缓存，恢复可编辑
 * - 彻底删除：级联删除整个子树（含归档后代），文件移入系统回收站
 *
 * 归档语义（doc/可视化操作口/操作口目录.md）：
 * 归档节点不再被其他模式视图编辑、不在快速缓存中创建，但仍可用于
 * 其他视图（如线路）的信息判断。
 *
 * 逻辑与渲染分离：
 * - 本文件（逻辑）：订阅弃置缓存、重算视图状态、提供操作，不写 JSX；
 * - RecyclePanel.tsx（渲染）：订阅视图状态 store、渲染、把操作回调上抛。
 * 数据流：pipe.SUB_ArchiveView → 本类(重算) → stateStore → Panel(useStore)
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：读写一律经 **DataPipe**，不再直连
 * nodeCache / fileManager / operationQueue。回收视图是弃置缓存的唯一消费者，
 * 打开时以 `ARCHIVE_Refresh` 做一次全量更新。
 */

import { createElement, type ReactNode } from "react";
import { Notice, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { RecyclePanel, type RecycleGroup, type RecycleRow, type RecycleState } from "./RecyclePanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";

export const VIEW_TYPE_RECYCLE = 'seqtk-recycle';

@AutoView()
@AutoRegister()
export class RecycleView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_RECYCLE, title: '回收模式', icon: 'trash-2', description: '阅览归档节点，提供还原与彻底删除。', category: '节点通用'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): RecycleView {
        return new RecycleView(leaf, plugin.allDeps.dataPipe);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-recycle',
            name: '打开回收模式',
            callback: () => plugin.activateView(VIEW_TYPE_RECYCLE),
        });
    }

    /** 渲染件订阅的唯一状态源（由本类重算后写入） */
    private readonly state = new SimpleStore<RecycleState>({
        initializing: true,
        groups: [],
        total: 0,
    });

    private unsub: (() => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口 */
        private pipe: DataPipe,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_RECYCLE;
    }

    getDisplayText(): string {
        return '回收模式';
    }

    getIcon(): string {
        return 'trash-2';
    }

    /** 渲染件在 RecyclePanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(RecyclePanel, {
            state: this.state,
            onRestore: (nodeId: string, kind: NodeKindValue) => this.restore(nodeId, kind),
            onDelete: (nodeId: string) => this.deleteTree(nodeId),
            onRefresh: () => void this.refresh(),
        });
    }

    protected onMounted(): void {
        this.unsub = this.pipe.SUB_ArchiveView(() => this.recompute());
        // 弃置缓存全量更新（回收视图打开时一次即可）；完成后重算一次状态
        void this.pipe.ARCHIVE_Refresh().then(() => this.recompute()).catch((err) => {
            console.warn('[SeqTK] 弃置缓存刷新失败:', err);
            this.recompute();
        });
        this.recompute();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
    }

    // ============================================================
    // 状态重算（数据 → 视图状态）
    // ============================================================

    private recompute(): void {
        const byKind = new Map<NodeKindValue, RecycleRow[]>();
        for (const { nodeId, data } of this.pipe.GET_AllNodesArchive()) {
            const list = byKind.get(data.kind) ?? [];
            list.push({ nodeId, kind: data.kind, desc: data.desc });
            byKind.set(data.kind, list);
        }
        const groups: RecycleGroup[] = [...byKind].map(([kind, items]) => ({
            kind,
            label: NODE_KIND_LABELS[kind],
            items,
        }));
        this.state.set({
            initializing: !this.pipe.archiveReady,
            groups,
            total: groups.reduce((n, g) => n + g.items.length, 0),
        });
    }

    // ============================================================
    // 操作
    // ============================================================

    /** 还原：置 open: true，节点回到活跃缓存 */
    private restore(nodeId: string, kind: NodeKindValue): void {
        this.pipe.EXEC_Mutation({
            op: 'update',
            kind,
            nodeId,
            updates: { open: true, modify: new Date().toISOString() },
        });
        new Notice('已还原');
    }

    /** 彻底删除：级联删除子树（含归档后代），文件移入系统回收站 */
    private deleteTree(rootNodeId: string): void {
        const targets: { kind: NodeKindValue; nodeId: string }[] = this.pipe
            .COLLECT_DescendantsArchive(rootNodeId)
            .map((d) => ({ kind: d.kind, nodeId: d.nodeId }));

        const rootKind = this.pipe.GET_NodeArchive(rootNodeId)?.kind;
        if (rootKind) targets.push({ kind: rootKind, nodeId: rootNodeId });

        this.pipe.EXEC_RemoveMany(targets);

        new Notice(`已彻底删除 ${targets.length} 个节点`);
    }

    /** 从磁盘刷新：对账活跃缓存 + 重灌弃置缓存 */
    private async refresh(): Promise<void> {
        if (!this.pipe.isInitialized) {
            new Notice('查询缓存尚未就绪，请稍候');
            return;
        }
        await this.pipe.SYNC_FromFiles();
        await this.pipe.ARCHIVE_Refresh();
        this.recompute();
        new Notice('已从磁盘刷新');
    }
}
