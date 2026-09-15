/**
 * PlaceholderPane — 占位面板（结构）
 *
 * 未实现视图的可视化骨架：栏标题 +（可选）状态徽标 + 说明 + 功能卡片 / 空态。
 * 由 ExecDesign / QueryDesign / ExecBind 等占位视图的双栏复用。
 *
 * 纯渲染件：只接收文案，不含业务逻辑（见 P7_Render/Render.md）。
 */

import { Card, Tag, Typography } from "antd";

const { Title, Paragraph } = Typography;

/** 功能卡片规格 */
export interface PlaceholderCardSpec {
    title: string;
    desc: string;
}

export interface PlaceholderPaneProps {
    /** 栏标题 */
    title: string;
    /** 标题下的说明文字 */
    desc?: string;
    /** 状态徽标（如「规划中 · 尚未实现」） */
    badge?: string;
    /** 空态文案（与 cards 二选一） */
    empty?: string;
    /** 空态下的补充说明 */
    hint?: string;
    /** 功能卡片列表 */
    cards?: PlaceholderCardSpec[];
}

export function PlaceholderPane({ title, desc, badge, empty, hint, cards }: PlaceholderPaneProps) {
    return (
        <div className="seqtk-pane">
            <div className="seqtk-board-titlebar">
                <Title level={5} className="seqtk-split-title">{title}</Title>
                {badge && <Tag>{badge}</Tag>}
            </div>
            {desc && <Paragraph type="secondary" className="seqtk-placeholder-desc">{desc}</Paragraph>}
            {empty && <div className="seqtk-empty">{empty}</div>}
            {hint && <Paragraph type="secondary" className="seqtk-placeholder-desc">{hint}</Paragraph>}
            {cards && cards.length > 0 && (
                <div className="seqtk-placeholder-panels">
                    {cards.map((c) => (
                        <Card key={c.title} size="small" title={c.title}>{c.desc}</Card>
                    ))}
                </div>
            )}
        </div>
    );
}
