/**
 * FileFingerprint — 文件系统指纹
 *
 * 判断「磁盘文件相对缓存是否发生变化」的最小依据：文件系统 mtime + 字节数。
 * 二者都取自 Obsidian 内存中的 file map（TFile.stat），比较时不产生磁盘 IO，
 * 因此可以在启动校验中低成本地跳过绝大多数未变化的文件。
 *
 * 与 frontmatter 里的 modify/created_at 无关：那是业务字段，本类型只描述
 * 文件本身的元数据。
 *
 * 保守语义：任一侧缺失（旧缓存库补列后为 NULL、或文件刚落地尚无 stat）即视为
 * 「未知 → 需要重读」，宁可多读一次，不可漏更新。
 */

/** 文件系统指纹 */
export interface FileFingerprint {
  /** 文件系统最后修改时间（毫秒时间戳） */
  mtime: number;
  /** 文件字节数 */
  size: number;
}

/** 两个指纹是否一致（任一缺失视为不一致，即需要重读） */
export function IS_SameFingerprint(
  a: FileFingerprint | undefined,
  b: FileFingerprint | undefined,
): boolean {
  if (!a || !b) return false;
  return a.mtime === b.mtime && a.size === b.size;
}
