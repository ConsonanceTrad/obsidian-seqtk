/**
 * PushRuntime — 流程推送运行时（非视图服务）
 *
 * 一次重算把「多流程 → 当日单流」算完：
 * 扫描启用的流程脚本 → 各自 `generatePushTasks` → `mergePushTasks` 合并单流
 * → 过滤今天（**丢弃哲学**：昨天没做完的不积压、不追责，今天不显示就是不显示）
 * → 条件求值（窗口内成立才进序列）→ 算活跃项 / 下一件。
 *
 * 时间判定全部用 `YYYYMMDD-HHmm` 定长字符串比较（`winFrom <= now < winTo`），
 * 语义见 push.ts 的「时间格子与活跃窗口」。
 *
 * 提醒：任务**进入活跃时刻**弹一次 Obsidian Notice（纯提醒、不带按钮，完成动作
 * 留在面板里防误触）；状态栏常驻当前活跃项，点击由调用方注入的回调打开面板。
 *
 * 完成动作：点完成 = 节点状态写「完成」（经 `EXEC_StateChange`，吃状态传播规则）
 * + 记行为日志 + 会话内标记。**完成标记不持久化** —— 重启不追责，符合丢弃哲学；
 * 日志才是「我做过什么」的长期记录。
 */

import { Notice } from 'obsidian';
import { NODE_KIND } from '../../P4_Nodes/NodeKind/NodeKind';
import { SimpleStore } from '../../P5_Data/Svelte/SimpleStore';
import { parseFlowScript } from '../../P2_Tools/Script/parser';
import { generatePushTasks, mergePushTasks, type FlowPushGroup, type FlowPushItem } from '../../P2_Tools/Script/push';
import { logDateKey, nowLogTime } from '../../P2_Tools/Parse/LogLine';
import { Save_Setting, type PluginSettings } from '../../P3_Settings/Settings';
import { RESOLVE_DoTargets, type DoTargetUnit } from '../../P4_Nodes/DoResolve';
import type { DataPipe } from '../../P5_Data/CoPipe/DataPipe';
import type { NodeFile } from '../../P4_Nodes/Node';
import type SeqtkPlugin from '../../main';

/** 组内一个推送单元（叶子行动项连同其子树） */
export interface PushUnitView extends DoTargetUnit {
    /** 本会话已完成（划线留原位）或持久已完成（仅组内历史语境） */
    done: boolean;
}

/** 合并后的推送条目 + 显示信息 */
export interface PushItemView extends FlowPushItem {
    /** `DO` 目标节点的展示名（组条目 = 事务节点名；读不到时回退 nodeId） */
    nodeDesc: string;
    /** 完成（组条目 = 全部单元完成） */
    done: boolean;
    /**
     * 组单元：DO 展开为事务的行动项时（组推送）；
     * 空数组 = 普通单条任务（DO 目标原样）
     */
    units: PushUnitView[];
}

/** 流程脚本勾选项 */
export interface PushScriptView {
    nodeId: string;
    desc: string;
    enabled: boolean;
}

/** 推送运行时状态（推送面板订阅的唯一来源） */
export interface PushRuntimeState {
    scripts: PushScriptView[];
    /** 当日序列（合并单流；完成项原位保留） */
    items: PushItemView[];
    /** 未排期：时间展不开的任务（只提示，不算今天的事） */
    unscheduled: PushItemView[];
    /** 当前活跃项（窗口含 now 的第一条未完成） */
    active: PushItemView | null;
    /** 下一件（winFrom 在 now 之后的第一条未完成） */
    upcoming: PushItemView | null;
    /** 脚本解析错误 */
    errors: string[];
    emptyText: string;
}

const EMPTY_STATE: PushRuntimeState = {
    scripts: [],
    items: [],
    unscheduled: [],
    active: null,
    upcoming: null,
    errors: [],
    emptyText: '今天没有推送任务',
};

/**
 * 条件求值（最小版）
 *
 * 只认 `@<节点id>.state ==|!= <状态>` 一种形态；解析不了或节点读不到时
 * **保守视为不成立**（不推）—— 与「不编假时间」同一条原则：不确定就不推。
 */
export function EVAL_Condition(
    cond: { text: string; want: boolean },
    getState: (nodeId: string) => string | undefined,
): boolean {
    const m = cond.text.match(/^@(\S+)\.state\s*(==|!=)\s*(\S+)$/);
    if (!m) return false;
    const actual = getState(m[1]);
    if (actual === undefined) return false;
    const hit = (actual === m[3]) === (m[2] === '==');
    return hit === cond.want;
}

