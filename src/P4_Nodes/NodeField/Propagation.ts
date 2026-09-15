/**
 * Propagation — 状态传播规则（父 → 子 / 子 → 父）
 *
 * ── 规则语义（按你的定义）──
 * 不是「状态联级 / 状态跟随」两个布尔开关，而是**按状态类型配置的规则表**：
 *
 * - `down`（父 → 子）：父进入 `trigger` 时，把当前处于 `from` 之一的后代改为 `to`。
 *   例：父变「完成」→ 处于「规划 / 进行」的后代一并变「完成」。
 * - `up`（子 → 父）：全部直接子节点都达到 `trigger` 时，把父改为 `to`（聚合）。
 *
 * 这些规则取代了旧的 `stateCascade` / `statusFollow` / `statusFollowTarget` ——
 * 那三项在此之前**从未被任何代码读取**（死配置），且无法表达「按状态类型分别配置」。
 *
 * 本模块是纯逻辑：不接触数据层、不 import "obsidian"，由调用方取好上下文后计算。
 */

import { STATE_VALUES, type SeqtkState } from './StateKeys';

/** 传播方向：down = 父变更向子扩散；up = 子全部达标向父聚合 */
export type PropagationDirection = 'down' | 'up';

/** 一条状态传播规则 */
export interface StatePropagationRule {
    /**
     * 规则名：设置界面显示与矛盾检测报告共用（`RuleConflict.ruleIds` 就是它）。
     * 允许用户改名，但应与其它规则不同名 —— 重名会让报告指认不出是哪一条。
     * 传播逻辑不读它，因此改名不改变任何行为。
     */
    id: string;
    enabled: boolean;
    direction: PropagationDirection;
    /** down：父进入此状态即触发；up：子全部达到此状态即触发 */
    trigger: SeqtkState;
    /** down：子的当前状态需命中其一（空数组 = 任意状态都改）；up 不使用 */
    from: SeqtkState[];
    /** 改成的目标状态 */
    to: SeqtkState;
}

/**
 * 默认规则（与你给的例子一致：父的「完成」向子的「规划 / 进行」传播）
 *
 * `up` 默认关闭：聚合语义会「替用户下判断」，默认不启用更稳妥。
 */
export const DEFAULT_STATE_RULES: StatePropagationRule[] = [
    {
        id: 'down-done',
        enabled: true,
        direction: 'down',
        trigger: 'done',
        from: ['plan', 'open'],
        to: 'done',
    },
    {
        id: 'down-drop',
        enabled: true,
        direction: 'down',
        trigger: 'drop',
        from: ['plan', 'open'],
        to: 'drop',
    },
    {
        id: 'up-done',
        enabled: false,
        direction: 'up',
        trigger: 'done',
        // up 方向不使用 from（子节点全部达到 trigger 即聚合），留空数组保持结构一致
        from: [],
        to: 'done',
    },
];

/** 一次传播要写入的变更 */
export interface PropagationChange {
    nodeId: string;
    state: SeqtkState;
    /** 由哪条规则推出（便于排查与提示） */
    ruleId: string;
}

/** 计算传播所需的上下文（由调用方经 DataPipe 取好，本模块不查询数据） */
export interface PropagationInput {
    /** 被手动变更的节点 */
    nodeId: string;
    /** 变更后的状态 */
    state: SeqtkState;
    /** 被变更节点的祖先链（由近及远；用于 up 方向向父聚合） */
    ancestors: { nodeId: string; state: SeqtkState }[];
    /** 被变更节点的全部后代（扁平；用于 down 方向扩散） */
    descendants: { nodeId: string; state: SeqtkState }[];
    /** 某节点的直接子节点（用于 up 聚合判定；缺省时该节点不参与聚合） */
    childrenOf: (nodeId: string) => { nodeId: string; state: SeqtkState }[];
}

/** down：该后代是否应被本次传播改写 */
function shouldFollowDown(rule: StatePropagationRule, childState: SeqtkState): boolean {
    if (rule.from.length === 0) return true;
    return rule.from.includes(childState);
}

/**
 * 计算一次状态变更引发的全部传播（纯函数）
 *
 * - `down`：沿后代扩散（后代数量有限，一趟算完）
 * - `up`：自变更点向上逐层判定；每层判定用的是「该层子节点的**新**状态」，
 *   因此需要把本趟已决定的变更累积进状态视图
 * - 迭代上限 `MAX_ROUNDS` 防御规则自身成环（如 done→open 与 open→done 同时启用）
 */
