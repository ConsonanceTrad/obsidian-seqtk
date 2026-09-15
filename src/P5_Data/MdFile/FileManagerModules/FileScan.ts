/**
 * FileScan — 文件管理器模块组分：批量扫描 / 列举
 *
 * 两种粒度：
 * - 列举（LIST_ByKinds）：只产出「文件条目 + 指纹」，零文件读取，供启动校验对账
 * - 扫描（SCAN_ByKinds / SCAN_AllNodes）：真正读取并解析每个 md 为 NodeFile
 *
 * kind 全集来自 P4_Nodes/NodeKind 的 NODE_KIND；单文件解析复用
 * FileRead.READ_NodeFromFile。两者都只取 kind 文件夹的**直接子文件**（不递归子目录）。
 */

import {Vault, TFile} from 'obsidian';
import type {PluginSettings} from "../../../P3_Settings/Settings";
import {NODE_KIND, type NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import type {NodeFile} from "../../../P4_Nodes/Node";
import {GET_KindToPath, GET_NodeIdByPath} from "../PathTools/PathParse";
import type {FileFingerprint} from "../../FileFingerprint";
import type {FileRead} from "./FileRead";

/**
 * 磁盘文件条目 — 列举阶段产物（不含文件内容）
 *
 * fingerprint 取自 Obsidian 内存 file map（TFile.stat），不产生磁盘 IO。
 */
export interface FileEntry {
    /** 节点 id（文件名去掉 .md） */
    nodeId: string;
    /** 该文件所属 kind（由所在文件夹推断） */
    kind: NodeKindValue;
    /** vault 相对路径 */
    path: string;
    /** 文件系统指纹（mtime + size） */
    fingerprint: FileFingerprint;
}

/**
 * 按路径前缀匹配 kind 文件夹，要求文件必须是该文件夹的直接子文件
 * （与 SCAN_Folder 遍历 folder.children 的语义保持一致）
 */
function matchKindByPath(
    path: string,
    folderPrefix: Map<string, NodeKindValue>,
): NodeKindValue | null {
    for (const [prefix, kind] of folderPrefix) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.length === 0 || rest.includes('/')) continue; // 仅直接子文件
        if (!rest.endsWith('.md')) continue;
        return kind;
    }
    return null;
}

export class FileScan {
    constructor(
        private vault: Vault,
        private settings: PluginSettings,
        private read: FileRead,
    ) {}

    /**
     * 列举指定 kind 文件夹下的节点文件（纯内存，零文件读取）
     *
     * 用作启动校验的对账依据：调用方拿磁盘指纹与缓存中保存的指纹比较，
     * 只有指纹不同的文件才需要进一步读取解析。
     */
    LIST_ByKinds(kinds: NodeKindValue[]): FileEntry[] {
        const folderPrefix = new Map<string, NodeKindValue>();
        for (const kind of kinds) {
            folderPrefix.set(`${GET_KindToPath(kind, this.settings)}/`, kind);
        }

        const entries: FileEntry[] = [];
        for (const file of this.vault.getFiles()) {
            if (file.extension !== 'md') continue;
            const kind = matchKindByPath(file.path, folderPrefix);
            if (!kind) continue;
            const nodeId = GET_NodeIdByPath(file.path);
            if (!nodeId) continue;
            entries.push({
                nodeId,
                kind,
                path: file.path,
                fingerprint: {mtime: file.stat.mtime, size: file.stat.size},
            });
        }
        return entries;
    }

    /**
     * 读取列举出的条目（含 kind 一致性校验）
     *
     * 供启动校验按需解析差异文件；文件在列举后又被删除时返回 null。
     */
    async READ_Entry(entry: FileEntry): Promise<NodeFile | null> {
        const file = this.vault.getFileByPath(entry.path);
        if (!file) return null;
        return this.read.READ_NodeFromFile(file, entry.kind);
    }

    /** 扫描全部 kind 文件夹下的节点文件 */
    async SCAN_AllNodes(): Promise<NodeFile[]> {
        return this.SCAN_ByKinds(Object.values(NODE_KIND) as NodeKindValue[]);
    }

    /** 按指定 kind 集合扫描对应文件夹（缓存层仅扫缓存 kind 时使用） */
    async SCAN_ByKinds(kinds: NodeKindValue[]): Promise<NodeFile[]> {
        const results = await Promise.all(kinds.map(kind => this.SCAN_Folder(kind)));
        return results.flat();
    }

    /** 扫描单个 kind 文件夹 */
    private async SCAN_Folder(kind: NodeKindValue): Promise<NodeFile[]> {
        const folder = this.vault.getFolderByPath(GET_KindToPath(kind, this.settings));
        if (!folder) return [];

        const nodes: NodeFile[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                const nodeFile = await this.read.READ_NodeFromFile(child, kind);
                if (nodeFile) {
                    nodes.push(nodeFile);
                }
            }
        }
        return nodes;
    }

    /** settings 替换时同步（由门面 NodeFileManager 统一调用） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
