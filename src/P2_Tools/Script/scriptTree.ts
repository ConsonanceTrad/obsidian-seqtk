/**
 * scriptTree — 脚本树构建（纯函数；全部脚本类型通用）
 *
 * 脚本分组（参考模板框架的口径）：脚本节点用 `parent` 归属**同类脚本**形成层级 ——
 * 有同类子节点的是**分组**（归类容器，徽章显示「分组」），叶子是**脚本实体**
 * （正文承载内容）。一个节点要么当分类目录、要么当脚本，不混用。
 *
 * 为什么在这里组装父子而不是查缓存：脚本属**文件基准通道**（KindChannel），
 * 根本不进缓存，`GET_Children` 对脚本恒为空 —— 关系只能从扫描结果的 `parent` 字段来。
 */

/** 树构建的输入（扫描结果的一项） */
export interface ScriptTreeSource {
    nodeId: string;
    kind: string;
    desc: string;
    /** 父脚本 nodeId（空 / 缺 = 根级） */
    parent?: string;
}

/** 树节点 */
export interface ScriptTreeNode {
    nodeId: string;
    kind: string;
    desc: string;
    /** 分组（有同类子脚本）：徽章文本用 SCRIPT_GROUP_LABEL */
    isGroup: boolean;
    children: ScriptTreeNode[];
}

/** 分组节点的徽章文本（替代类型名，一眼看出这是分类目录） */
export const SCRIPT_GROUP_LABEL = '分组';

/**
 * 扫描结果 → 脚本树
 *
 * - `parent` 指向同类脚本才收作子级；指向别处（或谁也不是）的按根级处理
 * - `isGroup` = 有同类子节点
 * - 防环：parent 链成环的节点各自断开为根级，不会把构建挂死
 */
export function BUILD_ScriptTree(items: ScriptTreeSource[]): ScriptTreeNode[] {
    const byId = new Map<string, ScriptTreeNode>();
    const order: ScriptTreeNode[] = [];
    for (const it of items) {
        const node: ScriptTreeNode = {
            nodeId: it.nodeId,
            kind: it.kind,
            desc: it.desc,
            isGroup: false,
            children: [],
        };
        byId.set(node.nodeId, node);
        order.push(node);
    }

    const roots: ScriptTreeNode[] = [];
    /** 挂接时沿祖先链防环：碰上自己就是环，退化为根级 */
    const isAncestorOf = (maybeAncestor: string, nodeId: string): boolean => {
        let cur = byId.get(nodeId);
        const seen = new Set<string>();
        while (cur) {
            if (cur.nodeId === maybeAncestor) return true;
            const parentOf = items.find((i) => i.nodeId === cur!.nodeId)?.parent;
            if (!parentOf || seen.has(parentOf)) return false;
            seen.add(parentOf);
            cur = byId.get(parentOf);
        }
        return false;
    };

    for (const it of items) {
        const node = byId.get(it.nodeId)!;
        const parentId = it.parent ?? '';
        const parent = parentId ? byId.get(parentId) : undefined;
        // 同类才算分组层级：查询脚本的分组只装查询脚本，各归各的树
        if (parent && parent.kind === it.kind && !isAncestorOf(it.nodeId, parentId)) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    for (const node of byId.values()) {
        node.isGroup = node.children.some((c) => c.kind === node.kind);
    }
    return roots;
}
