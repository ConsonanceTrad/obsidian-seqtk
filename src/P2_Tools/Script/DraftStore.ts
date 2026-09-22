/**
 * DraftStore — 旧版草稿文件的读取与一次性迁移（历史数据通道）
 *
 * 草稿现在是节点（`NODE_KIND.DRAFT`），日常存取不再经过本文件。它只做两件事：
 * 读旧的 `flow-drafts.json`，以及把里面的草稿搬成节点。
 *
 * ## 迁移为什么是有损的
 *
 * 旧结构是「多条并行泳道，轴持有起止时间、块只有顺序」，新结构是「一张线性清单，
 * 每条条目自带时点或时段」。两者没法一一对应 —— 比如「一条轴里五个块」在旧模型里
 * 表达「这五件事都在这个时间段内、按序做」，到新模型要么拆成五条同时段的条目、
 * 要么合成一条。这里取**一条轴 → 一条时段条目**：
 *
 * - 时间：轴有 from+to 就是时段条目（`AT … TO …`），只有 from 就是时点条目
 * - 锚点日：取「第一条有时间的轴的那一天」，都没有就用该草稿的创建日期
 * - 说明：新条目不带自由文本，旧块的说明**没有位置可放**，只能舍弃
 * - 关联：取轴内**第一个**带引用的块；没有引用的轴整个舍弃
 *   —— 旧模型允许一条轴里多个块各挂一个，这里必然有损失
 *
 * 宁可把信息摊平并写明损失，也不编造一种旧数据里并不存在的对应关系。
 * 搬完后旧文件内容挪到 `flow-drafts.migrated.json`、原文件清空，
 * 所以重复调用不会重复建节点（幂等）。
 */

import { NODE_KIND } from '../../P4_Nodes/NodeKind/NodeKind';
import { DRAFT_FILE_MIGRATED, DRAFT_FILE_NAME, DRAFT_FILE_VERSION } from './Draft';
import type { LegacyDraftsFile, LegacyFlowDraft } from './Draft';
import type { DataPipe } from '../../P5_Data/CoPipe/DataPipe';
import type { SeqtkNode } from '../../P4_Nodes/Node';

/** ISO → `HHmm`（把轴的时间折成条目的时刻，与 `@YYYYMMDD-HHmm` 的写法一致） */
function hhmm(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '0000';
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Date → `YYYYMMDD`（本地时区） */
function ymd(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 把一份旧草稿拼成新草稿节点的正文（`#STF`/`#ENF` 界定那一天，条目是 `AT … DO @节点`） */
function buildBody(draft: LegacyFlowDraft): string {
    const axes = draft.axes ?? [];
    // 锚点日：第一条有时间的轴的那一天；都没有就用创建日期
    const stamp = axes.map((a) => a.from || a.to).find((s): s is string => !!s);
    const anchor = stamp ? new Date(stamp) : new Date(draft.create);
    const day = Number.isNaN(anchor.getTime()) ? ymd(new Date()) : ymd(anchor);

    const lines = [
        `#STF @${day}-0000`,
        `#ENF @${day}-2359`,
        '',
    ];
    for (const axis of axes) {
        // 新模型的条目只挂一个节点引用，也没有自由文本；旧模型允许一条轴里多个块各挂
        // 一个、还各带说明 —— 这里只取第一个引用，没有引用的轴无处安放，只能舍弃
        const ref = (axis.blocks ?? []).map((b) => b.nodeId).find((id): id is string => !!id);
        if (!ref) continue;
        const at = `@${day}-${axis.from ? hhmm(axis.from) : '0000'}`;
        const span = axis.to ? `AT ${at} TO @${day}-${hhmm(axis.to)}` : `AT ${at}`;
        lines.push(`${span} DO @${ref};`);
    }
    return lines.join('\n');
}

/** 旧草稿文件的读写 */
export class DraftStore {
    constructor(
        /** 数据面唯一入口（插件数据目录文件的读写都经它） */
        private pipe: DataPipe,
    ) {}

    /** 读取旧文件里的全部草稿（文件缺失或损坏时返回空数组，不报错） */
    async load(): Promise<LegacyFlowDraft[]> {
        try {
            const raw = await this.pipe.READ_DataFile(DRAFT_FILE_NAME);
            if (!raw) return [];
            const parsed = JSON.parse(raw) as LegacyDraftsFile;
            if (!parsed || !Array.isArray(parsed.drafts)) return [];
            if (parsed.version !== DRAFT_FILE_VERSION) {
                // 版本对不上仍旧尝试迁移：结构没变过，多一句日志便于排查
                console.warn(`[SeqTK][Draft] 旧草稿文件版本为 ${parsed.version}（期望 ${DRAFT_FILE_VERSION}），仍按当前结构迁移`);
            }
            return parsed.drafts;
        } catch (err) {
            console.warn('[SeqTK][Draft] 读取旧流程草稿失败，按无旧数据处理:', err);
            return [];
        }
    }

    /** 旧文件留档：内容挪到 `.migrated.json`，原文件清空（失败只记日志） */
    async RENAME_Legacy(): Promise<void> {
        try {
            const raw = await this.pipe.READ_DataFile(DRAFT_FILE_NAME);
            if (!raw) return;
            await this.pipe.WRITE_DataFile(DRAFT_FILE_MIGRATED, raw);
            await this.pipe.WRITE_DataFile(DRAFT_FILE_NAME, '');
        } catch (err) {
            console.warn('[SeqTK][Draft] 旧草稿文件留档失败（节点已建好，可手工处理旧文件）:', err);
        }
    }
}

/**
 * 一次性迁移：把旧 `flow-drafts.json` 里的草稿搬成 DRAFT 节点
 *
 * 幂等：没有旧文件（或已被清空）就直接返回 false；搬完调 `RENAME_Legacy()`。
 *
 * @returns 是否真的建立了节点（供调用方决定要不要提示）
 */
export async function MIGRATE_Drafts(pipe: DataPipe): Promise<boolean> {
    const store = new DraftStore(pipe);
    const legacy = await store.load();
    if (legacy.length === 0) return false;

    let created = 0;
    for (const draft of legacy) {
        const now = new Date().toISOString();
        const data = {
            kind: NODE_KIND.DRAFT,
            // 标题带「（旧）」后缀，方便一眼认出是从旧草稿搬来的
            desc: `${draft.title || '未命名草稿'}（旧）`,
            open: true,
            create: draft.create || now,
            modify: now,
        } as SeqtkNode;
        try {
            await pipe.EXEC_Create({ kind: NODE_KIND.DRAFT, data, body: buildBody(draft) });
            created++;
        } catch (err) {
            console.warn(`[SeqTK][Draft] 迁移旧草稿「${draft.title}」失败:`, err);
        }
    }

    await store.RENAME_Legacy();
    console.log(`[SeqTK][Draft] 旧流程草稿已迁移 ${created} 份（旧文件内容移到 ${DRAFT_FILE_MIGRATED}）`);
    return created > 0;
}
