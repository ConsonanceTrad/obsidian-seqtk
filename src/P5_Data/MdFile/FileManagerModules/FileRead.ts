/**
 * FileRead — 文件管理器模块组分：读取
 *
 * 单文件按 kind + nodeId 定位并解析（frontmatter + body 拆分为 NodeFile）；
 * 文件路径计算统一走 ../PathTools/PathParse.ts（rootFolder/大类/kind 两级布局）。
 * 批量扫描见 FileScan.ts（复用本模块的 READ_NodeFromFile 做单文件解析）。
 */

import {Vault, type TFile} from 'obsidian';
import type {PluginSettings} from "../../../P3_Settings/Settings";
import type {NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import type {NodeFile, SeqtkNode} from "../../../P4_Nodes/Node";
import {parseNodeFile, validateKindConsistency} from "../../../P2_Tools/Parse/YamlParse";
import {GET_FileByPath, GET_NodeIdByPath} from "../PathTools/PathParse";

export class FileRead {
    constructor(
        private vault: Vault,
        private settings: PluginSettings,
    ) {}

    /**
     * 按 kind + nodeId 读取节点文件
     * （仅解析，不做 kind 校验；不存在或解析失败返回 null）
     */
    async READ_Node(kind: NodeKindValue, nodeId: string): Promise<NodeFile | null> {
        const file = this.vault.getFileByPath(GET_FileByPath(kind, nodeId, this.settings));
        if (!file) return null;

        try {
            const content = await this.vault.read(file);
            const { data, body } = parseNodeFile(content);
            return {
                nodeId,
                data: data as unknown as SeqtkNode,
                body,
            };
        } catch (err) {
            console.error(`[SeqTK] Failed to read node ${nodeId}:`, err);
            return null;
        }
    }

    /**
     * 从 TFile 读取并校验 kind（供 FileScan 扫描目录内 md 时逐文件调用）
     */
    async READ_NodeFromFile(file: TFile, expectedKind: NodeKindValue): Promise<NodeFile | null> {
        try {
            const content = await this.vault.read(file);
            const { data, body } = parseNodeFile(content);

            if (!validateKindConsistency(data, expectedKind)) {
                console.warn(
                    `[SeqTK] Kind mismatch in ${file.path}: ` +
                    `expected "${expectedKind}" but got "${data.kind}". Skipping.`
                );
                return null;
            }

            data.kind = expectedKind;

            const nodeId = GET_NodeIdByPath(file.path);
            if (!nodeId) return null;

            return {
                nodeId,
                data: data as unknown as SeqtkNode,
                body,
            };
        } catch (err) {
            console.error(`[SeqTK] Failed to read file ${file.path}:`, err);
            return null;
        }
    }

    /** settings 替换时同步（由门面 NodeFileManager 统一调用） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
