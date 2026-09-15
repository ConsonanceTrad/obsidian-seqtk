import type SeqtkPlugin from "../main";
import {sqlWasmBinary} from "../P5_Data/SQLite/Core/sqlWasm";

/**
 * onload：初始化 sql.js 运行时 + 加载持久化缓存（不扫描磁盘）
 *
 * 命中持久化缓存时缓存立即可读（视图秒开），但尚未与磁盘对账：
 * 写入闸门保持关闭，直到 Check_Cache_Data 完成。
 * 未命中 / 字节不可用（损坏、schema 版本不符）则保持空库，由 Check_Cache_Data 全量填充。
 */
export async function Load_Cache_Data(p: SeqtkPlugin): Promise<void> {
    // 初始化活跃缓存 sql.js 运行时（wasm 字节已构建期内联）
    await p.nodeCache.INIT_Sql(sqlWasmBinary);

    const bytes = await p.cacheDbStore.LOAD();
    if (!bytes) return;

    try {
        p.nodeCache.LOAD_ActiveDb(bytes);
    } catch (err) {
        console.warn('[SeqTK] 缓存数据库不可用，将全量重建:', err);
    }
}

/**
 * onReady：与磁盘对账 → 打开写入闸门 → 落盘一次
 *
 * 对账为指纹驱动：只读取解析新增 / 变化的文件，指纹一致者完全不碰。
 * （弃置缓存不主动校验，由回收视图打开时的 ARCHIVE_Refresh 全量更新。）
 */
export async function Check_Cache_Data(p: SeqtkPlugin): Promise<void> {
    await p.dataPipe.SYNC_FromFiles();
    await SAVE_Cache_Data(p);
}

/**
 * 导出活跃缓存并落盘
 *
 * 仅在「已与磁盘对账完成」后写入：对账前缓存可能落后于磁盘，落盘会把未校验的
 * 快照固化成下次启动的基准，反而更糟。未对账时直接跳过（下次对账后仍会落盘）。
 */
export async function SAVE_Cache_Data(p: SeqtkPlugin): Promise<void> {
    if (!p.nodeCache?.isVerified) return;
    try {
        await p.cacheDbStore.SAVE(p.nodeCache.EXPORT_ActiveDb());
    } catch (err) {
        console.warn('[SeqTK] 保存缓存数据库失败:', err);
    }
}

/**
 * 手动重建缓存 — 丢弃持久化文件 + 清空内存库 + 全量重扫 + 落盘
 *
 * 日常启动走「onload 加载 + onReady 指纹对账」，无需重建；本入口是兜底手段，
 * 用于缓存疑似失配（如指纹不可靠导致漏更新）或想强制全量刷新时。
 *
 * @returns 重建后的活跃缓存节点数
 */
export async function REBUILD_Cache_Data(p: SeqtkPlugin): Promise<number> {
    // 先丢弃持久化文件：重建中途失败时，下次启动不会加载到半成品
    await p.cacheDbStore.REMOVE();

    // 清空内存库并关闸：库空 ⇒ 所有文件指纹都「未知」⇒ 对账逐个重读
    p.nodeCache.RESET_Active();

    try {
        await p.dataPipe.SYNC_FromFiles();
    } catch (err) {
        // 重建失败也必须恢复写入能力，避免插件卡死在只读态
        p.nodeCache.MARK_Verified();
        throw err;
    }

    await SAVE_Cache_Data(p);
    return p.nodeCache.size;
}
