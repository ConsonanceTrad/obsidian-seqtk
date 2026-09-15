
/** 默认根文件夹路径 */
export const DEFAULT_ROOT_FOLDER = '_Root/_Plugin/SeqTK';

/**
 * 缓存数据库文件名 —— 位于**用户设置的数据根文件夹**下：
 *   ${settings.rootFolder}/${DATABASE_FILE_NAME}
 * 具体路径由 P5_Data/SQLite/Cache/CacheDbStore.ts 按当前设置计算（故不在此硬编码）。
 *
 * 该文件既不是 md、也不在 kind 文件夹内，不会被 FileScan 的节点扫描命中。
 */
export const DATABASE_FILE_NAME = "DATABASE";

