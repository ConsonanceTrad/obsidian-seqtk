/**
 * 循环规则解析与计算工具
 *
 * 规则语法：
 *   主要重复：`M` (Y/M/W/D/h/m) + `-rN` (每N个周期)
 *   附加重复：`-ilxM` 或 `-ixM`
 *     i    = interval marker
 *     l    = 'l' 前缀表示从末尾倒数
 *     x    = 细分周期内的第x个
 *     M    = 细分单位 (Y/M/W/D/h/m)
 *
 * 示例：
 *   D-r3              → 每3天
 *   W-r2-i4D-i9h     → 每两周的第4天第9小时
 *   h-r2-i30m         → 每2小时的第30分钟
 */

import type { Moment } from 'moment';

// ============================================================
// 结构化类型
// ============================================================

export interface CycleSubInterval {
  /** 从末尾倒数 */
  reverse: boolean;
  /** 细分周期内的位置 */
  count: number;
  /** 细分单位 */
  unit: string;
}

export interface CycleRule {
  /** 主要重复单位: Y/M/W/D/h/m */
  unit: string;
  /** 间隔数量 (每N个周期) */
  interval: number;
  /** 附加重复规则列表 */
  subIntervals: CycleSubInterval[];
}

// ============================================================
// 内部常量
// ============================================================

const UNIT_NAMES: Record<string, string> = {
  Y: '年', M: '月', W: '周', D: '日', h: '时', m: '分',
};

const UNIT_HIERARCHY: Record<string, number> = {
  Y: 6, M: 5, W: 4, D: 3, h: 2, m: 1,
};

const UNIT_MAX: Record<string, number> = { M: 12, W: 5, D: 31, h: 23, m: 59 };
const UNIT_MIN: Record<string, number> = { M: 1, W: 1, D: 1, h: 0, m: 0 };

const MOMENT_UNIT_MAP: Record<string, string> = {
  Y: 'year', M: 'month', W: 'week', D: 'day', h: 'hour', m: 'minute',
};

const PARENT_MOMENT_UNIT: Record<string, string> = {
  minute: 'hour',
  hour: 'day',
  day: 'month',
  week: 'month',
  month: 'year',
};

// ============================================================
// 解析
// ============================================================

/**
 * 解析循环规则字符串为结构化对象。
 * 无效规则返回 null。
 */
export function parseCycleRule(ruleString: string): CycleRule | null {
  if (!ruleString) return null;
  const s = ruleString.trim();
  const parts = s.split('-');

  const unit = parts[0];
  if (!unit || !UNIT_NAMES[unit]) return null;

  let interval = 1;
  const subIntervals: CycleSubInterval[] = [];

  let idx = 1;
  while (idx < parts.length) {
    const part = parts[idx];

    if (part.startsWith('r') && part.length > 1) {
      const n = parseInt(part.slice(1), 10);
      if (isNaN(n) || n < 1) return null;
      interval = n;
      idx++;
      continue;
    }

    if (part.startsWith('i') && part.length > 1) {
      const inner = part.slice(1);
      const sub = parseSubInterval(inner);
      if (!sub) return null;
      subIntervals.push(sub);
      idx++;
      continue;
    }

    return null;
  }

  return { unit, interval, subIntervals };
}

function parseSubInterval(s: string): CycleSubInterval | null {
  let reverse = false;
  let rest = s;
  if (rest.startsWith('l')) {
    reverse = true;
    rest = rest.slice(1);
  }
  // 末尾是单位字母，前面是数字
  const unit = rest[rest.length - 1];
  if (!unit || !UNIT_NAMES[unit]) return null;
  const numStr = rest.slice(0, -1);
  const count = parseInt(numStr, 10);
  if (isNaN(count) || count < 0) return null;
  return { reverse, count, unit };
}

// ============================================================
// 构建
// ============================================================

/**
 * 将结构化规则对象序列化为规则字符串。
 */
export function buildCycleRuleString(rule: CycleRule): string {
  let s = rule.unit;
  if (rule.interval > 1) {
    s += `-r${rule.interval}`;
  }
  for (const sub of rule.subIntervals) {
    s += `-i${sub.reverse ? 'l' : ''}${sub.count}${sub.unit}`;
  }
  return s;
}

// ============================================================
// 验证
// ============================================================

/**
 * 验证循环规则是否合法。
 * 返回 null 表示合法，否则返回错误消息。
 */
