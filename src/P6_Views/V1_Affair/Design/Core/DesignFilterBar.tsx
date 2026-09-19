/**
 * DesignFilterBar — 右栏标题栏右侧的复合条件筛选
 *
 * 收起时只是一个按钮（有生效条件时高亮并显示条数），点开才是条件面板：每条 =「属性 + 值」，
 * 属性下拉的选项与值控件形状都来自 design/filter 的 FILTER_FIELDS —— 这里不重复定义字段，
 * 加字段只要改那一处。
 *
 * 本组件**只算下一份条件列表**交给 actions.filterChange，判定与裁剪全在数据侧
 * （design/filter + viewState），所以它既不认识树、也不认识缓存。
 */

import { useState } from 'react';
import {
    FILTER_FIELDS,
    FILTER_RegexError,
    type FilterCondition,
    type FilterField,
} from '../Slice/filter';

interface Props {
    conditions: FilterCondition[];
    onChange: (next: FilterCondition[]) => void;
}

export function DesignFilterBar({ conditions, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const activeCount = conditions.filter((c) => c.value.trim() !== '').length;
    const badRegex = FILTER_RegexError(conditions);

    const update = (index: number, patch: Partial<FilterCondition>): void =>
        onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    const remove = (index: number): void => onChange(conditions.filter((_, i) => i !== index));
    const add = (): void => onChange([...conditions, { field: 'desc', value: '' }]);

    return (
        <div className="seqtk-filter">
            <button
                className={`seqtk-btn seqtk-btn-ghost seqtk-filter-toggle${activeCount > 0 ? ' is-active' : ''}`}
                title={activeCount > 0 ? `筛选生效中（${activeCount} 条）` : '按条件筛选右栏'}
                onClick={() => setOpen(!open)}
            >
                筛选{activeCount > 0 ? ` (${activeCount})` : ''}
            </button>

            {open && (
                <div className="seqtk-filter-panel">
                    {conditions.length === 0 ? (
                        <div className="seqtk-filter-hint">
                            还没有条件。逐条添加，条件之间是「与」—— 全部满足才留下。
                        </div>
                    ) : (
                        conditions.map((cond, i) => {
                            const meta = FILTER_FIELDS.find((f) => f.field === cond.field);
                            if (!meta) return null;
                            return (
                                <div
                                    className={`seqtk-filter-row${badRegex === cond ? ' is-error' : ''}`}
                                    key={i}
                                >
                                    <select
                                        className="dropdown seqtk-filter-field"
                                        value={cond.field}
                                        onChange={(e) => update(i, { field: e.target.value as FilterField, value: '' })}
                                    >
                                        {FILTER_FIELDS.map((f) => (
                                            <option key={f.field} value={f.field}>{f.label}</option>
                                        ))}
                                    </select>

                                    {meta.options ? (
                                        <select
                                            className="dropdown seqtk-filter-value"
                                            value={cond.value}
                                            onChange={(e) => update(i, { value: e.target.value })}
                                        >
                                            <option value="">（不限）</option>
                                            {meta.options.map((o) => (
                                                <option key={o.value} value={o.value}>{o.label}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            className="seqtk-filter-value"
                                            type="text"
                                            value={cond.value}
                                            placeholder={meta.placeholder ?? ''}
                                            onChange={(e) => update(i, { value: e.target.value })}
                                        />
                                    )}

                                    <button
                                        className="seqtk-btn seqtk-btn-ghost seqtk-filter-del"
                                        title="删除这条"
                                        onClick={() => remove(i)}
                                    >
                                        ✕
                                    </button>
                                </div>
                            );
                        })
                    )}

                    <div className="seqtk-filter-actions">
                        <button className="seqtk-btn seqtk-btn-ghost" onClick={add}>添加条件</button>
                        {conditions.length > 0 && (
                            <button className="seqtk-btn seqtk-btn-ghost" onClick={() => onChange([])}>清空</button>
                        )}
                    </div>

                    {badRegex && (
                        <div className="seqtk-filter-hint is-error">
                            正则语法有误，这一条不会命中任何节点。
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
