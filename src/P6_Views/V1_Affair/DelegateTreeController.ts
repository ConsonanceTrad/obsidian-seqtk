/**
 * DelegateTreeController — 委托框架树的状态装配（共用件）
 *
 * 「委托」有两个落点，由设置项 delegateTarget 决定：
 *   - 'hub'  借用中控台侧栏容器（默认）—— 框架树作为一节渲染在 HubView 里
 *   - 'view' 独立视图 seqtk-delegated-tree
 *
 * 两个落点渲染的是同一棵树、同一份状态，所以状态构建与动作只写一份，放在这里；
 * 视图类只负责把 renderPanel() 的结果挂到自己的容器上。
 *
 * 右键只开三项：新建子框架 / 重命名 / 归档 —— 都作用于**框架树本身**，不依赖设计视图
 * 右栏的上下文（当前选中框架、正文编辑、状态传播……）。它们复用 design/actions 的同一套
 * 实现（见那里的 NodeEditHost），所以多一个入口不会长出第二套行为。
 * 更重的编辑仍留在设计视图：两个入口同时改同一棵树，会让「谁在编辑」变得难以预期。
 */

import { App, setIcon, setTooltip } from 'obsidian';
import { SimpleStore } from '../../P5_Data/Svelte/SimpleStore';
import { BUILD_Menu, type MenuDefinition } from '../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import { ICON, SECTION } from '../../P7_Render/Composition/C3_RightClickMenu/MenuAppearance';
import {
    DelegatedTreePanel,
    type DelegatedTreeActions,
    type DelegatedTreeState,
} from './DelegatedTreePanel';
import { FRAMEWORK_TREE } from './Design/Slice/FrameworkTreeShared';
import { buildFrameworkTree } from './Design/Tool/tree';
import { buildFrameLine, buildTreeItems, type LineOverlay } from './Design/Tool/viewModel';
import { archiveNode, createNode, saveNodeDesc, type NodeEditHost } from './Design/Slice/actions';
import { NODE_KIND } from '../../P4_Nodes/NodeFacade';
import type { DataPipe } from '../../P5_Data/CoPipe/DataPipe';
import type { PluginSettings } from '../../P3_Settings/Settings';
import type { NodeLineCtx } from '../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { NodeInlineCreating } from '../../P7_Render/Composition/C2_Tree/NodeTree';
import { createElement, type ReactElement } from 'react';

export class DelegateTreeController implements NodeEditHost {
    /** 渲染件订阅的唯一状态源 */
    readonly state = new SimpleStore<DelegatedTreeState>({
        items: [],
        selectedId: null,
        creating: null,
        editingNodeId: null,
    });

    private unsub: (() => void) | null = null;
    private unsubData: (() => void) | null = null;

    /** 行内新建态（右键「新建子框架」写入） */
    private creating: NodeInlineCreating | null = null;
    /** 正在行内重命名的节点 id（写入行覆盖信息，由行组件渲染覆盖层） */
    private editingNodeId: string | null = null;
    /** 本控制器不区分左右栏：满足 NodeEditHost 用的占位集合（新建一律按左栏展开） */
    private readonly rightExpanded = new Set<string>();

    constructor(
        /** 归档确认等模态框需要；与 hub / 独立视图共用同一份能力 */
        public app: App,
        public pipe: DataPipe,
        public settings: PluginSettings,
        /** 取消委托时的回调（两个落点的收尾不同：独立视图要关自己，Hub 只是不再显示这一节） */
        private onCancel: () => void,
    ) {}

    // ── NodeEditHost：让 design/actions 的动作能在委托树里直接复用 ──

    get expandedLeft(): Set<string> {
        return FRAMEWORK_TREE.expandedLeft;
    }

    get expandedRight(): Set<string> {
        return this.rightExpanded;
    }

    renderLeft(): void {
        this.recompute();
    }

    renderRight(): void {
        this.recompute();
    }

    /** 挂上订阅并首算；重复调用无副作用 */
    start(): void {
        if (this.unsub) return;
        // 本面板存在本身就是「已委托」的证据：工作区恢复出的面板不会经过打开命令，
        // 内存里的开关还是 false，这里补上，设计视图左栏才会显示成「已委托」。
        FRAMEWORK_TREE.delegated = true;
        // 共享状态（展开 / 选中，本面板或设计视图发起）→ 重算
        this.unsub = FRAMEWORK_TREE.store.subscribe(() => this.recompute());
        // 活跃缓存（节点新建 / 改名 / 删除）→ 重算；两者分工不同，都要订阅
        this.unsubData = this.pipe.SUB_ActiveView(() => this.recompute());
        this.recompute();
    }

    stop(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubData?.();
        this.unsubData = null;
    }

