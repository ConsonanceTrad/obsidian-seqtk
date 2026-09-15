/**
 * FileToView — 文件基准读取（方向：文件 → 视图）
 *
 * 文件基准 kind（脚本/日志）以文件为渲染基准：
 * 视图经此读取 NodeFile（frontmatter + body），不经缓存。
 */

import type { NodeFileManager } from '../../MdFile/NodeFileManager';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeFile } from '../../../P4_Nodes/Node';

/** 读取文件基准节点的文件内容（含正文；不存在返回 null） */
export function READ_FileView(file: NodeFileManager, kind: NodeKindValue, nodeId: string): Promise<NodeFile | null> {
    return file.read.READ_Node(kind, nodeId);
}
