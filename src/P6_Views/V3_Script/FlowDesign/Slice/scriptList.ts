/**
 * flowDesign/scriptList — 左栏流程脚本列表：数据构建与行操作
 *
 * 脚本本身就是 `NODE_KIND.FLOW` 节点（正文存 flow 语法文本），所以本切片全部走 DataPipe，
 * 不直连缓存或文件管理器 —— 与其它视图的数据面口径一致。
 *
 * 切片契约（见 P6_Views/Views.md）：以 host 为第一参数、只认识 Slice/host 的接口。
 */

import { Menu, Notice } from 'obsidian';
import { GET_FileByPath } from '../../../../P5_Data/MdFile/PathTools/PathParse';
import { NODE_KIND } from '../../../../P4_Nodes/NodeKind/NodeKind';
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeKind/NodeLabel';
import { BUILD_ScriptTree, SCRIPT_GROUP_LABEL } from '../../../../P2_Tools/Script/scriptTree';
import { FLOW_TREE } from './flowTreeShared';
import type { FlowScriptItem } from './flowTreeShared';
import { TransactionCreateModal } from '../../../../P7_Render/Structure/S2_Modal/TransactionModals';
import type { FlowDesignHost } from './host';
import type { FlowScriptRow } from '../Core/FlowDesignPanel';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkNode } from '../../../../P4_Nodes/Node';

/**
 * 构建左栏行
 *
 * 数据取自 `FLOW_TREE.items` 快照，**不是** `GET_ByKind` —— 脚本属**文件基准通道**，
 * 不在活跃缓存里，查缓存只会得到空数组。快照由视图异步扫描填充
 * （见 flowTreeShared 的 FlowTreeSnapshot.items 与 FlowDesign.REFRESH_Scripts）。
 */
export function BUILD_ScriptRows(host: FlowDesignHost): FlowScriptRow[] {
    const tree = BUILD_ScriptTree(FLOW_TREE.items);
    const rows: FlowScriptRow[] = [];
    const walk = (nodes: ReturnType<typeof BUILD_ScriptTree>, depth: number): void => {
        for (const n of nodes) {
            const hasChildren = n.children.length > 0;
            const expanded = FLOW_TREE.expanded.has(n.nodeId);
            rows.push({
                nodeId: n.nodeId,
                desc: n.desc,
                kindLabel: n.isGroup ? SCRIPT_GROUP_LABEL : (NODE_KIND_LABELS[n.kind as NodeKindValue] ?? n.kind),
                depth,
                isGroup: n.isGroup,
                hasChildren,
                expanded,
            });
            // 折叠的分组不下发后代（rows 就是可见行，渲染侧不必再过滤）
            if (hasChildren && expanded) walk(n.children, depth + 1);
        }
    };
    walk(tree, 0);
    return rows;
}

/** 切换分组展开/收起（点分组行就是它，不进入选中） */
export function TOGGLE_ScriptGroup(nodeId: string): void {
    const exp = FLOW_TREE.expanded;
    if (exp.has(nodeId)) exp.delete(nodeId);
    else exp.add(nodeId);
    FLOW_TREE.markExpandedChanged();
}

/**
 * 选中一个脚本：记下 nodeId，异步取回正文，再交回视图重算与重绘
 *
 * 正文同样不在缓存里（`GET_NodeBody` 是缓存通道的，对脚本恒返回空串），只能直读文件。
 * 读回之前先把正文清空并渲染一次 —— 否则会短暂显示上一个脚本的内容。
 */
export function SELECT_Script(host: FlowDesignHost, nodeId: string): void {
    // 分组是分类目录（模板口径）：点它只展开/收起，不进入选中
    const flatten = (nodes: ReturnType<typeof BUILD_ScriptTree>): ReturnType<typeof BUILD_ScriptTree> =>
        nodes.flatMap((n) => [n, ...flatten(n.children)]);
    const node = flatten(BUILD_ScriptTree(FLOW_TREE.items)).find((n) => n.nodeId === nodeId);
    if (node?.isGroup) {
        TOGGLE_ScriptGroup(nodeId);
        host.recompute();
        return;
    }
    host.currentScriptId = nodeId;
    host.currentText = '';
    host.recompute();
    host.renderContent();
    void host.pipe.READ_FileView(NODE_KIND.FLOW, nodeId).then((nf) => {
        // 期间用户可能已经切走：晚到的结果不该覆盖当前选中
        if (host.currentScriptId !== nodeId) return;
        host.currentText = nf?.body ?? '';
        host.recompute();
        host.renderContent();
    });
}

/**
 * 脚本行右键菜单
 *
 * `nodeId = null` 表示点在左栏空白处 → 只给「新建流程脚本」。
 */
export function SHOW_ScriptMenu(host: FlowDesignHost, nodeId: string | null, data: FlowScriptItem | null, e: MouseEvent): void {
    const menu = new Menu();
    if (nodeId && data) {
        menu.addItem((item) =>
            item.setTitle('编辑').setIcon('pencil')
                .onClick(() => SELECT_Script(host, nodeId)));
        menu.addItem((item) =>
            item.setTitle('打开文件').setIcon('file-text')
                .onClick(() => OPEN_ScriptFile(host, data.kind, nodeId)));
        menu.addItem((item) =>
            item.setTitle('归档').setIcon('archive')
                .onClick(() => {
                    host.pipe.EXEC_Mutation({
                        op: 'update',
                        kind: data.kind,
                        nodeId,
                        updates: { open: false, modify: new Date().toISOString() },
                    });
                }));
        menu.addSeparator();
        menu.addItem((item) =>
            item.setTitle('删除').setIcon('trash')
                .onClick(() => {
                    host.pipe.EXEC_Mutation({ op: 'remove', kind: data.kind, nodeId });
                }));
    } else {
        menu.addItem((item) =>
            item.setTitle('新建流程脚本').setIcon('plus')
                .onClick(() => CREATE_Script(host)));
    }
    menu.showAtMouseEvent(e);
}

/** 新建流程脚本（无父；建成后立刻选中它） */
export function CREATE_Script(host: FlowDesignHost): void {
    new TransactionCreateModal(host.app, {
        kinds: [NODE_KIND.FLOW],
        onSubmit: (input) => {
            const now = new Date().toISOString();
            const data = {
                kind: input.kind,
                desc: input.desc,
                open: true,
                create: now,
                modify: now,
            } as SeqtkNode;
            // 文件先行 + 缓存写入，统一由 EXEC_Create 承担（无父）
            void host.pipe.EXEC_Create({ kind: input.kind, data }).then((nodeId) => {
                SELECT_Script(host, nodeId);
            }).catch((e) => {
                console.error('[SeqTK] 新建流程脚本失败:', e);
                new Notice('新建流程脚本失败，请查看控制台');
            });
        },
    }).open();
}

/** 在编辑器中打开脚本节点文件（source 模式） */
export function OPEN_ScriptFile(host: FlowDesignHost, kind: NodeKindValue, nodeId: string): void {
    const filePath = GET_FileByPath(kind, nodeId, host.settings);
    const file = host.app.vault.getFileByPath(filePath);
    if (file) void host.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
}
