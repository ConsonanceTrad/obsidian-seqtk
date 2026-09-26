/**
 * DelegatedCustomPanel — 非树来源的委托面板壳
 *
 * 树来源的落点走 DelegatedTreePanel；左栏不是树的来源（如事务分发的月历）
 * 由 `DelegateSource.renderPanel` 给出整块内容，本组件只提供统一的外壳：
 * 标题 + 「取消委托」图标按钮（收在标题末尾，与树落点同款同位）+ 内容区。
 */

import type { ReactNode } from "react";
import { IconButton } from "../../../P7_Render/Composition/C1_NodeLine/IconButton";
import type { NodeLineHost } from "../../../P7_Render/Composition/C1_NodeLine/NodeLine";

export interface DelegatedCustomPanelProps {
    /** 来源的面板标题（如「事务分发」） */
    title: string;
    /** 来源给的整块内容 */
    content: ReactNode;
    onCancelDelegate: () => void;
    /** IconButton 要的宿主（setTooltip / setIcon，落点给） */
    host: NodeLineHost;
}

export function DelegatedCustomPanel({ title, content, onCancelDelegate, host }: DelegatedCustomPanelProps) {
    return (
        <div className="seqtk-delegated-custom">
            <div className="seqtk-delegated-custom-title">
                <span className="seqtk-split-title">{title}</span>
                {/* 与树落点同款：收在标题末尾的取消委托图标按钮 */}
                <IconButton
                    className="seqtk-icon-btn seqtk-delegate-btn is-active"
                    icon="chevrons-right"
                    tip="取消委托（把内容交还来源视图）"
                    host={host}
                    onClick={onCancelDelegate}
                />
            </div>
            <div className="seqtk-delegated-custom-body">{content}</div>
        </div>
    );
}
