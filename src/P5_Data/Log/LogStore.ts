/**
 * LogStore — RUNTIME 日志节点的写入编排
 *
 * 按日聚合、追加式流水：同一天的条目进同一个节点文件
 * （如 `RUNTIME_FLOW_LOG-20260926.md`），文件即当天日志。
 *
 * 通道口径：RUNTIME 属**文件基准通道**（见 CoPipe/KindChannel），不进 SQLite 缓存
 * —— 日志条目量可预见地不小，进缓存只会拖累真正的查询面；读日志走 SCAN_Files 扫盘。
 *
 * 保序：APPEND 把写入串在一条 Promise 链上，同一时刻多条日志排队读-改-写，
 * 不会互相覆盖。刻意不走 OperationQueue —— 那是节点数据的写入闸门
 * （缓存未验证时拒写并提示），日志是审计流水，被闸门拒掉反而丢记录。
 */

import type { NodeFileManager } from "../MdFile/NodeFileManager";
import type { NodeRuntimeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import {
    logDateKey,
    logDateLabel,
    logNodeId,
    nowLogTime,
    serializeLogLine,
} from "../../P2_Tools/Parse/LogLine";

export class LogStore {
    /** 写入链：串行化读-改-写 */
    private chain: Promise<void> = Promise.resolve();

    constructor(private fileManager: NodeFileManager) {}

    /** 追加一条日志（排队写入，不等待落盘；失败仅记控制台，不影响业务动作） */
    APPEND(kind: NodeRuntimeKindValue, text: string): void {
        this.chain = this.chain.then(() => this.writeOne(kind, text)).catch((e) => {
            console.error('[SeqTK] 日志写入失败:', e);
        });
    }

    /** 单条写入：当天文件不存在则创建，存在则往正文追加一行 */
    private async writeOne(kind: NodeRuntimeKindValue, text: string): Promise<void> {
        const now = new Date();
        const dateKey = logDateKey(now);
        const nodeId = logNodeId(kind, dateKey);
        const line = serializeLogLine({ time: nowLogTime(now), text });

        const existing = await this.fileManager.read.READ_Node(kind, nodeId);
        if (!existing) {
            await this.fileManager.write.CREATE_Node(
                kind,
                { kind, desc: logDateLabel(dateKey) },
                line,
                nodeId,
            );
            return;
        }

        const base = existing.body.trimEnd();
        const body = base ? `${base}\n${line}` : line;
        await this.fileManager.update.UPDATE_NodeBody(kind, nodeId, body);
    }
}
