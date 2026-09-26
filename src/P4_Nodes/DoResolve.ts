/**
 * DoResolve — DO 推送目标的分发语义（推送时解释）
 *
 * `DO @事务节点` **代表的是其下属的行动项**，不是它自己：
 *
 * - 构想链（CONCEPT→DIRECT→TARGET→PROCESS…）/ 清单链（CHECK→ITEM）上的节点，
 *   展开为子树中**最深的工序 / 行动节点**（叶子行动项：`AFFAIR_PROCESS` / `AFFAIR_ITEM`
 *   中没有行动后代的那些），每个叶子**连同其子树**构成一个推送单元
 * - 子树里不存在工序 / 行动节点时，退化为**最下属层级**（子树最深层的节点）
 * - 只推**待完成**的单元：`plan` / `open` / 无状态；`done` / `drop` 跳过（不惩罚、不追责）
 * - 非事务节点（证据 / 脚本等）原样单条，不做展开
 *
 * 解释发生在**推送时**而不是分发写入时：DO 里存的仍是所选事务节点，
 * 事务结构后来拆出新工序，下次重算自动跟上。
 *
 * 本模块是业务规则：不写数据、不碰 UI，取数经调用方给的 pipe。
 */

import { IS_KindOfCategory, NODE_KIND, type NodeKindValue } from "./NodeKind/NodeKind";
import type { SeqtkNode } from "./Node";
import type { DataPipe } from "../P5_Data/CoPipe/DataPipe";

/** 行动层类型：工序 / 事项 */
const ACTION_KINDS: ReadonlySet<NodeKindValue> = new Set<NodeKindValue>([
    NODE_KIND.PROCESS,
    NODE_KIND.ITEM,
]);

/** 一个推送单元（叶子行动项或最下属层级节点，连同其子树） */
export interface DoTargetUnit {
    nodeId: string;
    kind: NodeKindValue;
    desc: string;
    /** 该单元子树的附属规模（含自身；展示为「含 N 项」的摘要） */
    subtreeSize: number;
    /** 持久状态是否待做（规划 / 进行 / 无状态）；false = 已完成（显示与否由调用方定） */
    pending: boolean;
}

/** DO 的解析结果 */
export interface DoResolveResult {
    /** 事务展开的产物（组推送的单元；空 = 全部已完成，不再推） */
    units: DoTargetUnit[];
    /** true = 组推送（事务展开）；false = 原样单条（非事务节点） */
    grouped: boolean;
    /** 组标题用：被 DO 的事务节点（grouped 时才有） */
    groupDesc: string;
}

/** 待完成判定：规划 / 进行 / 无状态才算；完成与放弃的不再打扰 */
function IS_Pending(node: SeqtkNode): boolean {
    const s = (node as { state?: string }).state;
    return s === undefined || s === 'plan' || s === 'open';
}

/** 该节点下面还有没有行动层子级 */
function HAS_ActionChild(pipe: DataPipe, nodeId: string): boolean {
    return pipe.GET_Children(nodeId).some((c) => !!c.data && ACTION_KINDS.has(c.data.kind));
}

/**
 * 解析一条 DO 的推送目标
 *
 * 返回 `units`（待完成的推送单元）与是否组推送。事务节点展开后单元可能为
 * 空（全做完 / 全放弃）—— 调用方据此整条不推。
 */
export function RESOLVE_DoTargets(pipe: DataPipe, nodeId: string): DoResolveResult {
    const node = pipe.GET_Node(nodeId);
    // 非事务节点（或读不到）：原样单条，不展开
    if (!node || !IS_KindOfCategory(node.kind, 'AFFAIR')) {
        return {
            units: node
                ? [{ nodeId, kind: node.kind, desc: node.desc, subtreeSize: 1, pending: IS_Pending(node) }]
                : [{ nodeId, kind: NODE_KIND.PROCESS, desc: nodeId, subtreeSize: 1, pending: true }],
            grouped: false,
            groupDesc: '',
        };
    }

    // 后代扁平表（含自身，随后排除 —— 「下属」不含自己）
    const flat = pipe.COLLECT_Descendants(nodeId);
    const descendants = flat.filter((d) => d.nodeId !== nodeId);

    /** 叶子行动项：行动层里没有行动后代的那些 */
    const leafActions = descendants.filter(
        (d) => ACTION_KINDS.has(d.kind) && !HAS_ActionChild(pipe, d.nodeId),
    );
    // 行动层不是叶子的中间工序（有子工序）不算 —— 只推最深那一层，避免重复推
    const picked = leafActions.length > 0
        ? leafActions
        // 没有行动层 → 最下属层级：子树里没有后代的那些（任何类型）
        : descendants.filter((d) => pipe.GET_Children(d.nodeId).length === 0);

    const units: DoTargetUnit[] = picked
        // 放弃的永久不打扰；完成的留下（调用方决定显示成完成态还是剔除）
        .filter((d) => (d.data as { state?: string }).state !== 'drop')
        .map((d) => ({
            nodeId: d.nodeId,
            kind: d.kind,
            desc: d.data.desc,
            subtreeSize: pipe.COLLECT_Descendants(d.nodeId).length,
            pending: IS_Pending(d.data),
        }));

    return { units, grouped: true, groupDesc: node.desc };
}
