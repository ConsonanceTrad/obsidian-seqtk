/**
 * 流程草稿类型定义 — 规则设计 · 流程草稿（纯 UI 草稿，无专属语法、不涉及提醒）
 *
 * 自 old/0.1.2/src/types/draft.ts 迁入（纯类型 + 纯函数，无外部依赖）。
 *
 * 数据仅作快速敲定时间的本地草稿记录：
 * - FlowDraft（草稿）：一张流程板，含多条并行事件轴
 * - EventAxis（事件轴 / 泳道）：横向并列，持有轴级「起止时间段」；
 *   内部自上而下排列顺序块，块表示执行顺序
 * - TimeBlock（顺序块）：轴内的一个执行步骤，可只读关联某个节点 + 输入文本，
 *   自身不携带时间
 *
 * 关联节点仅存 nodeId 引用，绝不修改原节点；展示时实时经 NodeCache 解析。
 */

/** 草稿数据文件版本 */
export const DRAFT_FILE_VERSION = 1 as const;

/** 草稿 JSON 文件名（存放于插件数据根文件夹 rootFolder 下） */
export const DRAFT_FILE_NAME = 'flow-drafts.json';

/** 顺序块 — 事件轴内的一个执行步骤（块自身无时间，仅表达顺序） */
export interface TimeBlock {
  /** 唯一 id */
  id: string;
  /** 关联节点 nodeId（只读引用，不修改原节点；可缺省则纯文本） */
  nodeId?: string;
  /** 步骤文本 */
  text?: string;
}

/** 事件轴（泳道）— 持有起止时间段，内部自上而下排列顺序块 */
export interface EventAxis {
  /** 唯一 id */
  id: string;
  /** 轴标题 */
  title: string;
  /** 轴级起始时间（ISO datetime，可缺省） */
  from?: string;
  /** 轴级结束时间（ISO datetime，可缺省） */
  to?: string;
  /** 顺序块（数组顺序 = 手动编号顺序） */
  blocks: TimeBlock[];
}

/** 草稿 — 一张含多条并行事件轴的流程板 */
export interface FlowDraft {
  /** 唯一 id */
  id: string;
  /** 草稿标题 */
  title: string;
  /** 创建时间（ISO） */
  create: string;
  /** 最后修改时间（ISO） */
  modify: string;
  /** 事件轴（数组顺序 = 轴左右顺序） */
  axes: EventAxis[];
}

/** 草稿数据文件整体结构 */
export interface FlowDraftsFile {
  version: typeof DRAFT_FILE_VERSION;
  drafts: FlowDraft[];
}

/** 生成局部唯一 id（非节点 id，仅草稿内部引用用） */
export function genDraftId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 默认新建草稿 */
export function createFlowDraft(title = '未命名草稿'): FlowDraft {
  const now = new Date().toISOString();
  return {
    id: genDraftId('d'),
    title,
    create: now,
    modify: now,
    axes: [createEventAxis('事件轴 1')],
  };
}

/** 默认新建事件轴 */
export function createEventAxis(title = '新事件轴'): EventAxis {
  return { id: genDraftId('a'), title, blocks: [] };
}

/** 默认新建顺序块 */
export function createTimeBlock(): TimeBlock {
  return { id: genDraftId('b'), text: '' };
}

/** 取轴的排序时间（from 优先、退 to）；均无则返回 Infinity */
function axisTime(axis: EventAxis): number {
  const iso = axis.from || axis.to;
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

/**
 * 将草稿的事件轴按轴级起止时间稳定重排（升/降序），并返回重排后的轴数组。
 * 无时间的轴恒排尾部（升序）；排序结果即新的手动（左右）顺序。
 */
export function sortAxesByTime(axes: EventAxis[], desc = false): EventAxis[] {
  const dir = desc ? -1 : 1;
  return axes
    .map((axis, i) => ({ axis, i, t: axisTime(axis) }))
    .sort((x, y) => (x.t !== y.t ? (x.t - y.t) * dir : x.i - y.i))
    .map((item) => item.axis);
}

/**
 * 旧数据迁移：时间层级上移 — 时间块不再持有时间，起止归事件轴。
 *
 * 规则：
 * - 若轴的 from/to 均未设置，但旧块携带 from/to，则取「块中最早的 from」
 *   为轴 from、「块中最晚的 to」为轴 to（任一侧缺省则取另一侧首个可用值）
 * - 之后一律清空块的 from/to 字段（轴已持有起止时，块级时间直接丢弃）
 *
 * @param axis 待迁移的事件轴（就地修改）
 * @returns 是否发生过数据变化（供上层决定是否需要回写）
 */
export function migrateAxisTimes(axis: EventAxis): boolean {
  const legacy = axis.blocks.filter((b) => (b as { from?: string }).from || (b as { to?: string }).to);
  if (legacy.length === 0) {
    // 无旧块级时间：只需清掉类型上已不存在的字段（无操作）
    return false;
  }

  let changed = false;

  // 1. 轴缺起止时从块级时间提升
  if (!axis.from || !axis.to) {
    const froms = legacy
      .map((b) => (b as { from?: string }).from)
      .filter((v): v is string => !!v)
      .map((v) => new Date(v).getTime())
      .filter((t) => !Number.isNaN(t));
    const tos = legacy
      .map((b) => (b as { to?: string }).to)
      .filter((v): v is string => !!v)
      .map((v) => new Date(v).getTime())
      .filter((t) => !Number.isNaN(t));

    if (!axis.from && froms.length > 0) {
      axis.from = new Date(Math.min(...froms)).toISOString();
      changed = true;
    }
    if (!axis.to && tos.length > 0) {
      axis.to = new Date(Math.max(...tos)).toISOString();
      changed = true;
    }
  }

  // 2. 清除块的旧时间字段
  for (const block of axis.blocks) {
    const legacyBlock = block as { from?: string; to?: string };
    if (legacyBlock.from !== undefined || legacyBlock.to !== undefined) {
      delete legacyBlock.from;
      delete legacyBlock.to;
      changed = true;
    }
  }

  return changed;
}
