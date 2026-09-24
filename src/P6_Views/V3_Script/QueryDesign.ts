/**
 * QueryDesignView — 查询设计 · 直接写 SQL
 *
 * 左栏写 SQL 打 SQLite（`nodes` / `relations` 两张表），右栏看原始结果。
 *
 * 为什么是「直接写 SQL」而不是条件表单：要查的东西同时覆盖**节点自身**与**关系**两面，
 * 条件表单会很快长成一门半吊子的查询语言；而表就两张、字段是稳定的 ——
 * 与其发明一门语言，不如把已有的那门（SQL）交出去。
 *
 * ## 只读
 *
 * 语句必须以 `SELECT` / `WITH` 开头，写操作在 `SqliteCache.QUERY_Raw` 的闸门处被拒。
 * MD 文件才是事实来源，db 会被全量重建抹掉；放行写会造成「db 改了、文件没改」，
 * 下次重建又把改动抹回去 —— 那种不一致最难排查。
 *
 * ## 结果主要给执行侧
 *
 * 界面上那张表是**附带**的。真正的产物是 `QUERY_Sql` 返回的 `RawQueryResult`
 * （`{ columns, rows, truncated }`）—— 执行设计将来要的就是这份形状。
 * 目前 `ExecDesign` 还是占位，所以这里**只保证形状稳定**，不猜它的接口：
 * 等它成形时，它调 `pipe.QUERY_Sql` 即可，本文件不必改。
 *
 * 逻辑与渲染分离：本文件管执行与状态，渲染在 QueryDesignPanel.tsx。
 */

import { createElement, type ReactNode } from "react";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { VIEW_TYPE_QUERY_DESIGN } from "../Special/Blank/Blank";
import { QueryDesignPanel, type QueryDesignState } from "./QueryDesignPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { WorkspaceLeaf } from "obsidian";
import type { RawQueryResult } from "../../P5_Data/SQLite/Cache/SqliteCache";
import type { Unsubscriber } from "../../P5_Data/Svelte/SimpleStore";

/** 结果行数上限：再多界面也看不过来，而且会把表格 DOM 撑爆 */
const ROW_LIMIT = 500;

/** 起始语句：给一个能直接跑出东西的例子，比空白框有用 */
const STARTER_SQL = 'SELECT id, kind, desc, created_at FROM nodes ORDER BY created_at DESC LIMIT 50';

@AutoView()
@AutoRegister()
export class QueryDesignView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_QUERY_DESIGN, title: '查询设计', icon: 'search', description: '直接写 SQL 查 nodes / relations 两张表（只读），结果可被执行侧取用。', category: '规则设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): QueryDesignView {
        return new QueryDesignView(leaf, plugin.allDeps.dataPipe);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-query-design',
            name: '打开查询设计',
            callback: () => plugin.activateView(VIEW_TYPE_QUERY_DESIGN),
        });
    }

    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<QueryDesignState>({
        sql: STARTER_SQL,
        columns: [],
        rows: [],
        truncated: false,
        error: '',
        ranAt: '',
        busy: false,
        ready: false,
    });

    private unsub: Unsubscriber | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口（只读 SQL 的出口） */
        private pipe: DataPipe,
    ) {
        super(leaf);
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
        return createElement(QueryDesignPanel, {
            state: this.state,
            onSqlChange: (sql: string) => this.patch({ sql }),
            onRun: () => this.RUN_Query(),
            onReset: () => this.patch({ sql: STARTER_SQL }),
        });
    }

    protected onMounted(): void {
        // 缓存就绪状态变化时刷新「能不能执行」——加载持久化缓存与对账完成是两个时刻，
        // 都可能发生在视图已经打开之后
        this.SYNC_Ready();
        this.unsub = this.pipe.SUB_ActiveView(() => this.SYNC_Ready());
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
    }

    /** 只改需要改的字段，其余原样带过（SimpleStore 是整体替换语义） */
    private patch(next: Partial<QueryDesignState>): void {
        this.state.set({ ...this.state.get(), ...next });
    }

    /** 同步「缓存是否就绪」到状态里 */
    private SYNC_Ready(): void {
        const ready = this.pipe.isInitialized;
        if (ready !== this.state.get().ready) this.patch({ ready });
    }

    /**
     * 执行查询
     *
     * 错误**原文**落到状态里显示 —— SQL 的报错信息本身就是最准确的诊断，
     * 吞掉或改写成「查询失败」只会让人更没法修。
     */
    private RUN_Query(): void {
        const sql = this.state.get().sql.trim();
        if (!sql) {
            this.patch({ error: '语句为空', columns: [], rows: [], truncated: false, ranAt: '' });
            return;
        }
        this.patch({ busy: true, error: '' });
        try {
            const r: RawQueryResult = this.pipe.QUERY_Sql(sql, [], ROW_LIMIT);
            const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            this.patch({
                busy: false,
                columns: r.columns,
                rows: r.rows,
                truncated: r.truncated,
                ranAt: `已执行 ${now}`,
                error: '',
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.patch({ busy: false, columns: [], rows: [], truncated: false, ranAt: '', error: msg });
        }
    }
}
