/**
 * ReactViewBase — 所有 React 视图的基类
 *
 * 接管 ItemView 的 onOpen / onClose，把 React root 的挂载与卸载收敛到一处，
 * 避免每个视图重复写生命周期管理。
 *
 * 子类只需实现 renderPanel() 返回该视图的 React 树；
 * 业务逻辑（数据订阅、命令、状态）由子类持有，React 树通过 props 接收，
 * 两者不得互相越界（见 P6_Views/Views.md 的分离契约）。
 *
 * 数据订阅的两种写法：
 *   - 订阅写在渲染件内：组件里调 useStore(store)，store 由 props 传入；
 *   - 订阅写在视图类内：onOpen 时绑定，派生结果经 props 传入组件。
 * 前者更符合分离契约，后者仅在需要命令式副作用时使用。
 */

import { ItemView } from "obsidian";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import { mountReact } from "./ReactHost";

export abstract class ReactViewBase extends ItemView {
    private root: Root | null = null;

    /** 子类实现：返回该视图的 React 树（只做渲染，数据经 props 传入） */
    protected abstract renderPanel(): ReactNode;

    /**
     * 可选钩子：root 挂载完成后调用 —— 在此订阅数据、触发首次加载。
     * 子类不要重写 onOpen / onClose，需要打开 / 关闭副作用时用这两个钩子。
     */
    protected onMounted(): void {}

    /** 可选钩子：root 卸载前调用 —— 在此取消订阅、清理全局监听 */
    protected onBeforeUnmount(): void {}

    /**
     * 可选钩子：额外挂到 contentEl（即 .view-content）上的类名。
     * 需要命中「装着本视图的那个内容区」的样式走这里 —— 不用 :has（广泛选择器失效会拖性能）。
     */
    protected contentClasses(): string[] {
        return [];
    }

    async onOpen(): Promise<void> {
        // 先卸掉旧 root（同一 leaf 复用时会重复调用 onOpen），再清空容器
        this.root?.unmount();
        this.root = null;
        this.contentEl.empty();
        // antd 样式基线的作用域锚点（见 styles.css 的 .seqtk-antd-root）
        this.contentEl.addClass("seqtk-antd-root");
        // 视图自声明的容器类：contentEl 就是 .view-content，每次 onOpen 重新挂上
        for (const cls of this.contentClasses()) this.contentEl.addClass(cls);
        this.root = mountReact(this.contentEl, this.renderPanel());
        this.onMounted();
    }

    async onClose(): Promise<void> {
        this.onBeforeUnmount();
        this.root?.unmount();
        this.root = null;
    }
}
