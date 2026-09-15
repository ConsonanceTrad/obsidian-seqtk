/**
 * CacheDbStore — 缓存数据库字节的持久化载体
 *
 * 将 sql.js 导出的字节（EXPORT_Db）落盘到**用户设置的数据根文件夹**下，
 * 并在启动时读回，使查询缓存跨会话存活，避免每次进入软件都全量重建。
 *
 * 落点：${settings.rootFolder}/${DATABASE_FILE_NAME}
 * - 跟随设置里的 rootFolder，与节点数据同处一棵可整体迁移/备份的目录树
 * - 该文件不是 md、也不在 kind 文件夹内，不会被 FileScan 的节点扫描命中
 *
 * 与 MD 文件的关系：MD 是事实来源，本文件仅是加速用快照，可随时丢弃重建。
 * 因此所有读写失败一律降级（返回 null / 吞掉异常），绝不阻断插件加载。
 */

import type { App } from 'obsidian';
import type { PluginSettings } from '../../../P3_Settings/Settings';
import { DATABASE_FILE_NAME } from '../../../P2_Tools/Const/DefaultPaths';

/** 去掉路径末尾的斜杠，避免与文件名拼出双斜杠 */
function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * 将 Uint8Array 转为可写入的 ArrayBuffer
 *
 * 不能直接用 bytes.buffer：sql.js export() 返回的视图可能带 byteOffset，
 * 直接取底层 buffer 会把视图之外的数据一并写出。必须按视图区间切片。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class CacheDbStore {
  private readonly app: App;
  /** 持 settings 引用而非路径快照：rootFolder 变化时路径随之更新 */
  private readonly settings: PluginSettings;

  /**
   * @param app      Obsidian App
   * @param settings 插件设置（rootFolder 决定缓存库位置）
   */
  constructor(app: App, settings: PluginSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** 缓存数据库文件的 vault 相对路径（每次按当前设置计算） */
  get filePath(): string {
    return `${trimTrailingSlash(this.settings.rootFolder)}/${DATABASE_FILE_NAME}`;
  }

  /** 缓存数据库文件是否已存在 */
  async EXISTS(): Promise<boolean> {
    try {
      return await this.app.vault.adapter.exists(this.filePath);
    } catch {
      return false;
    }
  }

  /**
   * 读取缓存库字节；文件不存在或读取失败返回 null
   * （调用方据此降级为冷启动全量重建）
   */
  async LOAD(): Promise<Uint8Array | null> {
    const path = this.filePath;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const buffer = await adapter.readBinary(path);
      return new Uint8Array(buffer);
    } catch (err) {
      console.warn('[SeqTK] 读取缓存数据库失败，将冷启动重建:', err);
      return null;
    }
  }

  /** 写入缓存库字节（写失败仅告警，不影响会话使用） */
  async SAVE(bytes: Uint8Array): Promise<void> {
    const path = this.filePath;
    try {
      const adapter = this.app.vault.adapter;
      // rootFolder 可能尚未建立（首次使用 / 刚改过设置）
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir && !(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
      }
      await adapter.writeBinary(path, toArrayBuffer(bytes));
    } catch (err) {
      console.warn('[SeqTK] 写入缓存数据库失败:', err);
    }
  }

  /** 删除缓存库文件（供「重建缓存」类手动操作使用） */
  async REMOVE(): Promise<void> {
    const path = this.filePath;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(path)) {
        await adapter.remove(path);
      }
    } catch (err) {
      console.warn('[SeqTK] 删除缓存数据库失败:', err);
    }
  }
}
