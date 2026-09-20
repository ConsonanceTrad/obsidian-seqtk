/**
 * design/appendExisting — 「追加已有信息」切片
 *
 * 与「追加信息」（新建一个空白证据节点再挂上去）相对：这条把库里**已有**的
 * 证据节点（对象 / 条件 / 信息 / 状态）直接挂到当前节点下，不复制、不新建 ——
 * 同一份内容因此能同时挂在多个父之下。
 *
 * 归属只由父侧的 follows 记录（父 → 子单向，见 AffiliationFields），
 * 所以这里**只改当前节点这一份文件**，被引用节点的文件完全不碰。
 *
 * 功能增补指引:
 * - 追加时想再加约束（状态、时间…）→ 在 allow 谓词里追加条件
 */

import { NodePickModal } from '../../../../P7_Render/Structure/S2_Modal/NodePickModal';
import { EVIDENCE_KINDS } from '../../../../P7_Render/Composition/C2_Tree/drag';
import type { NodeEditHost } from './actions';

/**
 * 把库里已有的**证据节点**挂到 parentId 节点下（引用式追加）
 *
 * 候选只留证据类型：这条入口的语义是「往这里补一条信息」，框架 / 构想 / 目标这些
 * 结构节点该用「创建节点」「变更归属」去摆，混进信息列表只会让人挑错东西。
 * 证据类型对任何父都合法（见 C2_Tree/drag.canBeChildOf 的首条短路），故无需再判父类型。
 *
 * 排除范围只到**自身**与**已经直属此处的**，不排除后代：追加只加一条边、不搬动节点，
 * 所以引用自己的后代不会成环 —— 那是 DAG 里的菱形（A→E 与 A→P→E 并存），把深处的证据
 * 提到上层正是这个功能的常见用法。「排除后代」是 changeParent 才需要的约束（那是移动）。
 *
 * 候选**不设条数上限**：底层检索按创建时间倒序，默认只取 50 条 —— 框架下那些早已
 * 存在的证据往往排在第 50 名之外，会被悄悄漏掉（而这正是本条入口最常用的场景：
 * 把框架直接持有的证据、或别的工序下的证据，引用到当前节点里来）。
 * 证据节点总量有限，配上搜索框足够用。
 */
export function appendExistingInfo(view: NodeEditHost, parentId: string): void {
    const parent = view.pipe.GET_Node(parentId);
    if (!parent) return;
    const existing = new Set(parent.follows ?? []);
    new NodePickModal(view.app, view.pipe, {
        title: '追加已有信息 · 选择库内证据节点',
        // 只排除自己（选了自己就是自环）
        excludeIds: [parentId],
        // 0 = 不设上限（详见上面的说明）
        limit: 0,
        // 已经直属此处的也不再列出 —— 再挂一次只是原地踏步
        allow: (id, kind) => EVIDENCE_KINDS.includes(kind) && !existing.has(id),
        emptyText: '没有可追加的证据节点（自身已排除，已挂在此处的也不再列出）',
        onPick: (childId) => {
            view.pipe.EXEC_Mutation({
                op: 'update',
                kind: parent.kind,
                nodeId: parentId,
                updates: {
                    follows: [...(parent.follows ?? []), childId],
                    modify: new Date().toISOString(),
                },
            });
        },
    }).open();
}
