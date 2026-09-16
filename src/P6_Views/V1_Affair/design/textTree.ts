/**
 * design/textTree — 文本树 ⇄ 节点树的「投递」「导出」「回写」切片
 *
 * 解析与序列化的纯逻辑在 P2_Tools/Parse/TextTree.ts；本文件只负责把它接到数据面上：
 * - 投递：把解析出的文本树落成真实节点（深度优先，父先建才拿得到 nodeId）
 * - 导出：把已有子树序列化为文本（供批量编辑 / 导出 md / 做模板）
 * - 回写：把编辑后的文本树与原子树对齐，产出更新 / 新增 / 删除
 *
 * 数据面一律经 pipe（见 P6_Views/Views.md 边界判据）。
 */

import type { DataPipe } from '../../../P5_Data/CoPipe/DataPipe';
import type { GetChildrenFn } from '../../../P5_Data/MdFile/FileManagerModules/FileDelete';
import type { SeqtkNode } from '../../../P4_Nodes/NodeFacade';
import { kindUsesState } from '../../../P7_Render/Structure/S2_Modal/TransactionModals';
import {
    SERIALIZE_TextTree,
    type TextTreeNode,
} from '../../../P2_Tools/Parse/TextTree';

/** 投递结果 */
export interface DeliverResult {
    /** 成功创建的节点数 */
    created: number;
    /** 首个失败处的说明（null = 全部成功） */
    error: string | null;
}

/**
 * 把文本树投递到 `parentId` 之下（null / 空串 = 顶层）
 *
 * **必须深度优先**：子节点的 parent 要指向父节点，而父的 nodeId 只有在创建之后才有，
 * 因此不能先铺平再一次建完。任一步失败即中止并回报 —— 已建出的部分保留，
 * 由用户自行决定删除还是继续（静默回滚反而更容易让人以为「什么都没发生」）。
 */
