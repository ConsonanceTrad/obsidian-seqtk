/**
 * DraftStore — 流程草稿数据的 JSON 存取（rootFolder/flow-drafts.json）
 *
 * 自 old/0.1.2/src/core/DraftStore.ts 迁入并补全（原文件在新分层中长期处于注释状态）。
 *
 * 纯本地草稿存储，不经过节点体系：
 * - 文件不存在时返回空结构（不报错）
 * - 写入前由 pipe 确保数据根文件夹存在（Obsidian adapter 无法创建不存在的文件）
 * - 解析失败/损坏时返回空结构并尽量不覆盖（保存时若仍为空则重建）
 *
 * 数据面：经 **DataPipe** 的插件数据目录文件原语（READ_DataFile / WRITE_DataFile），
 * 不再直接持有 vault.adapter 与 NodeFileManager。
 */

import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import { DRAFT_FILE_NAME, DRAFT_FILE_VERSION, migrateAxisTimes } from './Draft';
import type { FlowDraft, FlowDraftsFile } from './Draft';

export class DraftStore {
  constructor(
    /** 数据面唯一入口（插件数据目录文件的读写都经它） */
    private pipe: DataPipe,
  ) {}

  /** 读取全部草稿（文件缺失或损坏时返回空数组）；读入时执行时间层级迁移并回写 */
  async load(): Promise<FlowDraft[]> {
    try {
      const raw = await this.pipe.READ_DataFile(DRAFT_FILE_NAME);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as FlowDraftsFile;
      if (!parsed || !Array.isArray(parsed.drafts)) return [];
      // 迁移：时间块不再持有时间，起止归事件轴（旧数据存在时回写一次）
      let changed = false;
      for (const draft of parsed.drafts) {
        for (const axis of draft.axes) {
          if (migrateAxisTimes(axis)) changed = true;
        }
      }
      if (changed) await this.save(parsed.drafts);
      return parsed.drafts;
    } catch (err) {
      console.warn('[SeqTK][Draft] 读取流程草稿失败，按空草稿处理:', err);
      return [];
    }
  }

  /** 写入全部草稿 */
  async save(drafts: FlowDraft[]): Promise<void> {
    try {
      const payload: FlowDraftsFile = {
        version: DRAFT_FILE_VERSION,
        drafts,
      };
      const json = JSON.stringify(payload, null, 2);
      await this.pipe.WRITE_DataFile(DRAFT_FILE_NAME, json);
    } catch (err) {
      console.warn('[SeqTK][Draft] 写入流程草稿失败:', err);
    }
  }
}
