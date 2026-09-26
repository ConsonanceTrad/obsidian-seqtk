/**
 * QueryDesignView — 查询设计
 *
 * 左栏：查询脚本树（SCRIPT_QUERY，parent 归属分组；分组徽章显示「分组」）。
 * 右栏：SQL 输入 + 语法检查（试编译）；执行走按钮，结果在模态框里看。
 *
 * 数据面：脚本是**文件基准通道**（不进缓存），列表靠 SCAN_Files 异步拉，
 * SQL 落脚本节点正文（EXEC_Mutation setBody）。执行的产物是 `pipe.QUERY_Sql` 的
 * `RawQueryResult` —— 执行设计将来要的就是这份形状，本文件只保证形状稳定。
 *
 * 双栏与委托：复用统一框架（usePaneResize 把手 + 宽度记忆 + 左栏委托到中控台/独立视图），
 * 与设计 / 模板 / 流程设计同一套交互。
 *
 * 逻辑与渲染分离：本文件管数据与动作，渲染在 QueryDesignPanel.tsx；
 * 树状态与委托来源在 Slice/queryTreeShared.ts。
 */

import { createElement, type ReactNode } from "react";
import { Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { VIEW_TYPE_QUERY_DESIGN } from "../../../Special/Blank/Blank";
import { NODE_KIND, type NodeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import { BUILD_ScriptTree, SCRIPT_GROUP_LABEL } from "../../../../P2_Tools/Script/scriptTree";
import { GET_FileByPath } from "../../../../P5_Data/MdFile/PathTools/PathParse";
import { DELEGATE } from "../../../Special/Delegate/DelegateRegistry";
import { START_Delegate } from "../../../Special/Delegate/delegateTargets";
import { SET_RowMenu } from "../../../Special/Delegate/rowMenuRegistry";
import { QueryDesignPanel, type QueryDesignState } from "./QueryDesignPanel";
import { QUERY_TREE, QUERY_DELEGATE, type QueryScriptItem } from "../Slice/queryTreeShared";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../../../P3_Settings/Settings";
import type { RawQueryResult } from "../../../../P5_Data/SQLite/Cache/SqliteCache";
import type { Unsubscriber } from "../../../../P5_Data/Svelte/SimpleStore";
import type { SeqtkNode } from "../../../../P4_Nodes/Node";
import type { TreeNodeItem } from "../../../../P7_Render/Composition/C2_Tree/NodeTree";

/** 结果行数上限：再多界面也看不过来，而且会把表格 DOM 撑爆 */
const ROW_LIMIT = 500;

/** 新脚本的起步 SQL：给一个能直接跑出东西的例子，比空白框有用 */
const STARTER_SQL = 'SELECT id, kind, desc, created_at FROM nodes ORDER BY created_at DESC LIMIT 50';

const EMPTY_STATE: QueryDesignState = {
    items: [],
    leftItems: [],
    scriptId: '',
    scriptDesc: '',
    sql: '',
    checkError: null,
    checked: false,
    result: null,
    resultOpen: false,
    runError: '',
    busy: false,
    ready: false,
    delegated: false,
    leftPaneWidth: 0,
};

@AutoView()
@AutoRegister()
export class QueryDesignView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {
            viewType: VIEW_TYPE_QUERY_DESIGN,
            title: '查询设计',
            icon: 'search',
            description: '查询脚本的编写与管理：左栏脚本树（可分组），右栏写 SQL 与语法检查，执行结果在模态框查看。',
            category: '规则设计',
        },
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): QueryDesignView {
        return new QueryDesignView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
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
    private readonly state = new SimpleStore<QueryDesignState>(EMPTY_STATE);

    private unsubTree: Unsubscriber | null = null;
    private unsubCache: Unsubscriber | null = null;
    /** 文件基准变化（归档 / 删除 / 改名后补发的广播）→ 重拉脚本列表 */
    private unsubFiles: Unsubscriber | null = null;
    /** SQL 修改未落盘标记（切换脚本前先存） */
    private dirty = false;

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口 */
        private pipe: DataPipe,
        private settings: PluginSettings,
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
            actions: {
                select: (nodeId) => this.SELECT(nodeId),
                toggle: (nodeId) => this.TOGGLE(nodeId),
                contextMenu: (nodeId, e) => this.SHOW_RowMenu(nodeId, e),
                blankContextMenu: (e) => this.SHOW_BlankMenu(e),
                sqlChange: (sql) => {
                    this.dirty = true;
                    this.patch({ sql, checkError: null, checked: false });
                },
                save: () => void this.SAVE_Sql(),
                check: () => this.CHECK_Sql(),
                run: () => void this.RUN_Sql(),
                closeResult: () => this.patch({ resultOpen: false }),
                toggleDelegate: () => this.TOGGLE_Delegate(),
                setLeftWidth: (w) => this.SET_LeftWidth(w),
            },
            host: { setTooltip, setIcon },
        });
    }

    protected onMounted(): void {
        // 本视图在场时登记行菜单（委托面板的行右键与左栏同一套）与来源 viewType
        SET_RowMenu('query', (ctx, e) => this.SHOW_RowMenu(ctx.nodeId, e));
        QUERY_DELEGATE.viewType = VIEW_TYPE_QUERY_DESIGN;
        QUERY_TREE.SET_PendingDelegated(this.settings.delegatedOwner === 'query' && !DELEGATE.settled);
        this.unsubTree = QUERY_TREE.store.subscribe(() => this.SYNC_Tree());
        this.unsubCache = this.pipe.SUB_ActiveView(() => this.SYNC_Ready());
        // 归档 / 删除走 EXEC_Mutation，自触发事件被抑制 —— 事件源补发的广播在这里接
        this.unsubFiles = this.pipe.SUB_FileChange((kind) => {
            if (kind === NODE_KIND.QUERY) void this.LOAD_Scripts();
        });
        void this.LOAD_Scripts();
        this.SYNC_Tree();
        this.SYNC_Ready();
    }

    protected onBeforeUnmount(): void {
        SET_RowMenu('query', null);
        this.unsubTree?.();
        this.unsubTree = null;
        this.unsubCache?.();
        this.unsubCache = null;
        this.unsubFiles?.();
        this.unsubFiles = null;
    }

    // ============================================================
    // 数据装载与状态同步
    // ============================================================

    /** 拉取全部查询脚本（文件基准通道唯一的取数路） */
    private async LOAD_Scripts(): Promise<void> {
        let files: Awaited<ReturnType<DataPipe['SCAN_Files']>> = [];
        try {
            files = await this.pipe.SCAN_Files([NODE_KIND.QUERY]);
        } catch (e) {
            console.error('[SeqTK] 扫描查询脚本失败:', e);
        }
        const items: QueryScriptItem[] = files.map((f) => ({
            nodeId: f.nodeId,
            kind: f.data.kind,
            desc: f.data.desc,
            parent: (f.data as { parent?: string }).parent ?? '',
        }));
        QUERY_TREE.SET_Items(items);
    }

    /** 树快照 → 视图状态（左栏 items 与委托同源） */
    private SYNC_Tree(): void {
        const tree = BUILD_ScriptTree(QUERY_TREE.items);
        // 选中项没了（被归档 / 删除）就清选中，右栏一并还原
        const sel = QUERY_TREE.selectedId;
        if (sel && !this.FLATTEN(tree).some((n) => n.nodeId === sel)) {
            QUERY_TREE.selectedId = null;
            this.dirty = false;
            this.patch({ scriptId: '', scriptDesc: '', sql: '', checkError: null, checked: false });
        }
        this.patch({
            items: QUERY_TREE.items,
            delegated: QUERY_TREE.delegated,
            leftItems: this.BUILD_LeftItems(tree),
        });
    }

    private FLATTEN(tree: ReturnType<typeof BUILD_ScriptTree>): ReturnType<typeof BUILD_ScriptTree> {
        return tree.flatMap((n) => [n, ...this.FLATTEN(n.children)]);
    }

    /** 脚本树 → 左栏行（分组徽章显示「分组」） */
    private BUILD_LeftItems(tree: ReturnType<typeof BUILD_ScriptTree>): TreeNodeItem[] {
        const walk = (nodes: ReturnType<typeof BUILD_ScriptTree>, parentId: string, depth: number): TreeNodeItem[] =>
            nodes.map((n) => ({
                line: {
                    nodeId: n.nodeId,
                    parentId,
                    depth,
                    kind: n.kind as NodeKindValue,
                    category: 'SCRIPT',
                    label: n.isGroup ? SCRIPT_GROUP_LABEL : (NODE_KIND_LABELS[n.kind as NodeKindValue] ?? n.kind),
                    desc: n.desc,
                    hasChildren: n.children.length > 0,
                    expanded: QUERY_TREE.expanded.has(n.nodeId),
                    inExpandedTree: depth > 0,
                    selected: QUERY_TREE.selectedId === n.nodeId,
                    showsOpenButton: true,
                },
                children: walk(n.children, n.nodeId, depth + 1),
            }));
        return walk(tree, '', 0);
    }

    private SYNC_Ready(): void {
        const ready = this.pipe.isInitialized;
        if (ready !== this.state.get().ready) this.patch({ ready });
    }

    private patch(next: Partial<QueryDesignState>): void {
        this.state.set({ ...this.state.get(), ...next });
    }

    // ============================================================
    // 树动作
    // ============================================================

    /** 选中：分组只做展开/收起（分类目录不承载 SQL），叶子载入 SQL */
    private SELECT(nodeId: string): void {
        const node = this.FLATTEN(BUILD_ScriptTree(QUERY_TREE.items)).find((n) => n.nodeId === nodeId);
        if (!node) return;
        if (node.isGroup) {
            this.TOGGLE(nodeId);
            return;
        }
        // 重复点同一脚本不重载：保存走防抖写盘，紧接着读文件会读回未落盘的旧正文，
        // 把用户的编辑冲掉。切到别的脚本是两个文件，互不干扰。
        if (nodeId === this.state.get().scriptId) return;
        void this.SAVE_Sql(); // 切走前把没存的存上
        QUERY_TREE.selectedId = nodeId;
        void this.LOAD_Sql(nodeId);
    }

    private TOGGLE(nodeId: string): void {
        const exp = QUERY_TREE.expanded;
        if (exp.has(nodeId)) exp.delete(nodeId);
        else exp.add(nodeId);
        QUERY_TREE.markExpandedChanged();
    }

    /** 载入选中脚本的 SQL */
    private async LOAD_Sql(nodeId: string): Promise<void> {
        const file = await this.pipe.READ_FileView(NODE_KIND.QUERY, nodeId);
        this.patch({
            scriptId: nodeId,
            scriptDesc: QUERY_TREE.items.find((i) => i.nodeId === nodeId)?.desc ?? '',
            sql: file?.body ?? '',
            checkError: null,
            checked: false,
        });
        this.dirty = false;
    }

    /** 保存当前 SQL 到脚本节点正文 */
    private async SAVE_Sql(): Promise<void> {
        const s = this.state.get();
        if (!s.scriptId || !this.dirty) return;
        this.pipe.EXEC_Mutation({ op: 'setBody', kind: NODE_KIND.QUERY, nodeId: s.scriptId, body: s.sql });
        await this.pipe.FLUSH();
        this.dirty = false;
    }

    // ============================================================
    // SQL：语法检查与执行
    // ============================================================

    /** 语法检查（试编译不执行） */
    private CHECK_Sql(): void {
        const s = this.state.get();
        const err = this.pipe.CHECK_Sql(s.sql);
        this.patch({ checkError: err, checked: true });
    }

    /** 执行：保存 → 检查 → 跑 → 结果进模态框 */
    private async RUN_Sql(): Promise<void> {
        await this.SAVE_Sql();
        const s = this.state.get();
        const err = this.pipe.CHECK_Sql(s.sql);
        if (err) {
            this.patch({ checkError: err, checked: true });
            new Notice('SQL 有语法问题，先修好再执行');
            return;
        }
        if (!this.pipe.isInitialized) {
            new Notice('查询缓存尚未就绪，稍候再执行');
            return;
        }
        this.patch({ busy: true });
        try {
            const result: RawQueryResult = this.pipe.QUERY_Sql(s.sql, [], ROW_LIMIT);
            this.patch({ result, resultOpen: true, runError: '', busy: false });
        } catch (e) {
            this.patch({
                runError: e instanceof Error ? e.message : String(e),
                result: null,
                resultOpen: true,
                busy: false,
            });
        }
    }

    // ============================================================
    // 行菜单 / 空白菜单 / 委托 / 宽度
    // ============================================================

    /** 行右键：分组只给结构类动作；脚本实体多给「执行查询 / 打开文件」 */
    private SHOW_RowMenu(nodeId: string, e: MouseEvent): void {
        const node = this.FLATTEN(BUILD_ScriptTree(QUERY_TREE.items)).find((n) => n.nodeId === nodeId);
        if (!node) return;
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('新建子查询脚本').setIcon('folder-plus')
            .onClick(() => this.CREATE_Script(nodeId)));
        if (!node.isGroup) {
            menu.addItem((item) => item.setTitle('执行查询').setIcon('play')
                .onClick(() => {
                    QUERY_TREE.selectedId = nodeId;
                    void this.LOAD_Sql(nodeId).then(() => this.RUN_Sql());
                }));
            menu.addItem((item) => item.setTitle('打开文件').setIcon('file-text')
                .onClick(() => this.OPEN_File(nodeId)));
        }
        menu.addItem((item) => item.setTitle('重命名').setIcon('pencil')
            .onClick(() => this.RENAME_Script(nodeId)));
        menu.addItem((item) => item.setTitle('归档').setIcon('archive')
            .onClick(() => {
                this.pipe.EXEC_Mutation({
                    op: 'update',
                    kind: NODE_KIND.QUERY,
                    nodeId,
                    updates: { open: false, modify: new Date().toISOString() },
                });
                void this.LOAD_Scripts();
            }));
        menu.showAtMouseEvent(e);
    }

    /** 空白右键：新建根级脚本 */
    private SHOW_BlankMenu(e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('新建查询脚本').setIcon('plus')
            .onClick(() => this.CREATE_Script('')));
        menu.showAtMouseEvent(e);
    }

    /** 新建查询脚本（在 parentId 下；空 = 根级） */
    private CREATE_Script(parentId: string): void {
        const name = window.prompt('查询脚本名称', '新查询');
        if (!name) return;
        void (async () => {
            const now = new Date().toISOString();
            const data = {
                kind: NODE_KIND.QUERY,
                desc: name,
                open: true,
                create: now,
                modify: now,
                ...(parentId ? { parent: parentId } : {}),
            } as SeqtkNode;
            const nodeId = await this.pipe.EXEC_Create({ kind: NODE_KIND.QUERY, data, body: STARTER_SQL });
            if (parentId) {
                QUERY_TREE.expanded.add(parentId);
                QUERY_TREE.markExpandedChanged();
            }
            await this.LOAD_Scripts();
            QUERY_TREE.selectedId = nodeId;
            void this.LOAD_Sql(nodeId);
        })();
    }

    private RENAME_Script(nodeId: string): void {
        const cur = QUERY_TREE.items.find((i) => i.nodeId === nodeId)?.desc ?? '';
        const name = window.prompt('新名称', cur);
        if (!name || name === cur) return;
        this.pipe.EXEC_Mutation({
            op: 'update',
            kind: NODE_KIND.QUERY,
            nodeId,
            updates: { desc: name, modify: new Date().toISOString() },
        });
        void this.LOAD_Scripts().then(() => {
            if (this.state.get().scriptId === nodeId) this.patch({ scriptDesc: name });
        });
    }

    private OPEN_File(nodeId: string): void {
        const filePath = GET_FileByPath(NODE_KIND.QUERY, nodeId, this.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }

    /** 委托开关：已委托就收回，否则委托出去（落点按设置） */
    private TOGGLE_Delegate(): void {
        if (QUERY_TREE.delegated) DELEGATE.release('query');
        else START_Delegate(this.app, this.settings, 'query');
    }

    /** 左栏宽度（拖动结束后一次上报；由设置持久化） */
    private SET_LeftWidth(width: number): void {
        this.patch({ leftPaneWidth: width });
        this.settings.queryLeftPaneWidth = width;
    }
}
