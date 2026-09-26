/**
 * 流程推送 · 任务序列生成
 *
 * 「推送」= 把任务放上**事项流**。一条任务是三选一：
 * - **时点推送**：执行完即结束，不占时段
 * - **时段推送**：写明了 `AT … TO …`，占住那一段、到指定时刻结束
 * - **条件推送**：分支是 `IF` / `NOT`，没有显式时间 —— 窗口内条件成立即推
 *
 * 一条语句（含时间块内递归）能不能产出任务，只看它有没有 `DO`（推送目标）。
 * `JUMP` / `RECO` / `EXEC` 不产出任务，但会作为旁注跟着走，免得看漏了上下文。
 *
 * ## 时间格子与活跃窗口
 *
 * 时间表达式的**尾部单位决定格子**：`Hn` 就是 n 点那一小时（n:00~n:59），
 * `mn` / 精确到分的 stamp 就是那一分钟。每条任务带一个半开的活跃窗口
 * `winFrom/winTo`（`YYYYMMDD-HHmm`，字符串序即时间序）：
 *
 * - 时点：`[格子起, 格子末)` —— `AT @T-H9` 的窗口是 09:00~09:59
 * - 时段：`[AT 格子起, TO 格子末)` —— `AT @T-H9 TO @T-H17` 覆盖 09:00~17:59
 * - 条件：外层时间块的活跃时间；顶层时是脚本 `#STF~#ENF` 的约束区间
 *
 * ## 同刻冲突与优先级
 *
 * 同一时刻有多条推送时按 `DO^N` 定先后：**有优先级的一律先于没指定优先级的**；
 * 都有则数值大的先（负值自然落到最后）；都没指定就保持脚本里的原序
 * —— 也就是设计里说的「随机顺序推送」。跨脚本合并时再按脚本勾选顺序（mergePushTasks）。
 *
 * ## 循环的展开范围（本版刻意保持最小）
 *
 * 只展开**能用「每 N 天 + 当天第几段」说清的循环**：`@R-D3` / `@R-D1-H23` 这类。
 * `@T-`（块内相对）与嵌套循环暂不展开 —— 它们要等评估层定型；碰到时留一条旁注说明
 * 跳过了什么，而不是编一个假时间出来。
 */

import { transferText } from './serialize';
import type { FlowScript, Statement, Transfer, Branch, TimeExpr } from './parser';

/** 推送方式 */
export type FlowPushMode = 'point' | 'span' | 'condition';

/** 一条推送任务 */
export interface FlowPushTask {
  /** 落点时间（`YYYYMMDD-HHmm`）；条件推送为空串 */
  at: string;
  /** 时段推送的结束时刻；其余为空 */
  to?: string;
  /** 活跃窗口起点（含；`YYYYMMDD-HHmm`）；展不开时间的任务为空串 */
  winFrom: string;
  /** 活跃窗口终点（不含）；`winFrom <= now < winTo` 时任务处于活跃时段 */
  winTo: string;
  /** 推送方式 */
  mode: FlowPushMode;
  /** 条件推送的条件（`IF` 正向 / `NOT` 反向）；其余方式没有 */
  cond?: { text: string; want: boolean };
  /** 推送目标（`DO` 的节点引用） */
  nodeId: string;
  /** 优先级（`DO^N`）；没指定就是 undefined */
  priority?: number;
  /** 来源语句的行号（回溯用） */
  line: number;
  /** 旁注：同一条语句里的 JUMP / RECO / EXEC，以及没能展开的说明 */
  notes: string[];
  /** 原始序号：同刻同优先级时靠它保持脚本原序 */
  seq: number;
}

/** 半开活跃窗口（`YYYYMMDD-HHmm` 字符串，字典序即时间序） */
export interface PushWindow {
  from: string;
  to: string;
}