    /** 待渲染的 React 树（两个落点共用同一份装配） */
    render(): ReactElement {
        return createElement(DelegatedTreePanel, {
            store: this.state,
            actions: {
                onToggle: (ctx) => this.toggleExpand(ctx),
                onSelect: (ctx) => { FRAMEWORK_TREE.selectedId = ctx.nodeId; },
                onCancelDelegate: () => this.onCancel(),
                onContextMenu: (ctx, e) => this.showRowMenu(ctx, e),
                onCreateCommit: (parentId: string, _kind, name: string) => void this.commitCreate(parentId, name),
                onCreateCancel: () => this.cancelCreate(),
                onRepeatChange: (repeat: boolean) => this.setCreateRepeat(repeat),
                onInlineCommit: (ctx, value) => this.commitRename(ctx, value),
                onInlineCancel: () => this.cancelRename(),
            } satisfies DelegatedTreeActions,
            host: { setTooltip, setIcon },
        });
    }

    /** 行右键：只给作用于框架树本身的三项（见文件头说明） */
    private showRowMenu(ctx: NodeLineCtx, e: MouseEvent): void {
        const defs: MenuDefinition[] = [
            {
                name: '新建子框架',
                icon: ICON.newFramework,
                section: SECTION.main,
                action: () => this.startCreateChild(ctx),
            },
            {
                name: '重命名',
                icon: ICON.rename,
                section: SECTION.main,
                action: () => this.startRename(ctx.nodeId),
            },
            {
                name: '归档',
                icon: ICON.archive,
                section: SECTION.danger,
                action: () => archiveNode(this, ctx.nodeId),
            },
        ];
        BUILD_Menu(defs, e);
    }

    /** 在该框架下新建子框架：展开它并就地插一行输入（复用行的附加行组件） */
    private startCreateChild(ctx: NodeLineCtx): void {
        this.creating = {
            parentId: ctx.nodeId,
            kinds: [NODE_KIND.TRANS],
            kind: NODE_KIND.TRANS,
            depth: ctx.depth + 1,
        };
        FRAMEWORK_TREE.expandedLeft.add(ctx.nodeId);
        FRAMEWORK_TREE.markExpandedChanged();
        this.recompute();
    }

    private cancelCreate(): void {
        this.creating = null;
        this.recompute();
    }

    /** 切换「连续输入」：提交后保留附加行，便于连续录入多个子框架 */
    private setCreateRepeat(repeat: boolean): void {
        if (!this.creating) return;
        this.creating = { ...this.creating, repeat };
        this.recompute();
    }

    private async commitCreate(parentId: string, name: string): Promise<void> {
        const prev = this.creating;
        // 与设计视图同一套处理：写盘期间压掉重算，数据一到就「附加行原地变新行」，
        // 中途不让缓存订阅插进来多刷一次（那一次会同时画出输入行与新行）
        this.suppress = true;
        try {
            // side 固定 left：委托树就是左栏那棵树，展开也落在同一个集合上
            await createNode(
                this,
                { kind: NODE_KIND.TRANS, desc: name, state: 'plan', afterCreate: 'direct' },
                parentId,
                { skipRender: true, side: 'left' },
            );
        } finally {
            this.suppress = false;
        }
        this.creating = null;
        // 连续输入：保留附加行；seq 递增换 key，重建实例才能接受下一次输入
        if (prev?.repeat) {
            this.creating = { ...prev, repeat: true, seq: (prev.seq ?? 0) + 1 };
        }
        this.recompute();
    }

    /** 进入行内重命名态 */
    private startRename(nodeId: string): void {
        this.editingNodeId = nodeId;
        this.recompute();
    }

    private commitRename(ctx: NodeLineCtx, value: string): void {
        const data = this.pipe.GET_Node(ctx.nodeId);
        this.editingNodeId = null;
        if (data && value && value !== data.desc) {
            saveNodeDesc(this, { nodeId: ctx.nodeId, data, children: [] }, value);
        }
        this.recompute();
    }

    private cancelRename(): void {
        this.editingNodeId = null;
        this.recompute();
    }

    /** 写盘期间的抑制位（见 commitCreate）：重算一律压掉，避免多出一次「输入行 + 新行并存」的画面 */
    private suppress = false;

    private recompute(): void {
        if (this.suppress) return;
        const expanded = FRAMEWORK_TREE.expandedLeft;
        const selectedId = FRAMEWORK_TREE.selectedId;
        const roots = buildFrameworkTree(this.pipe, this.settings.topFrameworkOrder ?? []);
        const overlayFor = (nodeId: string): LineOverlay => ({
            editing: this.editingNodeId === nodeId,
        });

        this.state.set({
            items: buildTreeItems(this.pipe, '', roots, expanded, (node, flags) =>
                buildFrameLine(this.pipe, node, flags, selectedId === node.nodeId, overlayFor(node.nodeId)),
            ),
            emptyText: roots.length === 0 ? '暂无框架，可在事务设计中新建' : undefined,
            selectedId,
            creating: this.creating,
            editingNodeId: this.editingNodeId,
        });
    }

    /** 展开/收起（共享集合，设计视图左栏会同步） */
    private toggleExpand(ctx: NodeLineCtx): void {
        const set = FRAMEWORK_TREE.expandedLeft;
        if (set.has(ctx.nodeId)) set.delete(ctx.nodeId);
        else set.add(ctx.nodeId);
        // 广播：本面板与设计视图各自重算
        FRAMEWORK_TREE.markExpandedChanged();
    }
}
