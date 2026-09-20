/**
 * Special/Delegate/delegateDebugLog — 委托调试日志（临时设施）
 *
 * 为什么需要它：定位「委托记忆没生效」时，关键的一段是**关库时** `onunload` 的行为，
 * 而 Obsidian 关库会清空控制台 —— console.log 写的东西读不到。所以把同一份日志再写进
 * 库内一个文件：关库、重开后文件还在，跨会话能看全。
 *
 * **这是临时调试设施，问题定位完就该连同各处调用一起删掉**（搜索 `LOG_Debug` 即可找全）。
 * 之所以单独放一个文件而不是散在各处，就是为了删的时候只有一处实现要处理。
 */

import type { App } from 'obsidian';

/** 日志文件（相对库根；放库根是为了在文件列表里一眼看到） */
const LOG_PATH = 'seqtk-委托调试.log';

let sink: ((line: string) => void) | null = null;

/** 值的可读描述：对象转 JSON，失败时退回 String（避免循环引用把日志本身搞崩） */
function describe(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v) ?? String(v);
    } catch {
        return String(v);
    }
}

/**
 * 初始化（main.onload 最早处调用一次）
 *
 * 注入写文件的能力 —— 本模块不该自己去拿 app，那样会引一层依赖回来。
 */
export function INIT_DebugLog(app: App): void {
    sink = (line: string): void => {
        void app.vault.adapter.append(LOG_PATH, line);
    };
    LOG_Debug('=== 插件 onload ===');
}

/** 记一条调试日志：同时进控制台与库内文件 */
export function LOG_Debug(msg: string, ...args: unknown[]): void {
    console.log('[SeqTK][委托调试]', msg, ...args);
    if (!sink) return;
    const detail = args.length > 0 ? ` ${args.map(describe).join(' ')}` : '';
    sink(`[${new Date().toISOString()}] ${msg}${detail}\n`);
}

/** 取日志文件的库内路径（供用户/排查时引用） */
export const DEBUG_LOG_PATH = LOG_PATH;
