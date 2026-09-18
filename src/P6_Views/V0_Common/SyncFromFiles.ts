/**
 * V0_Common/SyncFromFiles — 「从磁盘刷新」这一项菜单动作的共同实现
 *
 * 实现只此一处：事务设计与模板模式的空白右键菜单都指向它。
 * 「缓存未就绪就不刷」「刷完给一句回执」这两件事不该各写一份 ——
 * 否则提示文案与判据迟早漂移。
 *
 * 数据面本身仍是 `DataPipe.SYNC_FromFiles()`（按指纹与磁盘对账活跃缓存），
 * 本文件只补界面语义（提示与回执），不碰任何视图状态。
 */

import { Notice } from 'obsidian';
import type { DataPipe } from '../../P5_Data/CoPipe/DataPipe';

export async function SYNC_FromFiles(pipe: DataPipe): Promise<void> {
    if (!pipe.isInitialized) {
        new Notice('查询缓存尚未就绪，请稍候');
        return;
    }
    await pipe.SYNC_FromFiles();
    new Notice('已从磁盘刷新');
}
