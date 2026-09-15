/**
 * CanvasBoardHost — CanvasBoard 的 React 承载层
 *
 * CanvasBoard 基于 cytoscape（命令式库），其生命周期与画布操作
 * （cy / setLinkingMode / positionNode / destroy）不适合声明式表达。
 * 因此这里 **只负责提供 DOM 容器**，board 实例的创建与销毁仍由视图类持有
 * （在容器就绪 / 卸载回调里 new / destroy）——与 S2_Modal 对 Modal 的处理同一思路：
 * 命令式资源不进 React 渲染树，边界反而更清晰（见 P7_Render/Render.md）。
 *
 * 用法（视图类内）：
 *   renderPanel() → createElement(CanvasBoardHost, {
 *       onContainerReady: (el) => { this.board = new CanvasBoard(el, {...}); void this.board.init(...); },
 *       onContainerDispose: () => { this.board?.destroy(); this.board = null; },
 *       onContextMenu: (e) => this.handleBlankContextMenu(e),   // 空白处右键
 *   })
 */

import { useEffect, useRef, type MouseEvent } from "react";

export interface CanvasBoardHostProps {
    /** 容器就绪时调用一次：在此 new CanvasBoard 并 init */
    onContainerReady: (container: HTMLDivElement) => void;
    /** 容器卸载前调用一次：在此 board.destroy() */
    onContainerDispose?: () => void;
    /**
     * 容器上的 contextmenu —— 供「白板空白处右键」使用。
     * 节点上的右键由 cytoscape 自身（cxttap）处理，两者由调用方按
     * 「事件目标是否在 canvas 内」与时间戳区分。
     */
    onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CanvasBoardHost({ onContainerReady, onContainerDispose, onContextMenu }: CanvasBoardHostProps) {
    const ref = useRef<HTMLDivElement>(null);

    // 回调存入 ref：挂载 effect 只跑一次，但始终调用最新的回调
    const readyRef = useRef(onContainerReady);
    const disposeRef = useRef(onContainerDispose);
    readyRef.current = onContainerReady;
    disposeRef.current = onContainerDispose;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        readyRef.current(el);
        return () => {
            disposeRef.current?.();
        };
    }, []);

    return <div className="seqtk-board" ref={ref} onContextMenu={onContextMenu} />;
}
