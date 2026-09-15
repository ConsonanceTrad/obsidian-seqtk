/**
 * C2_Tree — 行内正文编辑的覆盖层组件
 *
 * 归树而非归行：正文编辑器是行**下面**的一块覆盖式 textarea（`.seqtk-inline-body`），
 * 是行的兄弟节点，行组件只产出一个 div，放不下它（原 design/inline.ts 的
 * beginInlineEditBody 即此能力）。
 *
 * 契约：只接 props、只发回调；Ctrl+Enter 提交、Esc 取消、失焦提交；
 * 是否落盘由调用方决定；组件不接触数据层，也不 import "obsidian"。
 */

import { useEffect, useRef } from "react";

export interface InlineBodyProps {
    /** 初始正文 */
    value: string;
    /** 提交（Ctrl+Enter / 失焦） */
    onCommit: (body: string) => void;
    /** 取消（Esc） */
    onCancel: () => void;
}

export function InlineBodyPanel({ value, onCommit, onCancel }: InlineBodyProps) {
    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const doneRef = useRef(false);

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return;
        area.focus();
        // 光标落在末尾（与原实现一致）
        area.setSelectionRange(value.length, value.length);
    }, [value]);

    const finish = (save: boolean): void => {
        if (doneRef.current) return;
        doneRef.current = true;
        if (save) onCommit(areaRef.current?.value ?? "");
        else onCancel();
    };

    return (
        <div className="seqtk-inline-body">
            <textarea
                ref={areaRef}
                className="seqtk-inline-body-area"
                defaultValue={value}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && e.ctrlKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        finish(true);
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        finish(false);
                    }
                }}
                onBlur={() => finish(true)}
            />
        </div>
    );
}
