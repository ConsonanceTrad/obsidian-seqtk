/**
 * Route — 线路关联字段
 *
 * 「线路」指两个框架之间的**有向**关联：源 → 目标，外加一句描述说明「为什么有关联」。
 * 它与 follows 语义不同，故各用一个字段：
 * - follows 描述**从属**（谁包含谁），决定树形与引导线
 * - routes 描述**顺序与因果**（谁在谁之前、谁的产出供给了谁），不参与树形 ——
 *   线路图的价值正在长链上：两个框架之间没有直接边，但那条路径本身就是那层隐性关联
 *
 * 存法**刻意与 follows 一致**：只由**源侧**记录（源 → 目标单向），目标侧不写反向字段 ——
 * 「一条边只写一处」，不会出现两侧不一致。反向查询（谁指向我）由缓存层用同一个关系表
 * 反查（见 NodeCache 的 GET_RouteIncoming / GET_RouteOutgoing）。
 *
 * 字段落在 frontmatter 里，所以线路图随笔记文件走：换机器、看 git diff、手工编辑都成立。
 * 这一条是修正的产物 —— 早期版本只把连线放在内存与 SQLite 里，重启即丢；
 * 现在 routes 是权威来源，SQLite 的 route 关系由它重建（见 SqliteCache 的 UPSERT_Node）。
 */

/** 一条线路关联（源节点 → toId） */
export interface RouteRef {
    /** 目标框架的 nodeId */
    toId: string;
    /** 关联描述：这两个框架为什么有关联（允许留空 ——「还没想好」是常见状态） */
    desc?: string;
}

/** 线路关联字段（并入 NodeBase；实际只有框架类节点会用到） */
export interface RouteFields {
    routes?: RouteRef[];
}
