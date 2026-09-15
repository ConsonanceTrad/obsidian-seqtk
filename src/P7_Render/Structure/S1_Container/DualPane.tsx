/**
 * S1_Container / DualPane — 双栏骨架（可复用结构）
 *
 * 原 `old/0.1.2/src/views/dual/DualPaneView.ts`（87 行）的 React 版。
 * 原基类承担的「容器创建 / leftEl·rightEl 暴露 / onOpen·onClose / refresh /
 * registerOnClose 清理钩子」在 React 下全部由框架托管，此处只剩结构本身。
 *
 * 纯渲染件：只接收两侧内容，不含任何业务逻辑（见 P7_Render/Render.md）。
 */

import type { ReactNode } from "react";

export interface DualPaneProps {
    /** 左栏内容（窄栏，通常为树或分类） */
    left: ReactNode;
    /** 右栏内容（宽栏，布局自由） */
    right: ReactNode;
}

export function DualPane({ left, right }: DualPaneProps): ReactNode {
    return (
        <div className="seqtk-split">
            <div className="seqtk-split-left">{left}</div>
            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
