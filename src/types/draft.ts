/**
 * 流程草稿类型定义 — 规则设计 · 流程草稿（纯 UI 草稿，无专属语法、不涉及提醒）
 *
 * 数据仅作快速敲定时间的本地草稿记录：
 * - FlowDraft（草稿）：一张流程板，含多条并行事件轴
 * - EventAxis（事件轴 / 泳道）：横向并列，内部自上而下排列时间块
 * - TimeBlock（时间块）：一段带起止时间的事件，可只读关联某个节点 + 备注文本
 *
 * 关联节点仅存 nodeId 引用，绝不修改原节点；展示时实时经 NodeCache 解析。
 */

/** 草稿数据文件版本 */
export const DRAFT_FILE_VERSION = 1 as const;

/** 草稿 JSON 文件名（存放于插件数据根文件夹 rootFolder 下） */
export const DRAFT_FILE_NAME = 'flow-drafts.json';

/** 时间块 — 事件轴上的一个起止事件 */
export interface TimeBlock {
  /** 唯一 id */
  id: string;
  /** 起始时间（ISO datetime，可缺省） */
  from?: string;
  /** 结束时间（ISO datetime，可缺省） */
  to?: string;
  /** 关联节点 nodeId（只读引用，不修改原节点） */
  nodeId?: string;
  /** 备注 / 自由文本 */
  text?: string;
}

/** 事件轴（泳道）— 一条从上到下排列时间块的纵向序列 */
export interface EventAxis {
  /** 唯一 id */
  id: string;
  /** 轴标题 */
  title: string;
  /** 时间块（数组顺序 = 手动编号顺序） */
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

/** 默认新建时间块 */
export function createTimeBlock(): TimeBlock {
  return { id: genDraftId('b'), text: '' };
}

/** 取块的排序时间（from 优先、退 to）；均无则返回 Infinity */
function blockTime(block: TimeBlock): number {
  const iso = block.from || block.to;
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

/**
 * 将事件轴的块按起止时间稳定重排（升/降序），并返回重排后的块数组。
 * 无时间的块恒排尾部（升序）；排序结果即新的手动顺序。
 */
export function sortBlocksByTime(blocks: TimeBlock[], desc = false): TimeBlock[] {
  const dir = desc ? -1 : 1;
  return blocks
    .map((block, i) => ({ block, i, t: blockTime(block) }))
    .sort((x, y) => (x.t !== y.t ? (x.t - y.t) * dir : x.i - y.i))
    .map((item) => item.block);
}
