import type {PluginSettings} from "../../../P3_Settings/Settings";
import {GET_CategoryOfNode, IS_NodeKind, type NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";

/** 从合法路径中提取节点类型（路径须形如 `${rootFolder}/${大类}/${kind}/…`） */
export const GET_PathToKind = (path: string, setting: PluginSettings): NodeKindValue | null => {
    const prefix = setting.rootFolder.endsWith('/') ? setting.rootFolder : `${setting.rootFolder}/`;
    if (!path.startsWith(prefix)) {
        return null; // 或 throw new Error(...)
    }
    const [category, kind] = path.slice(prefix.length).split('/');
    if (!kind || !IS_NodeKind(kind)) return null;
    if (GET_CategoryOfNode(kind) !== category) return null;
    return kind;
};

/**
 * 判断文件路径是否属于本插件管理的节点文件
 */
export function IS_ManagedPath(filePath: string, setting: PluginSettings): boolean {
    if (!filePath.endsWith('.md')) return false;
    return GET_PathToKind(filePath, setting) !== null;
}

