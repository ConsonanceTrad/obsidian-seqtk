/**
 * TemplateTextPanel — 模板模式右栏「文本区」
 *
 * 这里编辑的就是**选中模板框架的内容**（框架自身那行不出现，于是根可以多个）——
 * 模板内容直接用文本表示，增删改都在这一份文本里做：上方文本框，下方实时解析预览 +
 * 带行号的问题列表（语法 / 类型链 / 占位符）+ 差异预告。
 * 语法与键盘辅助（Tab 缩进、Shift+Tab 反缩进、Enter 续写语法头）与「以文本批量编辑」
 * 弹窗同一套 —— 逻辑都在 P2_Tools/Parse/TextTree 的纯函数里，两处不会漂移。
 *
 * 纯渲染：只接 props、只发回调；不 import "obsidian"、不碰数据层（见 P6_Views/Views.md）。
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    CONTINUE_TextLine,
    INDENT_TextLine,
    type TextTreeIssue,
} from '../../../../P2_Tools/Parse/TextTree';
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
    /** 校验问题（语法 + 类型链 + 占位符），带行号 */
    issues: TextTreeIssue[];
    /** 解析预览行 */
    preview: TemplateTextPreviewRow[];
    /** 差异预告（将更新 / 新增 / 删除多少节点） */
    notice: string[];
    /** 解析出的根数量（框架的一级内容数） */
    rootCount: number;
    /** 可以回写（无校验问题且有改动） */
    canApply: boolean;
}

export interface TemplateTextPanelProps {
    /** 文本区标题（选中框架的「类型 · 名称」）；用于提示当前在编辑哪一个框架 */
    title?: string;
    text: TemplateTextState;
    onChange(value: string): void;
    onCommit(): void;
    onReset(): void;
}

export function TemplateTextPanel({ title, text, onChange, onCommit, onReset }: TemplateTextPanelProps) {
    const changed = text.value !== text.baseline;

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

    const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
                <span className="seqtk-hint">
                    每行 = 框架的一级内容；`[ ] [/] [x] [-]` 状态、每级缩进 2 空格、`K:短名` 指定类型；
                    占位可写 {'{{变量:提示|默认值}}'}、{'{{父.desc}}'}、{'{{框架名}}'}
                </span>
                <span className="seqtk-spacer" />
                <button className="seqtk-btn" disabled={!changed} onClick={onReset}>撤销改动</button>
                <button className="seqtk-btn mod-cta" disabled={!text.canApply} onClick={onCommit}>回写</button>
            </div>

            <textarea
                className="seqtk-template-text-input"
                value={text.value}
                spellCheck={false}
                placeholder={"- [ ] 构想名\n  - [ ] 方向名\n    - [ ] 目标名"}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
            />

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

            <div className="seqtk-template-text-preview">
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
                            <span
                                className={`seqtk-state-dot state-${row.state}`}
                                title={NODE_STATE_LABELS[row.state]}
                            />
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
