import type {NodeKindValue} from "./NodeKind/NodeKind";
import type {ExternalFields} from "./NodeField/AttriGroup/External";
import type {MeaningFields} from "./NodeField/AttriGroup/Meaning";
import type {RouteFields} from "./NodeField/AttriGroup/Route";
import type {AffairNode} from "./NodePack/AffairNode";
import type {FrameworkNode} from "./NodePack/FrameworkNode";
import type {RuntimeNode} from "./NodePack/RuntimeNode";
import type {EvidenceNode} from "./NodePack/EvidenceNode";
import type {ScriptNode} from "./NodePack/ScriptNode";

/**
 * 所有节点共有的基础字段
 *
 * 并入三簇「各类型都可能带」的**可选**字段：
 * - ExternalFields：外部信息源（见 NodeField/AttriGroup/External）
 * - MeaningFields：表意标注 —— clear / tags / indicators / pmarks（见 NodeField/AttriGroup/Meaning）
 * - RouteFields：线路关联 —— 只在框架之间用（见 NodeField/AttriGroup/Route）
 * 全都是可选字段，因此并入基类不替任何类型做「必填」决定，各类型仍可自行收窄。
 */
export interface NodeBase extends ExternalFields, MeaningFields, RouteFields {
    /** 节点类型 */
    kind: NodeKindValue;
    /** 节点展示名（用户自行输入） */
    desc: string;
    /** 节点启用/禁用状态 */
    open: boolean;
    /** 添加来源（脚本、模板、补全等非手动创建时记录） */
    from?: string;
    /** 创建时间 ISO datetime */
    create: string;
    /** 最后修改时间 ISO datetime */
    modify: string;
}
/** 类型组合 */
export type SeqtkNode =
    | FrameworkNode
    | AffairNode
    | EvidenceNode
    | RuntimeNode
    | ScriptNode;


/** 节点文件包装类型 — 包含 nodeId、frontmatter 数据和 Markdown body */
export interface NodeFile<T extends NodeBase = SeqtkNode> {
    /** 节点唯一标识（也是文件名，不含 .md） */
    nodeId: string;
    /** YAML frontmatter 中的节点数据 */
    data: T;
    /** Markdown body 内容（frontmatter 之后的部分） */
    body: string;
}
