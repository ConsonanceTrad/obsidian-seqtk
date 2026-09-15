import type SeqtkPlugin from "../main";
import {TFile} from "obsidian";
import {GET_PathToKind} from "../P5_Data/MdFile/PathTools/KindJudge";
import {GET_NodeIdByPath} from "../P5_Data/MdFile/PathTools/PathParse";
import {IS_FileBasedKind} from "../P5_Data/CoPipe/KindChannel";
import type {NodeKindValue} from "../P4_Nodes/NodeKind/NodeKind";

/** 文件基准变化订阅回调（脚本/日志：以文件为渲染基准的视图据此刷新） */
type FileChangeListener = (kind: NodeKindValue, nodeId: string, action: 'create' | 'modify' | 'delete') => void;

export class EventP {
    /** 文件基准 kind 变化订阅者 */
    private fileListeners = new Set<FileChangeListener>();

    /**
     * 订阅文件基准 kind（脚本/日志）的文件变化
     * @returns 取消订阅函数
     */
    SUB_FileChange(cb: FileChangeListener): () => void {
        this.fileListeners.add(cb);
        return () => this.fileListeners.delete(cb);
    }

    /**
     * 注册 vault 事件 — 仅关注文件基准 kind（脚本/日志）：
     * 此类视图直接读写文件作为渲染基准，需感知文件变化；缓存 kind 的
     * 一致性由 Pipe 双通道维护，不在此监听。
     * 自触发抑制：DataPipe 写回中的路径（IS_Pending）被忽略，防回环。
     */
    Register_Event(p: SeqtkPlugin) {
        p.registerEvent(p.app.vault.on('create', (file) => this.onFileChange(file, 'create', p)));
        p.registerEvent(p.app.vault.on('modify', (file) => this.onFileChange(file, 'modify', p)));
        p.registerEvent(p.app.vault.on('delete', (file) => this.onFileChange(file, 'delete', p)));
        p.registerEvent(p.app.vault.on('rename', (file, oldPath) => this.onFileRename(file, oldPath, p)));
    }

    private onFileChange(file: unknown, action: 'create' | 'modify' | 'delete', p: SeqtkPlugin): void {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (p.dataPipe?.IS_Pending(file.path)) return; // 自触发抑制
        const kind = GET_PathToKind(file.path, p.settings);
        if (!kind || !IS_FileBasedKind(kind)) return;
        const nodeId = GET_NodeIdByPath(file.path);
        if (!nodeId) return;
        for (const cb of this.fileListeners) cb(kind, nodeId, action);
    }

    /** 重命名（文件名即 nodeId）视为 旧 id 删除 + 新 id 创建 */
    private onFileRename(file: unknown, oldPath: string, p: SeqtkPlugin): void {
        if (!(file instanceof TFile)) return;
        const oldKind = GET_PathToKind(oldPath, p.settings);
        const oldId = GET_NodeIdByPath(oldPath);
        if (oldKind && oldId && IS_FileBasedKind(oldKind)) {
            for (const cb of this.fileListeners) cb(oldKind, oldId, 'delete');
        }
        this.onFileChange(file, 'create', p);
    }
}
