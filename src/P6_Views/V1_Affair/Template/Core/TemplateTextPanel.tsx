/**
 * TemplateTextPanel — 模板模式右栏「文本区」
 *
 * 这里编辑的就是**选中模板框架的内容**（框架自身那行不出现，于是根可以多个）——
 * 模板内容直接用文本表示，增删改都在这一份文本里做。
 *
 * 上下两块高度固定（按容器比例分），各自独立滚动：
 *   上 = 实时解析预览（带行号的问题列表与差异预告紧跟其下）
 *   下 = 编辑文本框（主体，占余下的高度）
 * 于是无论内容多长，两块都在原地滚，不会互相挤压、也不会把整栏撑高。
 *
 * 预览区里能直接干活：
 *   - 行上的**状态圆点可点**：把编辑文本里那一行切成完成 / 规划（不改节点，直到按下「确认」）
 *   - 行末显示该行的行内 `@` 指令徽章（`@start` / `field:reset` / `pos:2`）
 *   - 底部一行是**插入时同名冲突**策略（追加 / 覆写 / 跳过），改动即生效
 *
 * 语法与键盘辅助（Tab 缩进、Shift+Tab 反缩进、Enter 续写语法头、`@` 语法补全）与
 * 「以文本批量编辑」弹窗同一套 —— 逻辑都在 P2_Tools/Parse 的纯函数里，两处不会漂移。
 *
 * 纯渲染：只接 props、只发回调；不 import "obsidian"、不碰数据层（见 P6_Views/Views.md）。
 */

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ChangeEvent as ReactChangeEvent } from 'react';
import {
    CONTINUE_TextLine,
    INDENT_TextLine,
    type TextTreeIssue,
} from '../../../../P2_Tools/Parse/TextTree';
import {
    APPLY_Completion,
    CONTEXT_AtCompletion,
    type AtCompletion,
    type TextTreeCompletion,
} from '../../../../P2_Tools/Parse/TextComplete';
import type { TemplateConflictPolicy } from '../../../../P2_Tools/Parse/TempParse';
import { GET_KindClass } from '../../../../P4_Nodes/NodeKind/KindColors';
import { NODE_STATE_LABELS } from '../../../../P4_Nodes/NodeField/StateKeys';
import { GET_LineIndent, LINE_METRICS_RIGHT } from '../../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { TemplateTextPreviewRow } from '../Slice/templateText';

/** 文本区状态（由 TemplateView 重算后写入；渲染件只读） */
export interface TemplateTextState {
    /** 当前框架 nodeId（null = 未选框架） */
    frameworkId: string | null;
    /** 文本区当前内容 */
    value: string;
    /** 基线（该框架此刻的真实内容）；value !== baseline 表示有未回写的改动 */
    baseline: string;
    /** 校验问题（语法 + 类型链 + 行内指令 + 占位符），带行号 */
    issues: TextTreeIssue[];
    /** 解析预览行 */
    preview: TemplateTextPreviewRow[];
    /** 差异预告（将更新 / 新增 / 删除多少节点） */
    notice: string[];
    /** 解析出的根数量（框架的一级内容数）= 插入分支数 */
    rootCount: number;
    /** 可以回写（无校验问题且有改动） */
    canApply: boolean;
    /** 插入时同名冲突策略（预览区底部可改；记忆在设置里） */
    conflict: TemplateConflictPolicy;
}

export interface TemplateTextPanelProps {
    /** 文本区标题（选中框架的「类型 · 名称」）；用于提示当前在编辑哪一个框架 */
    title?: string;
    text: TemplateTextState;
    onChange(value: string): void;
    onCommit(): void;
    onReset(): void;
    /** 改插入时的同名冲突策略 */
    onConflictChange(policy: TemplateConflictPolicy): void;
    /** 预览上点状态圆点：把编辑文本里对应那一行切成完成 / 规划 */
    onToggleState(line: number): void;
}

/** 冲突策略的三个选项（顺序即展示顺序） */
const CONFLICT_OPTIONS: { value: TemplateConflictPolicy; label: string; tip: string }[] = [
    { value: 'append', label: '追加', tip: '同名同类型也照常新建（默认）' },
    { value: 'overwrite', label: '覆写', tip: '命中同名同类型的已有节点时，改写它的名称 / 字段 / 正文，后代挂到它下面' },
    { value: 'skip', label: '跳过', tip: '已有同名同类型节点就完全不动它，后代挂在它下面' },
];