export function validateCycleRule(ruleString: string): string | null {
  const rule = parseCycleRule(ruleString);
  if (!rule) return '规则格式无效';

  if (rule.interval < 1) return '间隔必须大于 0';

  const mainLevel = UNIT_HIERARCHY[rule.unit];
  if (mainLevel === undefined) return '无效的主单位';

  let prevLevel = mainLevel;
  for (const sub of rule.subIntervals) {
    const subLevel = UNIT_HIERARCHY[sub.unit];
    if (subLevel === undefined) return '无效的细分单位';
    if (subLevel >= prevLevel) {
      return `细分单位 ${UNIT_NAMES[sub.unit]} 必须小于上级单位`;
    }
    const min = UNIT_MIN[sub.unit] ?? 0;
    const max = UNIT_MAX[sub.unit] ?? 999;
    if (sub.count < min || sub.count > max) {
      return `${UNIT_NAMES[sub.unit]}的值必须在 ${min}-${max} 之间`;
    }
    prevLevel = subLevel;
  }

  return null;
}

// ============================================================
// 触发时间计算
// ============================================================

/**
 * 根据循环规则和基准时间，计算从当前时刻起的下一次触发时间。
 * 返回 null 表示规则无效。
 *
 * @param ruleString 规则字符串
 * @param baseTime   基准时间（moment 对象）
 * @param now        当前时间（moment 对象）
 */
export function getNextTriggerTime(
  ruleString: string,
  baseTime: Moment,
  now: Moment,
): Moment | null {
  const rule = parseCycleRule(ruleString);
  if (!rule) return null;

  const { unit, interval, subIntervals } = rule;
  const smallestUnit = subIntervals.length > 0
    ? subIntervals[subIntervals.length - 1].unit
    : unit;

  // 搜索上限：最多搜索 2000 个周期
  const maxCycles = 2000;

  for (let ci = 0; ci < maxCycles; ci++) {
    const cycleStart = computeCycleStart(baseTime, unit, ci * interval);
    const candidate = buildCandidateTime(cycleStart, subIntervals);
    const candidateEnd = computeCycleEnd(candidate, smallestUnit);

    // 候选时间在当前时间之后 → 就是下一次触发
    if (candidate.isSameOrAfter(now)) {
      return candidate;
    }

    // 候选时间已过，跳过此周期继续搜索
    if (candidateEnd.isBefore(now)) {
      continue;
    }
  }

  return null;
}

/**
 * 计算从 now 开始的未来 N 次触发时间。
 */
export function getUpcomingTriggers(
  ruleString: string,
  baseTime: Moment,
  now: Moment,
  count: number = 5,
): Moment[] {
  const triggers: Moment[] = [];
  let current = now.clone();
  for (let i = 0; i < count; i++) {
    const next = getNextTriggerTime(ruleString, baseTime, current);
    if (!next) break;
    triggers.push(next.clone());
    current = next.clone().add(1, 'minute'); // 移过当前触发点以找下一个
  }
  return triggers;
}

// ============================================================
// 人类可读描述
// ============================================================

/**
 * 生成循环规则的中文可读描述。
 */
export function describeCycleRule(ruleString: string): string {
  const rule = parseCycleRule(ruleString);
  if (!rule) return '无效规则';

  const { unit, interval, subIntervals } = rule;
  let desc = interval > 1
    ? `每 ${interval} ${UNIT_NAMES[unit]}`
    : `每${UNIT_NAMES[unit]}`;

  for (const sub of subIntervals) {
    const subName = UNIT_NAMES[sub.unit];
    if (sub.reverse) {
      desc += `，倒数第 ${sub.count} ${subName}`;
    } else {
      desc += `，第 ${sub.count} ${subName}`;
    }
  }

  return desc;
}

// ============================================================
// 内部辅助函数
// ============================================================

function computeCycleStart(ref: Moment, unit: string, offset: number): Moment {
  const mu = getMomentUnit(unit);
  const m = ref.clone().startOf(mu as any);
  if (offset !== 0) {
    m.add(offset, mu as any);
  }
  return m;
}

function computeCycleEnd(candidate: Moment, unit: string): Moment {
  return candidate.clone().endOf(getMomentUnit(unit) as any);
}

function buildCandidateTime(cycleStart: Moment, subIntervals: CycleSubInterval[]): Moment {
  let m = cycleStart.clone();
  for (const sub of subIntervals) {
    const momentUnit = getMomentUnit(sub.unit);
    if (sub.reverse) {
      // 倒数：先到父周期末尾，使当前单位达到最大值，再回退
      const parentUnit = PARENT_MOMENT_UNIT[momentUnit];
      if (parentUnit) {
        m.endOf(parentUnit as any);
        m.startOf(momentUnit as any);
      } else {
        m.endOf(momentUnit as any);
      }
      if (sub.count > 1) {
        m.subtract(sub.count - 1, momentUnit as any);
      }
    } else {
      m.add(sub.count, momentUnit as any);
    }
  }
  return m;
}

function getMomentUnit(unit: string): string {
  return MOMENT_UNIT_MAP[unit] || 'minute';
}
