/**
 * PathParse — 节点路径纯工具（PathTools）
 *
 * 全部函数均为纯计算、显式接收 settings/路径参数（无 this、无 obsidian 依赖），
 * 供 FileManagerModules 各模块与装配层复用。
 *
 * 布局约定：rootFolder / 大类 / 细分类 两级 ——
 *   folder: GET_KindToPath(kind, settings)           → ${rootFolder}/${大类}/${kind}
 *   file:   GET_FileByPath(kind, nodeId, settings) → ${folder}/${nodeId}.md
 * （大类 = GET_CategoryOfNode(kind)，如 AFFAIR；细分类 kind 如 AFFAIR_CONCEPT；反查见 KindJudge.ts）
 */

import {GET_CategoryOfNode, type NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import type { PluginSettings } from "../../../P3_Settings/Settings";

/** 规范化拼接路径 */
function joinPath(prefix: string, suffix: string): string {
    const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const s = suffix.startsWith('/') ? suffix.slice(1) : suffix;
    return `${p}/${s}`;
}

/** kind 文件夹完整路径（rootFolder/大类/kind），如 `${rootFolder}/AFFAIR/AFFAIR_CONCEPT` */
export const GET_KindToPath = (kind: NodeKindValue, setting: PluginSettings): string =>
    joinPath(joinPath(setting.rootFolder, GET_CategoryOfNode(kind)), kind);

/** kind 节点文件完整路径（rootFolder/大类/kind/${nodeId}.md） */
export const GET_FileByPath = (kind: NodeKindValue, nodeId: string, setting: PluginSettings): string =>
    `${GET_KindToPath(kind, setting)}/${nodeId}.md`;

/** 从文件路径提取 nodeId（文件名不含 .md） */
export function GET_NodeIdByPath(filePath: string): string | null {
    const match = filePath.match(/\/([^/]+)\.md$/);
    return match ? match[1] : null;
}