export function TemplateTextPanel({
    title,
    text,
    onChange,
    onCommit,
    onReset,
    onConflictChange,
    onToggleState,
}: TemplateTextPanelProps) {
    const changed = text.value !== text.baseline;
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    /** 当前候选浮层与选中的那一条 */
    const [completion, setCompletion] = useState<AtCompletion | null>(null);
    const [active, setActive] = useState(0);

    /**
     * 语法辅助（与批量编辑弹窗同口径）
     *
     * 受控组件里改值要走 onChange，因此改完 value 后在下一次帧把光标补回去 ——
     * 否则 React 重渲时会把光标丢回末尾（打字体验直接崩掉）。
     */
    const withCaret = (ta: HTMLTextAreaElement, next: string, caret: number) => {
        onChange(next);
        window.requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = caret;
        });
    };

    /** 光标一动就重算候选（`@` 之后才给） */
    const syncCompletion = (ta: HTMLTextAreaElement) => {
        setCompletion(CONTEXT_AtCompletion(ta.value, ta.selectionStart));
        setActive(0);
    };

    const onChangeInput = (e: ReactChangeEvent<HTMLTextAreaElement>) => {
        onChange(e.target.value);
        syncCompletion(e.target);
    };

    /** 采用某条候选：替换掉光标处的 `@…`，并把光标落到片段之后 */
    const applyCompletion = (item: TextTreeCompletion) => {
        const ta = taRef.current;
        if (!ta || !completion) return;
        const r = APPLY_Completion(ta.value, completion, item);
        setCompletion(null);
        withCaret(ta, r.value, r.caret);
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        // 候选浮层开着时，方向键与回车先服务补全（Esc 关掉，回到普通编辑）
        if (completion) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => (i + 1) % completion.items.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (i - 1 + completion.items.length) % completion.items.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                applyCompletion(completion.items[active] ?? completion.items[0]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setCompletion(null);
                return;
            }
        }

        if (e.key === 'Tab') {
            // 必须吃掉默认行为：否则 Tab 会把焦点挪出文本区
            e.preventDefault();
            const ta = e.currentTarget;
            const r = INDENT_TextLine(ta.value, ta.selectionStart, ta.selectionEnd, e.ctrlKey || e.shiftKey);
            withCaret(ta, r.value, r.caret);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const ta = e.currentTarget;
            const r = CONTINUE_TextLine(ta.value, ta.selectionStart, ta.selectionEnd);
            if (!r) return;
            e.preventDefault();
            withCaret(ta, r.value, r.caret);
        }
    };

    return (
        <div className="seqtk-template-text">
            <div className="seqtk-template-text-head">
                <span className="seqtk-section-title">{title ?? '框架内容'}</span>
                <span className="seqtk-spacer" />
                <button className="seqtk-btn" disabled={!changed} onClick={onReset}>还原</button>
                <button className="seqtk-btn mod-cta" disabled={!text.canApply} onClick={onCommit}>确认</button>
            </div>

            {/* 上：实时预览（固定高度、自己滚）+ 底部的插入策略 */}
            <div className="seqtk-template-text-preview">
                <div className="seqtk-texttree-list">
                    {text.preview.length === 0 ? (
                        <div className="seqtk-texttree-empty">（暂无内容）</div>
                    ) : (
                        text.preview.map((row, i) => (
                            <div
                                className="seqtk-texttree-row"
                                key={`preview-${i}`}
                                style={{ paddingLeft: `${GET_LineIndent(row.depth, LINE_METRICS_RIGHT)}px` }}
                            >
                                <span className={`seqtk-kind-badge ${GET_KindClass(row.kind)}`}>{row.kindLabel}</span>
                                <span className="seqtk-texttree-desc">{row.desc}</span>
                                {row.ins?.start && (
                                    <span className="seqtk-texttree-instr" title="插入起点（多树模板每棵都要）">@start</span>
                                )}
                                {row.ins?.field && (
                                    <span className="seqtk-texttree-instr" title="字段保留策略">{`field:${row.ins.field}`}</span>
                                )}
                                {row.ins?.pos !== undefined && (
                                    <span className="seqtk-texttree-instr" title="插入位置（同级索引）">{`pos:${row.ins.pos}`}</span>
                                )}
                                <button
                                    type="button"
                                    className={`seqtk-state-dot state-${row.state} seqtk-state-dot-btn`}
                                    title={`${NODE_STATE_LABELS[row.state]}（点一下切完成 / 规划）`}
                                    onClick={() => onToggleState(row.line)}
                                />
                            </div>
                        ))
                    )}
                </div>

                <div className="seqtk-preview-policy">
                    <span className="seqtk-spacer"></span>
                    <span className="seqtk-hint">冲突处理策略 </span>
                    {CONFLICT_OPTIONS.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            className={"seqtk-btn seqtk-btn-ghost seqtk-policy-btn" + (text.conflict === o.value ? " is-active" : "")}
                            title={o.tip}
                            onClick={() => onConflictChange(o.value)}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 问题与差异预告：紧贴编辑区上方（改的是哪几行，一眼能看到） */}
            <div className="seqtk-template-text-issues">
                {text.issues.map((issue, i) => (
                    <div className="seqtk-texttree-issue" key={`issue-${i}`}>
                        第 {issue.line} 行：{issue.message}
                    </div>
                ))}
                {text.notice.map((line, i) => (
                    <div className="seqtk-texttree-issue seqtk-texttree-notice" key={`notice-${i}`}>
                        {line}
                    </div>
                ))}
            </div>

            {/* 下：编辑区（占余下的高度、自己滚）；候选浮层浮在它上方 */}
            <div className="seqtk-template-text-edit">
                {completion && (
                    <div className="seqtk-complete-pop">
                        {completion.items.map((item, i) => (
                            <div
                                key={item.label}
                                className={"seqtk-complete-item" + (i === active ? " is-active" : "")}
                                /* mousedown 而不是 click：click 会让输入框先失焦，光标位置就丢了 */
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    applyCompletion(item);
                                }}
                            >
                                <span className="seqtk-complete-label">{item.label}</span>
                                <span className="seqtk-complete-detail">{item.detail}</span>
                            </div>
                        ))}
                    </div>
                )}
                <textarea
                    ref={taRef}
                    className="seqtk-template-text-input"
                    value={text.value}
                    spellCheck={false}
                    placeholder={"- [ ] 构想名\n  - [ ] 方向名\n    - [ ] 目标名"}
                    onChange={onChangeInput}
                    onKeyDown={onKeyDown}
                    onBlur={() => setCompletion(null)}
                />
            </div>
        </div>
    );
}
