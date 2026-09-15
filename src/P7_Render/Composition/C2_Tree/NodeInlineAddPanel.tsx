/**
 * C2_Tree — 行内新建的「附加行」组件
 *
 * 归树而非归行：附加行插在某个父节点的子列表**末尾**，是行之外的兄弟节点，
 * 行组件只产出一个 div，放不下它（原 design/inline.ts 的 beginInlineCreate* 即此能力）。
 *
 * 契约：只接 props、只发回调；名称是否合法、是否落盘由调用方决定；
 * 组件自身不接触数据层，也不 import "obsidian"。
 *
 * 与命令式实现的对应：`.seqtk-inline-add` 容器 + 类型预览/下拉（`.seqtk-inline-kind-preview`
 * / `.seqtk-inline-kind`）+ 名称输入（`.seqtk-inline-name`）+ 确认/取消按钮，缩进由层级算出。
 * 失焦不结束编辑（「点击外部不打断」），结束方式为 Enter / Esc / 两个按钮。
 */

import { GET_KindClass } from "../../../P4_Nodes/NodeKind/KindColors";
import { useEffect, useRef, useState } from "react";
import { NODE_KIND, NODE_KIND_LABELS } from "../../../P4_Nodes/NodeFacade";
import type { NodeKindValue } from "../../../P4_Nodes/NodeKind/NodeKind";
import { GET_LineIndent, type NodeLineMetrics } from "../C1_NodeLine/NodeLine";

export interface NodeInlineAddProps {
    /** 该父节点允许的子类型（多于一个时渲染类型下拉） */
    kinds: NodeKindValue[];
    /** 初始选中的类型 */
    kind: NodeKindValue;
    /** 附加行所在层级（= 父层级 + 1） */
    depth: number;
    metrics: NodeLineMetrics;
    /** 提交（Enter）；name 已 trim 且非空 */
    onCommit: (kind: NodeKindValue, name: string) => void;
    /** 取消（Esc / 失焦） */
    onCancel: () => void;
    /** 切换类型 */
    onKindChange?: (kind: NodeKindValue) => void;
    /** 连续输入开关的当前值 */
    repeat?: boolean;
    /** 切换连续输入 */
    onRepeatChange?: (repeat: boolean) => void;
}

export function NodeInlineAddPanel({
    kinds,
    kind,
    depth,
    metrics,
    onCommit,
    onCancel,
    onKindChange,
    repeat,
    onRepeatChange,
}: NodeInlineAddProps) {
    const [current, setCurrent] = useState<NodeKindValue>(kind);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const doneRef = useRef(false);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const finish = (confirm: boolean): void => {
        if (doneRef.current) return;
        const name = (inputRef.current?.value ?? "").trim();
        if (!confirm || !name) {
            doneRef.current = true;
            onCancel();
            return;
        }
        doneRef.current = true;
        onCommit(current, name);
    };

    // 类型预览与行徽章同色：统一走 KindColors 的类别 class（单一来源，覆盖全部大类）
    const isFramework = current === NODE_KIND.TRANS;
    const catCls = ` ${GET_KindClass(current)}`;
    const previewText = isFramework ? "框架" : NODE_KIND_LABELS[current];

    return (
        <div
            className="seqtk-inline-add"
            style={{ paddingLeft: `${GET_LineIndent(depth, metrics)}px`, boxSizing: "border-box" }}
        >
            {/* 第一行：类型 + 名称输入（与普通行同构，缩进一致） */}
            <div className="seqtk-inline-add-row">
                {kinds.length > 1 ? (
                    <select
                        className="seqtk-inline-kind"
                        value={current}
                        onChange={(e) => {
                            const next = e.target.value as NodeKindValue;
                            setCurrent(next);
                            onKindChange?.(next);
                            // 选完回到输入框，不结束编辑
                            inputRef.current?.focus();
                        }}
                    >
                        {kinds.map((k) => (
                            <option key={k} value={k}>
                                {NODE_KIND_LABELS[k]}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className={`seqtk-inline-kind-preview${catCls}`}>{previewText}</span>
                )}

                <input
                    ref={inputRef}
                    className="seqtk-inline-name"
                    placeholder={`输入${NODE_KIND_LABELS[current]}名称…`}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            finish(true);
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            finish(false);
                        }
                    }}
                    // 不做失焦提交：点到外部不打断本次编辑（用「确认 / 取消」按钮或 Esc 结束）
                />
            </div>

            {/* 开关与按钮同在一层浮层里（相对主行绝对定位，不参与布局）：左开关、右按钮。
                left 取与主行相同的缩进值，浮层才与输入行对齐 */}
            <div className="seqtk-inline-add-actions" style={{ left: `${GET_LineIndent(depth, metrics)}px` }}>
                <label className="seqtk-inline-repeat" title="提交后保留本行，可连续录入">
                    <input
                        type="checkbox"
                        checked={!!repeat}
                        onChange={(e) => {
                            onRepeatChange?.(e.target.checked);
                            inputRef.current?.focus();
                        }}
                    />
                    连续输入
                </label>
                <span className="seqtk-inline-add-btns">
                    <button type="button" className="seqtk-inline-edit-btn" title="确认（Enter）" onClick={() => finish(true)}>
                        ✓
                    </button>
                    <button type="button" className="seqtk-inline-edit-btn" title="取消（Esc）" onClick={() => finish(false)}>
                        ✕
                    </button>
                </span>
            </div>
        </div>
    );
}
