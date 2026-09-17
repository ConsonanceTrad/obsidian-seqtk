/**
 * Template/Slice/templateActions — 模板模式的数据写操作切片
 *
 * 按 P6_Views/Views.md 的切片契约组织：以「宿主」为第一参数、只 `import type` 宿主契约
 * （见 TemplateHost —— 视图本就是它的实现，委托面板则用 app / pipe / settings 拼一个），
 * 数据面读写一律经 `view.pipe`（不碰 nodeCache / fileManager / operationQueue）。
 *
 * 覆盖模板库的增删与打开正文；「应用模板」另在 templateApply（阶段推进中），
 * 文本区回写在 templateText。
 */

import { Notice, TFile } from 'obsidian';
import { GET_FileByPath } from '../../../../P5_Data/MdFile/PathTools/PathParse';
import { kindUsesState } from '../../../../P7_Render/Structure/S2_Modal/TransactionModals';
import type { SeqtkNode } from '../../../../P4_Nodes/Node';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkState } from '../../../../P4_Nodes/NodeField/StateKeys';
import type { TemplateHost } from './TemplateHost';

/** 创建一个节点（parentId 提供时挂到该父框架下，双向维护 follows + parent） */
export async function CREATE_TemplateNode(
    view: TemplateHost,
    input: { kind: NodeKindValue; desc: string; state: SeqtkState },
    parentId?: string,
): Promise<void> {
    if (!view.pipe.isInitialized) {
        new Notice('查询缓存尚未就绪，请稍候');
        return;
    }
    const now = new Date().toISOString();
    const data = {
        kind: input.kind,
        desc: input.desc,
        open: true,
        // 状态只对「有状态」的类型落盘，避免给证据类节点写无意义字段
        ...(kindUsesState(input.kind) ? { state: input.state } : {}),
        create: now,
        modify: now,
        ...(parentId ? { parent: parentId } : {}),
    } as SeqtkNode;

    try {
        // 文件先行 + 父 follows 双向维护 + 缓存写入，统一由 EXEC_Create 承担
        await view.pipe.EXEC_Create({ kind: input.kind, data, parentId: parentId || undefined });
    } catch (err) {
        console.error('[SeqTK] 创建节点失败:', err);
        new Notice(`[SeqTK] 创建节点失败: ${err}`);
    }
}

/** 打开节点文件编辑（模板单元正文；模板库里的单元没有别的编辑入口） */
export function OPEN_NodeFile(view: TemplateHost, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    const filePath = GET_FileByPath(node.kind, nodeId, view.settings);
    const file = view.app.vault.getFileByPath(filePath);
    if (file instanceof TFile) {
        void view.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }
}

/**
 * 级联删除模板单元 / 模板框架（含整棵子树）
 *
 * 文件侧逐个删除；缓存侧走**单次** EXEC_RemoveTree（一次清 active + archive 两库后代，
 * 且只刷一次快照 —— 子树里可能含已归档后代，逐条移除会残留）。
 */
export function DELETE_TemplateTree(view: TemplateHost, nodeId: string): void {
    const root = view.pipe.GET_Node(nodeId);
    if (!root) return;

    const targets = [
        ...view.pipe.COLLECT_Descendants(nodeId).map((d) => ({ kind: d.kind, nodeId: d.nodeId })),
        { kind: root.kind, nodeId },
    ];
    view.pipe.EXEC_RemoveTree(nodeId, targets);

    // 删掉的可能是当前选中 / 展开中的节点，清一下视图态，免得右栏挂着已不存在的框架
    if (view.collapseSelectionIfGone) view.collapseSelectionIfGone();
    new Notice(`模板单元已删除（含 ${targets.length} 个节点）`);
}
