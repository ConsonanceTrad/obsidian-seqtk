/**
 * FileUpdate — 文件管理器模块组分：原子更新
 *
 * 对已存在节点文件做 frontmatter 或正文的读改写，统一走 vault.process 原子操作。
 */

import {Vault} from 'obsidian';
import type {PluginSettings} from "../../../P3_Settings/Settings";
import type {NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import type {SeqtkNode} from "../../../P4_Nodes/Node";
import {parseNodeFile, serializeNodeFile} from "../../../P2_Tools/Parse/YamlParse";
import {GET_FileByPath} from "../PathTools/PathParse";

export class FileUpdate {
    constructor(
        private vault: Vault,
        private settings: PluginSettings,
    ) {}

    /** 获取文件句柄；不存在时记录错误并返回 null */
    private GET_NodeFile(kind: NodeKindValue, nodeId: string) {
        const filePath = GET_FileByPath(kind, nodeId, this.settings);
        const file = this.vault.getFileByPath(filePath);
        if (!file) {
            console.error(`[SeqTK] Node file not found: ${filePath}`);
            return null;
        }
        return file;
    }

    /** 更新节点 frontmatter 字段（undefined 值表示删除该键，支持清空可选字段） */
    async UPDATE_Node(
        kind: NodeKindValue,
        nodeId: string,
        updates: Partial<SeqtkNode>,
    ): Promise<void> {
        const file = this.GET_NodeFile(kind, nodeId);
        if (!file) return;

        await this.vault.process(file, (content: string) => {
            const { data, body } = parseNodeFile(content);
            for (const [k, v] of Object.entries(updates)) {
                if (v === undefined) {
                    delete (data as any)[k];
                } else {
                    (data as any)[k] = v;
                }
            }
            data.modify = new Date().toISOString();
            return serializeNodeFile(data, body);
        });
    }

    /** 更新节点正文（body），frontmatter 保留并刷新 modify */
    async UPDATE_NodeBody(kind: NodeKindValue, nodeId: string, body: string): Promise<void> {
        const file = this.GET_NodeFile(kind, nodeId);
        if (!file) return;

        await this.vault.process(file, (content: string) => {
            const { data } = parseNodeFile(content);
            data.modify = new Date().toISOString();
            return serializeNodeFile(data, body);
        });
    }

    /** settings 替换时同步（由门面 NodeFileManager 统一调用） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