export async function DELIVER_TextTree(
    pipe: DataPipe,
    roots: TextTreeNode[],
    parentId: string | null,
): Promise<DeliverResult> {
    let created = 0;

    const walk = async (node: TextTreeNode, parent: string | null): Promise<void> => {
        const now = new Date().toISOString();
        const data = {
            kind: node.kind,
            desc: node.desc,
            open: true,
            // 状态只对「有状态」的节点类型落盘，避免给证据类节点写无意义字段
            ...(kindUsesState(node.kind) ? { state: node.state } : {}),
            create: now,
            modify: now,
            ...(parent ? { parent } : {}),
        } as SeqtkNode;

        const id = await pipe.EXEC_Create({ kind: node.kind, data, parentId: parent ?? undefined });
        created++;
        for (const child of node.children) {
            await walk(child, id);
        }
    };

    try {
        for (const root of roots) {
            await walk(root, parentId && parentId.length > 0 ? parentId : null);
        }
        return { created, error: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { created, error: message };
    }
}

/** 读取某节点的子树（递归），返回与解析产物同形的结构 */
export function BUILD_Subtree(pipe: DataPipe, rootNodeId: string): TextTreeNode | null {
    const root = pipe.GET_Node(rootNodeId);
    if (!root) return null;

    const build = (nodeId: string, data: SeqtkNode): TextTreeNode => {
        const node: TextTreeNode = {
            kind: data.kind,
            state: data.state ?? 'plan',
            desc: data.desc,
            line: 0,
            children: [],
        };
        for (const child of pipe.GET_Children(nodeId)) {
            if (child.data) node.children.push(build(child.nodeId, child.data));
        }
        return node;
    };

    return build(rootNodeId, root);
}

/**
 * 把某棵子树导出为文本树
 *
 * 取的是**当前缓存里的树**（全部后代，与展开状态无关），因此导出的是完整结构而非可见部分。
 */
export function EXPORT_SubtreeAsText(
    pipe: DataPipe,
    rootNodeId: string,
    opts?: { alwaysKind?: boolean },
): string | null {
    const root = BUILD_Subtree(pipe, rootNodeId);
    return root ? SERIALIZE_TextTree([root], opts) : null;
}

/** 回写前的差异预告（先让用户看见将要发生什么，再决定是否落盘） */
/**
 * 导出某节点的**子节点们**为文本（多个根，顶层不缩进）
 *
 * 用于「以文本编辑框架内容」：框架里元素通常很多，若每次都必须从框架节点本身
 * 那个根写起，等于每行都要多一层缩进，很别扭。所以这里直接以子节点为根 ——
 * 本质是把框架自身那行藏起来，只编辑它的内容。
 */
export function EXPORT_ChildrenAsText(
    pipe: DataPipe,
    parentId: string,
    opts: { alwaysKind?: boolean } = {},
): string | null {
    const parent = BUILD_Subtree(pipe, parentId);
    if (!parent) return null;
    return SERIALIZE_TextTree(parent.children, opts);
}

export interface EditPlan {
    /** 描述或状态有变的节点数 */
    updated: number;
    /** 新增节点数 */
    created: number;
    /** 将被删除的节点数 */
    removed: number;
    /** 将被删除的节点名样例（最多若干条，供确认提示） */
    removedSample: string[];
}

/** 回写结果 */
export interface ApplyResult extends EditPlan {
    error: string | null;
}

/** 一棵树的节点总数 */
function COUNT_Tree(nodes: TextTreeNode[]): number {
    let n = 0;
    for (const node of nodes) n += 1 + COUNT_Tree(node.children);
    return n;
}

/**
 * 把编辑后的文本树与原子树对齐，算出差异（**只算不写**，供预览确认）
 *
 * 对齐规则是「按位置 + 类型」：同位置同类型视为同一节点；类型不符或超出原长度视为新建；
 * 原树多出的部分视为删除。
 *
 * 之所以按位置而不是按名称匹配：节点名允许重复、也常被改写，按名称匹配会产生
 * 「改了名字就被当成删旧建新」的意外；按位置更贴近「我在这份文本上做编辑」的心理模型。
 * 代价是插入一行会让其后同层节点顺移一位 —— 顺移后类型仍相同，因此被识别为「更新」
 * 而非「删除+新建」，结果是内容正确、nodeId 保留，符合预期。
 */
export function PLAN_TextTreeEdit(pipe: DataPipe, rootNodeId: string, editedRoot: TextTreeNode): EditPlan {
    const existing = BUILD_Subtree(pipe, rootNodeId);
    const plan: EditPlan = { updated: 0, created: 0, removed: 0, removedSample: [] };
    if (!existing) return plan;

    const diff = (oldNode: TextTreeNode, newNode: TextTreeNode): void => {
        if (oldNode.desc !== newNode.desc) plan.updated++;
        else if (kindUsesState(oldNode.kind) && oldNode.state !== newNode.state) plan.updated++;

        const n = Math.min(oldNode.children.length, newNode.children.length);
        for (let i = 0; i < n; i++) {
            const o = oldNode.children[i];
            const nw = newNode.children[i];
            if (o.kind !== nw.kind) {
                // 同位置类型不同：删旧 + 建新
                plan.removed++;
                if (plan.removedSample.length < 5) plan.removedSample.push(o.desc);
                plan.created++;
            } else {
                diff(o, nw);
            }
        }
        for (let i = n; i < oldNode.children.length; i++) {
            plan.removed++;
            if (plan.removedSample.length < 5) plan.removedSample.push(oldNode.children[i].desc);
        }
        if (newNode.children.length > n) plan.created += COUNT_Tree(newNode.children.slice(n));
    };

    diff(existing, editedRoot);
    return plan;
}

/**
 * 执行回写
 *
 * 顺序有讲究：
 * 1. 先更新（原地改字段，不碰 follows —— 因此**已有节点的相对顺序不变**）
 * 2. 再删除（同层从后往前，避免边删边挪位）
 * 3. 最后新建，并把父的 follows 按文本顺序**重排** —— 否则新增项只会被追加到末尾，
 *    「放回原位置」就落空了
 *
 * 根节点自身的类型不允许改（那等于换了一棵树），只比对内容。
 */
export async function APPLY_TextTreeEdit(
    pipe: DataPipe,
    rootNodeId: string,
    editedRoot: TextTreeNode,
): Promise<ApplyResult> {
    const existing = BUILD_Subtree(pipe, rootNodeId);
    const plan: EditPlan = { updated: 0, created: 0, removed: 0, removedSample: [] };
    if (!existing) return { ...plan, error: '原节点不存在' };

    const now = (): string => new Date().toISOString();

    /**
     * 级联删除用的子节点枚举
     *
     * 必须给真函数：removeTree 的文件侧靠它递归删文件，传 `() => []` 类型能过、
     * 但只会删掉根文件，留一堆孤儿 md —— 这类"类型正确、行为错误"的地方最容易漏。
     */
    const childrenOf: GetChildrenFn = (id) =>
        pipe.GET_Children(id).flatMap((c) => (c.data ? [{ kind: c.data.kind, nodeId: c.nodeId }] : []));

    /** 更新一个已有节点的字段（不触碰 follows / parent） */
    const updateNode = (nodeId: string, data: SeqtkNode, edited: TextTreeNode): void => {
        const updates: Record<string, unknown> = {};
        if (data.desc !== edited.desc) updates.desc = edited.desc;
        if (kindUsesState(data.kind) && (data.state ?? 'plan') !== edited.state) updates.state = edited.state;
        if (Object.keys(updates).length === 0) return;
        updates.modify = now();
        pipe.EXEC_Mutation({ op: 'update', kind: data.kind, nodeId, updates: updates as never });
        plan.updated++;
    };

    /** 新建一棵子树（深度优先），返回新根 id */
    const createTree = async (node: TextTreeNode, parentId: string): Promise<string> => {
        const data = {
            kind: node.kind,
            desc: node.desc,
            open: true,
            ...(kindUsesState(node.kind) ? { state: node.state } : {}),
            create: now(),
            modify: now(),
            parent: parentId,
        } as SeqtkNode;
        const id = await pipe.EXEC_Create({ kind: node.kind, data, parentId });
        plan.created++;
        for (const child of node.children) await createTree(child, id);
        return id;
    };

    /**
     * 按文本顺序重排父节点的 follows
     *
     * 未涉及的子节点保持在后面，但**必须剔除缓存里已不存在的** —— 删除时不重排的话，
     * 父的 follows 会留下指向已删节点的悬空 id（removeTree 只删节点，不动父的 follows）。
     */
    const reorder = (parentId: string, orderedChildIds: string[]): void => {
        const parent = pipe.GET_Node(parentId);
        if (!parent) return;
        const rest = (parent.follows ?? []).filter(
            (id) => !orderedChildIds.includes(id) && pipe.GET_Node(id) !== undefined,
        );
        const follows = [...orderedChildIds, ...rest];
        if (follows.join('|') === (parent.follows ?? []).join('|')) return;
        pipe.EXEC_Mutation({
            op: 'update',
            kind: parent.kind,
            nodeId: parentId,
            updates: { follows, modify: now() } as never,
        });
    };

    /** 递归对齐一层 */
    const syncChildren = async (parentId: string, newNode: TextTreeNode): Promise<void> => {
        const oldChildren = pipe.GET_Children(parentId).filter(
            (c): c is { kind: NonNullable<typeof c.kind>; nodeId: string; data: NonNullable<typeof c.data> } => !!c.data,
        );
        const n = Math.min(oldChildren.length, newNode.children.length);
        const orderedIds: string[] = [];

        // 1) 同位置：更新并递归
        for (let i = 0; i < n; i++) {
            const o = oldChildren[i];
            const nw = newNode.children[i];
            if (o.data.kind !== nw.kind) {
                // 类型不同：删旧 + 建新
                pipe.EXEC_Mutation({ op: 'remove', kind: o.data.kind, nodeId: o.nodeId });
                plan.removed++;
                if (plan.removedSample.length < 5) plan.removedSample.push(o.data.desc);
                orderedIds.push(await createTree(nw, parentId));
            } else {
                updateNode(o.nodeId, o.data, nw);
                await syncChildren(o.nodeId, nw);
                orderedIds.push(o.nodeId);
            }
        }

        // 2) 原树多出 → 删除（从后往前）
        for (let i = oldChildren.length - 1; i >= n; i--) {
            const o = oldChildren[i];
            pipe.EXEC_Mutation({ op: 'removeTree', kind: o.data.kind, nodeId: o.nodeId, childrenOf });
            plan.removed += 1 + COUNT_Removed(pipe, o.nodeId);
            if (plan.removedSample.length < 5) plan.removedSample.push(o.data.desc);
        }

        // 3) 文本新增 → 新建
        for (let i = n; i < newNode.children.length; i++) {
            orderedIds.push(await createTree(newNode.children[i], parentId));
        }

        reorder(parentId, orderedIds);
    };

    try {
        const rootData = pipe.GET_Node(rootNodeId);
        if (!rootData) return { ...plan, error: '原节点不存在' };
        updateNode(rootNodeId, rootData, editedRoot);
        await syncChildren(rootNodeId, editedRoot);
        return { ...plan, error: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ...plan, error: message };
    }
}

/** 数一棵子树的节点数（回写删除时用于统计即将消失的节点） */
function COUNT_Removed(pipe: DataPipe, nodeId: string): number {
    let n = 0;
    for (const child of pipe.GET_Children(nodeId)) {
        if (!child.data) continue;
        n += 1 + COUNT_Removed(pipe, child.nodeId);
    }
    return n;
}
