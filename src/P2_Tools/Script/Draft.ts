/**
 * Draft — 旧版流程草稿的数据结构（只读历史，不再产生新数据）
 *
 * 草稿现在是**节点**：类型 `NODE_KIND.DRAFT`，正文用最简 flow 语法（见 V2_Rule/FlowDraft）。
 * 本文件保留旧 JSON 文件（rootFolder/flow-drafts.json）的结构定义，只服务于一次性迁移 ——
 * 搬完之后旧文件会被改名留档，这里的东西就只剩历史参考价值。
 *
 * 旧结构是三层的，与新结构的**线性清单不能无损对应**：
 *   LegacyFlowDraft{axes} → LegacyEventAxis{from,to,blocks} → LegacyTimeBlock{nodeId?, text?}
 * 「轴」是并行泳道、持有起止时间，「块」只有顺序、没有自己的时间；新结构里每条条目
 * **自带**时点或时段（`AT …` / `AT … TO …`）。映射因此是有损的，取舍写在 DraftStore 的说明里。
 */

/** 旧草稿文件的版本号 */
export const DRAFT_FILE_VERSION = 1 as const;

/** 旧草稿文件名（存放于插件数据根文件夹下） */
export const DRAFT_FILE_NAME = 'flow-drafts.json';

/** 迁移后旧文件的新名：留档，不再被读取 */
export const DRAFT_FILE_MIGRATED = 'flow-drafts.migrated.json';

/** 旧：顺序块 — 事件轴内的一个执行步骤（自身无时间，只表达顺序） */
export interface LegacyTimeBlock {
    id: string;
    /** 只读关联的节点 nodeId（可缺省则是纯文本块） */
    nodeId?: string;
    /** 步骤文本 */
    text?: string;
}

/** 旧：事件轴（泳道）— 持有起止时间段，内部自上而下排列顺序块 */
export interface LegacyEventAxis {
    id: string;
    title: string;
    /** 轴级起始时间（ISO datetime，可缺省） */
    from?: string;
    /** 轴级结束时间（ISO datetime，可缺省） */
    to?: string;
    blocks: LegacyTimeBlock[];
}

/** 旧：一张含多条并行事件轴的流程板 */
export interface LegacyFlowDraft {
    id: string;
    title: string;
    create: string;
    modify: string;
    axes: LegacyEventAxis[];
}

/** 旧：草稿文件整体 */
export interface LegacyDraftsFile {
    version: number;
    drafts: LegacyFlowDraft[];
}
