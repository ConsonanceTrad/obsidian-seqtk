/**
 * KindChannel — kind → 数据通道 分流策略
 *
 * 缓存通道（需深层关联/查询）：FRAMEWORK（框架）/ AFFAIR（事务）/ EVIDENCE（证据）
 * 文件基准通道（正文承载、无深关联）：SCRIPT（脚本）/ RUNTIME（日志）
 *
 * 供缓存层（建库/扫描范围）与 CoPipe（写意图分流）共同使用；
 * 纯判定，无 obsidian 依赖。
 */

import {GET_CategoryOfNode, NODE_KIND, type NodeCategoryValue, type NodeKindValue} from "../../P4_Nodes/NodeKind/NodeKind";

/** 缓存通道的大类集合 */
const CACHE_CATEGORIES: readonly NodeCategoryValue[] = ['FRAMEWORK', 'AFFAIR', 'EVIDENCE'];

/** 文件基准通道的大类集合 */
const FILE_BASED_CATEGORIES: readonly NodeCategoryValue[] = ['SCRIPT', 'RUNTIME'];

/** kind 是否属缓存通道（框架/事务/证据：需深层关联与查询） */
export const IS_CacheKind = (kind: NodeKindValue): boolean =>
    CACHE_CATEGORIES.includes(GET_CategoryOfNode(kind));

/** kind 是否属文件基准通道（脚本/日志：正文承载、无深关联） */
export const IS_FileBasedKind = (kind: NodeKindValue): boolean =>
    FILE_BASED_CATEGORIES.includes(GET_CategoryOfNode(kind));

/** 缓存通道的全部 kind（供建库/扫描使用） */
export const GET_CacheKinds = (): NodeKindValue[] =>
    (Object.values(NODE_KIND) as NodeKindValue[]).filter(IS_CacheKind);

/** 文件基准通道的全部 kind */
export const GET_FileBasedKinds = (): NodeKindValue[] =>
    (Object.values(NODE_KIND) as NodeKindValue[]).filter(IS_FileBasedKind);
