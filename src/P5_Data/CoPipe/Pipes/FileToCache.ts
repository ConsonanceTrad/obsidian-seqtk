/**
 * FileToCache — 文件 → 缓存 回填（方向：文件 → 缓存）
 *
 * 供一致性校验（SYNC，仅活跃缓存）与文件事件回填（APPLY）使用；
 * 事件回填由装配层（Event）针对缓存 kind 的 vault 变化调用。
 * 弃置缓存由 ARCHIVE_Refresh 单独全量更新，不经此通道。
 */

import type { NodeFileManager } from '../../MdFile/NodeFileManager';
import type { NodeCache } from '../../SQLite/Cache/NodeCache';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';

/** 一致性校验：磁盘与活跃缓存对账修复（cache.VERIFY_WithDisk；弃置缓存不主动校验） */
export function SYNC_CacheFromFiles(cache: NodeCache, file: NodeFileManager): Promise<boolean> {
    return cache.VERIFY_WithDisk(file);
}

/** 单文件变化回填活跃缓存（create/modify → 读文件后 ADD；delete → REMOVE） */
export async function APPLY_FileToCache(
    cache: NodeCache,
    file: NodeFileManager,
    kind: NodeKindValue,
    nodeId: string,
    action: 'create' | 'modify' | 'delete',
): Promise<void> {
    if (action === 'delete') {
        cache.REMOVE_Node(nodeId);
        return;
    }
    const nf = await file.read.READ_Node(kind, nodeId);
    if (nf) {
        cache.ADD_Node(nodeId, nf.data, nf.body);
    }
}