/** `YYYYMMDD-HHmm` 加 n 分钟（用 Date 做进位，含跨日） */
function addMinutes(ymdHm: string, n: number): string {
  const m = ymdHm.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return ymdHm;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  d.setMinutes(d.getMinutes() + n);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 时间格子：尾部单位决定活跃窗口
 *
 * `Hn` 是 n 点那一小时（`[n:00, n+1:00)`）；精确到分的 stamp 是那一分钟。
 * 统一用「格子起 → 格子末」的半开区间表达，判定只做字符串比较。
 */
function hourWindow(date: string, hour: number): PushWindow {
  return { from: `${date}-${pad2(hour)}00`, to: addMinutes(`${date}-${pad2(hour)}59`, 1) };
}

function stampWindow(date: string, time: string): PushWindow {
  return { from: `${date}-${time}`, to: addMinutes(`${date}-${time}`, 1) };
}

/** 取约束里的绝对时间戳（`#STF` / `#ENF` 的值） */
function guardStamp(script: FlowScript, kind: 'STF' | 'ENF'): { date: string; time: string } | null {
  const g = script.guards.find((x) => x.kind === kind);
  if (!g || g.value === 'EVER' || g.value.kind !== 'stamp') return null;
  return { date: g.value.date, time: g.value.time };
}

/** `YYYYMMDD` 往前推 n 天（用 Date 逐日推进，不做毫秒加法） */
function addDays(ymd: string, n: number): string | null {
  const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + n);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 把 `@R-…` 摊成「每隔几天、当天第几段」
 *
 * 取前两段：第一段定周期（天 / 周），第二段若单位是 `H` 就是当天那一小时格子
 * （**格子语义**：`H23` 是 23:00~23:59 那一小时，而不是「区间右端点」的 22~23）。
 * 取不出周期就返回 null，交给调用方记旁注。
 */
function repeatSpec(t: TimeExpr | undefined): { stepDays: number; fromHour?: number; toHour?: number } | null {
  if (!t || t.kind !== 'repeat' || t.parts.length === 0) return null;
  const [first, second] = t.parts;
  const stepDays = first.unit === 'D' ? first.n : first.unit === 'W' ? first.n * 7 : null;
  if (!stepDays || stepDays < 1) return null;
  if (second && second.unit === 'H') {
    const h = Math.min(23, second.n);
    return { stepDays, fromHour: h, toHour: h };
  }
  return { stepDays };
}

/** 同刻冲突的排序：先时间，再优先级 */
function compareTasks(a: FlowPushTask, b: FlowPushTask): number {
  if (a.at !== b.at) return a.at.localeCompare(b.at);
  const pa = a.priority;
  const pb = b.priority;
  if (pa === undefined && pb === undefined) return a.seq - b.seq;  // 都没指定 → 保持原序
  if (pa === undefined) return 1;                                   // 没指定的一律排后
  if (pb === undefined) return -1;
  return pb - pa;                                                   // 数值大的先，负值自然靠后
}

/**
 * 由流程脚本生成推送任务序列
 *
 * @param days 循环展开覆盖的天数（从 `#STF` 那天起算）
 */
export function generatePushTasks(script: FlowScript, days = 7): FlowPushTask[] {
  const tasks: FlowPushTask[] = [];
  const base = guardStamp(script, 'STF');
  let seq = 0;

  /** 一层时间上下文：块内语句从这里继承落点 */
  interface TimeCtx {
    at?: string;
    to?: string;
    /** 活跃窗口（半开）；条件推送的隐含时间就从这里继承 */
    win?: PushWindow;
    condition?: boolean;
  }

  /** 脚本约束区间（`#STF~#ENF`）—— 顶层条件推送的隐含活跃窗口 */
  const scriptWin = ((): PushWindow | undefined => {
    const st = guardStamp(script, 'STF');
    const en = guardStamp(script, 'ENF');
    if (!st || !en) return undefined;
    return { from: `${st.date}-${st.time}`, to: addMinutes(`${en.date}-${en.time}`, 1) };
  })();

  /** 把一条语句里的 DO 变成任务；没有 DO 就什么也不产出 */
  const emit = (s: Statement, ctx: TimeCtx, extraNotes: string[] = []): void => {
    const notes = [...s.transfers.filter((t) => t.kind !== 'DO').map(transferText), ...extraNotes];
    const dos = s.transfers.filter((t): t is Extract<Transfer, { kind: 'DO' }> => t.kind === 'DO');
    for (const d of dos) {
      const mode: FlowPushMode = ctx.condition ? 'condition' : ctx.to !== undefined ? 'span' : 'point';
      // 条件推送的隐含时间：外层时间块 → 脚本约束区间
      const win = ctx.condition ? (ctx.win ?? scriptWin) : ctx.win;
      tasks.push({
        at: ctx.condition ? '' : (ctx.at ?? ''),
        to: ctx.to,
        winFrom: win?.from ?? '',
        winTo: win?.to ?? '',
        mode,
        cond: ctx.condition && s.branch.arg ? { text: s.branch.arg, want: s.branch.kind === 'IF' } : undefined,
        nodeId: d.nodeId,
        priority: d.priority,
        line: s.line,
        notes,
        seq: seq++,
      });
    }
  };

  const walk = (list: Statement[], ctx: TimeCtx): void => {
    for (const s of list) {
      const b: Branch = s.branch;

      if (b.kind === 'IF' || b.kind === 'NOT') {
        // 条件推送：没有时间，条件成立即推
        emit(s, { ...ctx, condition: true });
        if (s.braced) walk(s.block, { ...ctx, condition: true });
        continue;
      }

      if (b.kind === 'REPT') {
        const spec = repeatSpec(b.time);
        if (!spec || !base) {
          // 展不开就如实说，不编时间
          const why = !base
            ? '脚本没有可用的 #STF（起点），循环无法展开'
            : '循环写法本版暂不展开（只支持「每 N 天 + 当天第几段」）';
          emit(s, { ...ctx, at: undefined }, [why]);
          if (s.braced) walk(s.block, ctx);
          continue;
        }
        // 逐轮展开：每 stepDays 天一轮，块内继承这一轮的时间
        for (let d = 0; d < days; d += spec.stepDays) {
          const date = addDays(base.date, d);
          if (!date) break;
          const round: TimeCtx = spec.fromHour !== undefined
            ? (() => {
                const win = hourWindow(date, spec.fromHour as number);
                return {
                  at: `${date}-${pad2(spec.fromHour as number)}00`,
                  to: `${date}-${pad2(spec.fromHour as number)}59`,
                  win,
                };
              })()
            : { at: `${date}-0000`, win: { from: `${date}-0000`, to: `${addDays(date, 1) ?? date}-0000` } };
          emit(s, round, []);
          if (s.braced) walk(s.block, round);
        }
        continue;
      }

      // AT（时点 / 时段）与 STEP（只影响次序，本身不落时间）
      let at = ctx.at;
      let to = ctx.to;
      let win = ctx.win;
      const notes: string[] = [];
      if (b.kind === 'AT') {
        if (b.time?.kind === 'stamp') {
          at = `${b.time.date}-${b.time.time}`;
          const atWin = stampWindow(b.time.date, b.time.time);
          if (b.toTime?.kind === 'stamp') {
            to = `${b.toTime.date}-${b.toTime.time}`;
            // 时段 = [AT 格子起, TO 格子末)：`AT @T-H9 TO @T-H17` 覆盖 09:00~17:59
            win = { from: atWin.from, to: addMinutes(to, 1) };
          } else {
            // 时点 = 落点自己的格子：`AT @T-H9` 是 09:00~09:59，stamp 到分则是那一分钟
            win = atWin;
          }
        } else if (b.time?.kind === 'offset') {
          notes.push('AT 用的是块内相对时间（@T-…），本版暂不展开');
        }
        if (b.toTime?.kind === 'offset') notes.push('AT … TO 用的是块内相对时间（@T-…），本版暂不展开');
      }

      emit(s, { at, to, win, condition: ctx.condition }, notes);
      if (s.braced) walk(s.block, { at, to, win, condition: ctx.condition });
    }
  };

  walk(script.statements, {});
  tasks.sort(compareTasks);
  return tasks;
}

/** 一组待合并的推送（一个流程脚本的产物） */
export interface FlowPushGroup {
  scriptId: string;
  scriptDesc: string;
  tasks: FlowPushTask[];
}

/** 合并后的推送条目：带上来源脚本（显示与日志用） */
export interface FlowPushItem extends FlowPushTask {
  scriptId: string;
  scriptDesc: string;
}

/**
 * 多流程合并单流
 *
 * 排序：时间 → `DO^N` 优先级 → **脚本勾选顺序**（groups 数组序）→ 脚本内原序。
 * 条件推送没有落点时间（at 空串），一律缀在时间线尾部 —— 时间线是主轴。
 */
export function mergePushTasks(groups: FlowPushGroup[]): FlowPushItem[] {
  const rows: { item: FlowPushItem; gi: number }[] = [];
  groups.forEach((g, gi) => {
    for (const t of g.tasks) {
      rows.push({ item: { ...t, scriptId: g.scriptId, scriptDesc: g.scriptDesc }, gi });
    }
  });
  rows.sort((x, y) => {
    const a = x.item;
    const b = y.item;
    // 条件推送（at 空）缀尾
    if (!a.at !== !b.at) return a.at ? -1 : 1;
    if (a.at !== b.at) return a.at.localeCompare(b.at);
    const pa = a.priority;
    const pb = b.priority;
    if (pa !== undefined && pb !== undefined && pa !== pb) return pb - pa;
    if (pa === undefined && pb !== undefined) return 1;
    if (pa !== undefined && pb === undefined) return -1;
    if (x.gi !== y.gi) return x.gi - y.gi;
    return a.seq - b.seq;
  });
  return rows.map((r) => r.item);
}
