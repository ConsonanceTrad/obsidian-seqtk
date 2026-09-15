/**
 * ViewToFile — 文件基准直写执行（方向：视图 → 文件）
 *
 * 文件基准 kind（脚本/日志：正文承载、无深关联）不经过缓存，
 * 渲染与读写基准均为源文件：本模块立即执行文件侧写回（不经慢序列，
 * 由调用方视频率决定是否需要防抖——Pipe 门面对文件基准也走 FileQueue 防抖）。
 */

import type { NodeFileManager } from '../../MdFile/NodeFileManager';
import type { Mutation } from './ViewToCache';
import { BUILD_FileSide } from './CacheToFile';

/** 文件基准通道：直接对源文件执行写意图 */
export function EXEC_FileDirect(file: NodeFileManager, m: Mutation): Promise<void> {
    return BUILD_FileSide(m)(file);
}