export function COMPUTE_Propagation(
    rules: StatePropagationRule[],
    input: PropagationInput,
): PropagationChange[] {
    const active = rules.filter((r) => r.enabled);
    if (active.length === 0) return [];

    /** 当前状态视图：nodeId → 状态（含本趟已决定的变更，供 up 聚合判定使用） */
    const stateOf = new Map<string, SeqtkState>();
    stateOf.set(input.nodeId, input.state);
    for (const a of input.ancestors) stateOf.set(a.nodeId, a.state);
    for (const d of input.descendants) stateOf.set(d.nodeId, d.state);

    const changes: PropagationChange[] = [];
    const changedIds = new Set<string>([input.nodeId]);

    // ── down：从变更点沿后代扩散 ──
    for (const rule of active) {
        if (rule.direction !== 'down') continue;
        if (input.state !== rule.trigger) continue;
        for (const d of input.descendants) {
            const cur = stateOf.get(d.nodeId) ?? d.state;
            if (cur === rule.to) continue;
            if (!shouldFollowDown(rule, cur)) continue;
            if (changedIds.has(d.nodeId)) continue;
            stateOf.set(d.nodeId, rule.to);
            changedIds.add(d.nodeId);
            changes.push({ nodeId: d.nodeId, state: rule.to, ruleId: rule.id });
        }
    }

    // ── up：自变更点向上逐层聚合（父节点的子节点全部达标 → 父改） ──
    const MAX_ROUNDS = input.ancestors.length + 1;
    let cursorId = input.nodeId;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const parent = input.ancestors.find((_, i) => i === round);
        if (!parent) break;

        for (const rule of active) {
            if (rule.direction !== 'up') continue;
            const kids = input.childrenOf(parent.nodeId);
            if (kids.length === 0) continue;
            const allReached = kids.every((k) => (stateOf.get(k.nodeId) ?? k.state) === rule.trigger);
            if (!allReached) continue;
            const parentState = stateOf.get(parent.nodeId) ?? parent.state;
            if (parentState === rule.to) continue;
            if (changedIds.has(parent.nodeId)) continue;
            stateOf.set(parent.nodeId, rule.to);
            changedIds.add(parent.nodeId);
            changes.push({ nodeId: parent.nodeId, state: rule.to, ruleId: rule.id });
        }
        cursorId = parent.nodeId;
    }
    void cursorId;

    return changes;
}

/** 规则矛盾/可疑之处 */
export interface RuleConflict {
    ruleIds: string[];
    /** 人类可读说明 */
    reason: string;
}

/**
 * 规则矛盾检测
 *
 * 检出两类问题：
 * 1. 同向、同 trigger，会命中同一批节点、但 `to` 不同 —— 同一次变更会被推往两个不同状态
 *    （down 比 `from` 交集；up 不使用 `from`，同 trigger 即命中同一个父的全部子节点）
 * 2. `down` 且 `from` 含 `to` —— 会把已经处于目标状态的节点再「改成」目标状态，属配置冗余
 *
 * 刻意**不**检查 `to === trigger`：这两个字段分属不同节点 ——
 * down 的 trigger 是父的状态、to 是子的状态；up 的 trigger 是子、to 是父 ——
 * 同名不等于空转。默认规则 down-done（父完成 → 子也完成）正是这种情况，报它纯属误报。
 */
export function DETECT_RuleConflicts(rules: StatePropagationRule[]): RuleConflict[] {
    const active = rules.filter((r) => r.enabled);
    const out: RuleConflict[] = [];

    // 1) 目标冲突：同一个触发状态上，两把规则会把同一批节点改成不同结果
    for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
            const a = active[i];
            const b = active[j];
            if (a.direction !== b.direction || a.trigger !== b.trigger) continue;
            if (a.to === b.to) continue;
            // up 不使用 from：只要 trigger 相同，两条 up 规则必然作用于同一批子节点
            const overlap =
                a.direction === 'up' ||
                a.from.length === 0 ||
                b.from.length === 0 ||
                a.from.some((s) => b.from.includes(s));
            if (!overlap) continue;
            out.push({
                ruleIds: [a.id, b.id],
                reason: `两条规则在「${a.trigger}」上触发同一批节点，却改写为不同目标（${a.to} / ${b.to}）`,
            });
        }
    }

    // 2) down 的 from 含 to（冗余）
    for (const r of active) {
        if (r.direction === 'down' && r.from.includes(r.to)) {
            out.push({ ruleIds: [r.id], reason: `"从"集合中包含了目标状态（${r.to}），该项可移除` });
        }
    }

    return out;
}

/** 全部可选状态（设置界面用；顺序即流转顺序） */
export const PROPAGATION_STATES: readonly SeqtkState[] = STATE_VALUES;