/** `YYYYMMDD-HHmm` 形式的「现在」 */
function NOW_Stamp(d: Date): string {
    return `${logDateKey(d)}-${nowLogTime(d).slice(0, 5)}`;
}

export class PushRuntime {
    readonly state = new SimpleStore<PushRuntimeState>(EMPTY_STATE);

    /** 对齐定时器（到下一分钟 0 秒起每 60 秒一跳） */
    private timer: number | null = null;
    private interval: number | null = null;
    /** 已 Notice 过的任务 key（会话内不重复提醒） */
    private notified = new Set<string>();
    /** 会话内完成的节点（丢弃哲学：不持久化） */
    private doneNodes = new Set<string>();
    private statusEl: HTMLElement | null = null;

    constructor(
        private plugin: SeqtkPlugin,
        private pipe: DataPipe,
        private settings: PluginSettings,
        /** 点击状态栏打开推送面板（由调用方注入，避免与视图模块循环依赖） */
        private onOpenPanel: () => void,
    ) {}

    /** 启动：状态栏 + 60s 对齐定时器 + 首次重算 */
    START(): void {
        this.statusEl = this.plugin.addStatusBarItem();
        this.statusEl.addClass('seqtk-push-status');
        this.statusEl.setAttribute('aria-label', '流程推送（点击打开）');
        this.statusEl.addEventListener('click', () => this.onOpenPanel());

        const tick = () => {
            void this.RECOMPUTE();
        };
        const delay = 60_000 - (Date.now() % 60_000);
        this.timer = window.setTimeout(() => {
            tick();
            this.interval = window.setInterval(tick, 60_000);
        }, delay);
        tick();
    }

