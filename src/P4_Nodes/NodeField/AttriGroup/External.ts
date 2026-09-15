/**
 * External — 外部信息源字段
 *
 * 「外部信息源」指与节点体系无关、但在语义上支撑该节点的外部材料：
 * 网页链接、库外文件，以及用核心插件（如「唯一笔记」）创建的时间戳文档。
 *
 * 它是**独立的列表字段**，不是从属关系 —— 不从属于任何节点，也不参与树与引导线，
 * 因此与 follows / parent 那一簇互不干扰（用户明确要求「并非从属字段」）。
 */

/** 一条外部信息源 */
export interface ExternalSource {
    /** 展示名（缺省时展示地址或文件名） */
    label: string;
    /** 链接地址（http / https） */
    url?: string;
    /** 库内文件路径（vault 相对路径，如 docs/2026-01-01.md） */
    path?: string;
    /** 加入时间 ISO datetime */
    added?: string;
}

/** 外部信息源字段（并入 NodeBase，对所有节点类型可用） */
export interface ExternalFields {
    /**
     * 外部信息源列表
     *
     * 与「从属字段」（follows / parent）互补：那些描述节点之间的关系，
     * 这个描述节点与**节点体系之外**的材料的关联。
     */
    sources?: ExternalSource[];
}

/**
 * 取一条信息源的展示名：**只取末段名**（文件名 / 链接末段）
 *
 * label 在关联时是整条路径的快照，直接显示会把菜单与悬浮提示占满，而行里要认的
 * 也只是「是哪个文件」。末段名对自定义 label 同样成立（不含分隔符时原样返回）。
 */
export const GET_SourceLabel = (s: ExternalSource): string => {
    const raw = s.label || s.url || s.path || '';
    if (!raw) return '(未命名)';
    const seg = raw.split(/[\\/]/).filter(Boolean).pop();
    return seg || raw;
};

/** 信息源的可跳转目标（url 优先，其次 path） */
export const GET_SourceTarget = (s: ExternalSource): { kind: 'url' | 'path'; value: string } | null => {
    if (s.url) return { kind: 'url', value: s.url };
    if (s.path) return { kind: 'path', value: s.path };
    return null;
};
