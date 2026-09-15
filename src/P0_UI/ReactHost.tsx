/**
 * ReactHost — React 与 Obsidian 视图之间的挂载层
 *
 * 职责：把一棵 React 树挂到 Obsidian 视图容器上，并统一包上 antd 的
 * ConfigProvider / App（后者提供 message / notification / modal 的 context 实例，
 * 避免使用 antd 已废弃的静态方法）。
 *
 * 约定（见 P6_Views/Views.md 与 P7_Render/Render.md）：
 *   - 本层只做挂载，不含任何业务逻辑；
 *   - 容器一律使用 ItemView.contentEl（不含视图标题栏）；
 *   - 卸载一律经 unmount()，不得直接 empty() 掉 React 正在管理的 DOM。
 */

import { createRoot, type Root } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";

/** 把 React 树挂载到容器，返回 root 句柄（由调用方在 onClose 中 unmount） */
export function mountReact(container: HTMLElement, node: ReactNode): Root {
    const root = createRoot(container);
    root.render(
        <ConfigProvider>
            <AntApp>{node}</AntApp>
        </ConfigProvider>,
    );
    return root;
}
