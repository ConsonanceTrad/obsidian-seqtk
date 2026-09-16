/**
 * ViewErrorBoundary — 视图级错误边界
 *
 * 目的：面板子树抛错时只把那一块换成**可恢复的错误卡**，而不是让整个视图消失。
 * 此前一次渲染期异常就能把视图整块打空，用户只看到「闪退」，既不知道原因也无从下手。
 *
 * 约定：
 * - 只兜底、不吞错：完整堆栈打一次到控制台，卡上也给出摘要与「重试」；
 * - 「重试」= 清掉错误态重新渲染子树。若错误是状态性的（例如数据异常仍在），
 *   重试会再次失败 —— 但此时信息与视图框架都还在，可以照常用别的面板、把堆栈反馈出来；
 * - 边界挂在视图挂载层（ReactHost），因此**所有**视图都被覆盖，不必逐个视图实现。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ViewErrorBoundaryProps {
    children: ReactNode;
}

interface ViewErrorBoundaryState {
    error: Error | null;
    /** React 给出的组件栈（定位到具体组件用） */
    componentStack: string;
}

export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
    state: ViewErrorBoundaryState = { error: null, componentStack: "" };

    static getDerivedStateFromError(error: Error): Partial<ViewErrorBoundaryState> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // 完整堆栈只打一次：重试后若原样再错，控制台不会刷屏
        console.error("[SeqTK] 视图渲染出错（已隔离，可重试）：", error, info.componentStack);
        this.setState({ componentStack: info.componentStack ?? "" });
    }

    private readonly retry = (): void => {
        this.setState({ error: null, componentStack: "" });
    };

    render(): ReactNode {
        const { error, componentStack } = this.state;
        if (!error) return this.props.children;
        return (
            <div className="seqtk-view-error">
                <div className="seqtk-view-error-title">此面板渲染出错</div>
                <div className="seqtk-view-error-desc">
                    其它面板不受影响。完整堆栈已输出到开发者控制台（Ctrl/Cmd + Shift + I）。
                </div>
                <pre className="seqtk-view-error-stack">
                    {`${error.message || String(error)}${componentStack ? `\n${componentStack}` : ""}`}
                </pre>
                <button className="seqtk-btn" type="button" onClick={this.retry}>
                    重试
                </button>
            </div>
        );
    }
}
