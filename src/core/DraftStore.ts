/**
 * DraftStore — 流程草稿数据的 JSON 存取（rootFolder/flow-drafts.json）
 *
 * 纯本地草稿存储，不经过节点体系：
 * - 文件不存在时返回空结构（不报错）
 * - 写入前确保数据根文件夹存在（Obsidian adapter 无法创建不存在的文件）
 * - 解析失败/损坏时返回空结构并尽量不覆盖（保存时若仍为空则重建）
 */

import type { App } from 'obsidian';
import type { NodeFileManager } from './NodeFileManager';
import { DRAFT_FILE_NAME, DRAFT_FILE_VERSION } from '../types/draft';
import type { FlowDraft, FlowDraftsFile } from '../types/draft';

export class DraftStore {
  constructor(
    private app: App,
    private fileManager: NodeFileManager,
  ) {}

  /** 草稿 JSON 文件完整路径 */
  private get filePath(): string {
    return `${this.fileManager.rootFolder}/${DRAFT_FILE_NAME}`;
  }

  /** 读取全部草稿（文件缺失或损坏时返回空数组） */
  async load(): Promise<FlowDraft[]> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.filePath))) return [];
      const raw = await adapter.read(this.filePath);
      const parsed = JSON.parse(raw) as FlowDraftsFile;
      if (!parsed || !Array.isArray(parsed.drafts)) return [];
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
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.filePath)) {
        await adapter.write(this.filePath, json);
      } else {
        // 确保数据目录存在后创建文件
        await this.fileManager.ensureRootFolder();
        await this.app.vault.create(this.filePath, json);
      }
    } catch (err) {
      console.warn('[SeqTK][Draft] 写入流程草稿失败:', err);
    }
  }
}
