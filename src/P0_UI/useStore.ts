/**
 * useStore — SimpleStore 到 React 的订阅桥
 *
 * useSyncExternalStore 要求的 (subscribe, getSnapshot) 与 SimpleStore 的
 * (subscribe, get) 签名天然对齐，因此无需引入任何状态管理库。
 *
 * 注意：getSnapshot 返回的引用必须稳定，否则会无限重渲染。
 * SimpleStore 仅在 set / update 时替换值引用，满足该要求；
 * 若在组件内对快照做派生（如 map / filter / sort），请自行 useMemo 包裹。
 */

import { useSyncExternalStore } from "react";
import type { SimpleStore } from "../P5_Data/Svelte/SimpleStore";

/** 订阅 SimpleStore，返回其当前值；store 变更时组件自动重渲染 */
export function useStore<T>(store: SimpleStore<T>): T {
    return useSyncExternalStore(
        (onStoreChange) => store.subscribe(onStoreChange),
        () => store.get(),
    );
}
