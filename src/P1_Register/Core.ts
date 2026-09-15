import type SeqtkPlugin from "../main";
import {CREATE_DataLayer} from "../P5_Data/DataLayer";

export function Load_Core(p: SeqtkPlugin) {
    // 组装 Data 层（fileManager / cache / queue / pipe），挂载到插件载体
    const layer = CREATE_DataLayer(p.app, p.settings);
    p.fileManager = layer.fileManager;
    p.nodeCache = layer.cache;
    p.operationQueue = layer.queue;
    p.dataPipe = layer.pipe;
}
