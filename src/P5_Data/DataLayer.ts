/**
 * DataLayer — Data 层组装入口
 *
 * 将 NodeFileManager 容器（FileManagerModules）、NodeCache（SQLite 缓存）、
 * OperationQueue（双队列）与 DataPipe（统一通道门面）组装为单一对象，
 * 供装配层（P1_Register/Load_Core）一行接入。Data 层对外的唯一组装点。
 */

import {App} from 'obsidian';
import type {PluginSettings} from '../P3_Settings/Settings';
import {NodeFileManager} from './MdFile/NodeFileManager';
import {NodeCache} from './SQLite/Cache/NodeCache';
import {OperationQueue} from './Queue/OperationQueue';
import {DataPipe} from './CoPipe/DataPipe';

/** Data 层组装结果 */
export interface DataLayer {
    fileManager: NodeFileManager;
    cache: NodeCache;
    queue: OperationQueue;
    pipe: DataPipe;
}

/** 组装 Data 层（需在 Load_Setting 之后调用） */
export function CREATE_DataLayer(app: App, settings: PluginSettings): DataLayer {
    const fileManager = new NodeFileManager(app, settings);
    const cache = new NodeCache();
    const queue = new OperationQueue();
    const pipe = new DataPipe({fileManager, cache, queue, settings});
    return {fileManager, cache, queue, pipe};
}