    /** 停止：清定时器与状态栏（插件卸载） */
    STOP(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.interval !== null) window.clearInterval(this.interval);
        this.timer = null;
        this.interval = null;
        this.statusEl?.remove();
        this.statusEl = null;
    }

    /** 状态重算（多流程 → 当日单流） */
    async RECOMPUTE(): Promise<void> {
        let files: NodeFile[] = [];
        try {
            files = await this.pipe.SCAN_Files([NODE_KIND.FLOW]);
        } catch (e) {
            console.error('[SeqTK] 扫描流程脚本失败:', e);
        }

        const disabled = this.settings.flowPushDisabled ?? [];
        const groups: FlowPushGroup[] = [];
        const errors: string[] = [];
        const scripts: PushScriptView[] = files.map((f) => ({
            nodeId: f.nodeId,
            desc: f.data.desc,
            enabled: !disabled.includes(f.nodeId),
        }));

        for (const f of files) {
            if (disabled.includes(f.nodeId)) continue;
            const ast = parseFlowScript(f.body);
            if (ast.errors.length > 0) {
                errors.push(`${f.data.desc}：${ast.errors.map((e) => `第 ${e.line} 行 ${e.message}`).join('；')}`);
                continue;
            }
            groups.push({ scriptId: f.nodeId, scriptDesc: f.data.desc, tasks: generatePushTasks(ast) });
        }

        const now = new Date();
        const todayKey = logDateKey(now);
        const dayStart = `${todayKey}-0000`;
        const dayEnd = `${logDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))}-0000`;
        const nowStr = NOW_Stamp(now);
        const getState = (id: string): string | undefined => this.pipe.GET_Node(id)?.state;

        const items: PushItemView[] = [];
        const unscheduled: PushItemView[] = [];
        for (const t of mergePushTasks(groups)) {
            // DO 分发语义：事务节点展开为「待完成叶子行动项」的组（见 P4_Nodes/DoResolve）
            const resolved = RESOLVE_DoTargets(this.pipe, t.nodeId);
            const units: PushUnitView[] = resolved.grouped
                ? resolved.units
                    // 持久已完成的不打扰；本会话刚完成的划线留原位（组内可见做完了什么）
                    .filter((u) => u.pending || this.doneNodes.has(u.nodeId))
                    .map((u) => ({ ...u, done: !u.pending || this.doneNodes.has(u.nodeId) }))
                : [];
            // 组里一个单元都不剩（全持久完成 / 放弃）→ 整条不推
            if (resolved.grouped && units.length === 0) continue;
            const single = resolved.units[0];
            // 单条同口径：持久已完成的不推，本会话刚完成的划线留原位
            if (!resolved.grouped && single && !single.pending && !this.doneNodes.has(t.nodeId)) continue;
            const done = resolved.grouped
                ? units.every((u) => u.done)
                : this.doneNodes.has(t.nodeId);
            const view: PushItemView = {
                ...t,
                nodeDesc: resolved.grouped
                    ? (resolved.groupDesc || this.pipe.GET_Node(t.nodeId)?.desc || t.nodeId)
                    : (single?.desc ?? t.nodeId),
                done,
                units,
            };
            // 时间展不开（旁注任务）：不算今天的事，只提示
            if (!t.winFrom || !t.winTo) {
                unscheduled.push(view);
                continue;
            }
            // 丢弃哲学：只看今天窗口内的，昨天的不积压
            if (!(t.winFrom < dayEnd && t.winTo > dayStart)) continue;
            // 条件推送：窗口内且条件成立才推
            if (t.mode === 'condition' && t.cond && !EVAL_Condition(t.cond, getState)) continue;
            items.push(view);
        }

        const active = items.find((t) => !t.done && t.winFrom <= nowStr && nowStr < t.winTo) ?? null;
        const upcoming = items.find((t) => !t.done && t.winFrom > nowStr) ?? null;

        let emptyText = '';
        if (items.length === 0 && unscheduled.length === 0) {
            emptyText = errors.length > 0 ? '脚本有误，暂无法生成推送' : '今天没有推送任务';
        }

        this.state.set({ scripts, items, unscheduled, active, upcoming, errors, emptyText });
        this.NOTIFY(items);
        this.UPDATE_StatusBar();
    }

    /**
     * 完成一件推送：节点写「完成」（吃状态传播）+ 行为日志 + 会话内标记
     *
     * 同节点的其余活跃条目由 `doneNodes.has` 自动视为完成。
     */
    COMPLETE(nodeId: string): void {
        this.doneNodes.add(nodeId);
        this.pipe.EXEC_StateChange(nodeId, 'done');
        this.pipe.LOG_Append(NODE_KIND.BEHAVE_LOG, `完成推送任务：[[${nodeId}]]`);
        void this.RECOMPUTE();
    }

    /** 勾选流程参与/退出推送（落 Settings，重开库保持） */
    TOGGLE_SCRIPT(scriptId: string, enabled: boolean): void {
        const cur = new Set(this.settings.flowPushDisabled ?? []);
        if (enabled) cur.delete(scriptId);
        else cur.add(scriptId);
        this.settings.flowPushDisabled = [...cur];
        void Save_Setting(this.plugin);
        void this.RECOMPUTE();
    }

    /** 手动刷新（用户主动动作）记行为日志 */
    LOG_MANUAL_REFRESH(): void {
        this.pipe.LOG_Append(NODE_KIND.BEHAVE_LOG, '手动刷新流程推送');
    }

    /** 到点提醒：进入活跃时刻的任务各弹一次 Notice（完成的不弹） */
    private NOTIFY(items: PushItemView[]): void {
        const nowStr = NOW_Stamp(new Date());
        for (const t of items) {
            if (t.done || !t.winFrom || !t.winTo) continue;
            if (!(t.winFrom <= nowStr && nowStr < t.winTo)) continue;
            const key = `${t.scriptId}|${t.line}|${t.nodeId}|${t.winFrom}`;
            if (this.notified.has(key)) continue;
            this.notified.add(key);
            const pendingCount = t.units.filter((u) => !u.done).length;
            new Notice(
                t.units.length > 0
                    ? `流程推送：${t.nodeDesc}（${pendingCount} 项行动）${t.scriptDesc ? `（${t.scriptDesc}）` : ''}`
                    : `流程推送：${t.nodeDesc}${t.scriptDesc ? `（${t.scriptDesc}）` : ''}`,
            );
            // 流程日志：「流程在什么时候推送了哪些东西」的正式出处
            this.pipe.LOG_Append(NODE_KIND.FLOW_LOG, `推送：〈${t.nodeDesc}〉→ [[${t.nodeId}]]（${t.scriptDesc}）`);
            // 组推送把分发展开的行动项一并记下（每单元一行，与日志行格式约定一致）
            for (const u of t.units) {
                this.pipe.LOG_Append(NODE_KIND.FLOW_LOG, `· 行动：〈${u.desc}〉→ [[${u.nodeId}]]`);
            }
        }
    }

    /** 状态栏：当前活跃项，无则预告下一件 */
    private UPDATE_StatusBar(): void {
        if (!this.statusEl) return;
        const s = this.state.get();
        const cut = (text: string): string => (text.length > 16 ? `${text.slice(0, 16)}…` : text);
        if (s.active) {
            this.statusEl.setText(`$(clock) ${cut(s.active.nodeDesc)}`);
        } else if (s.upcoming) {
            this.statusEl.setText(`$(calendar) ${s.upcoming.winFrom.slice(9)} ${cut(s.upcoming.nodeDesc)}`);
        } else {
            this.statusEl.setText('$(check-circle) 无待推送');
        }
    }
}
