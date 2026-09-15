/**
 * LogPanel — 日志阅览视图的渲染件（占位）
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 Log.ts；结构骨架复用 P7_Render 的 DualPane。
 */

import { Card, Tag, Typography } from "antd";
import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";

const { Title, Paragraph } = Typography;

/** 占位信息块（统一右栏 / 左栏的说明卡片样式） */
function PlaceholderCard({ title, desc }: { title: string; desc: string }) {
    return (
        <Card size="small" title={title}>
            {desc}
        </Card>
    );
}

export function LogPanel() {
    const left = (
        <div className="seqtk-pane">
            <Title level={5}>日志分类</Title>
            <Paragraph type="secondary">按分类与来源组织日志，管理缓存与获取方式。</Paragraph>
            <div className="seqtk-placeholder-panels">
                <PlaceholderCard title="分类与来源" desc="条目化的日志分类与来源管理。" />
                <PlaceholderCard
                    title="缓存策略"
                    desc="定义部分日志是否需要缓存，以及如何被脚本或自动化获取调用。"
                />
            </div>
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <Title level={5}>日志条目</Title>
            <Tag>规划中 · 尚未实现</Tag>
            <div className="seqtk-placeholder-panels">
                <PlaceholderCard title="条目阅览与搜索" desc="条目化的阅览和搜索日志。" />
                <PlaceholderCard
                    title="自动化获取"
                    desc="日志如何被脚本或自动化获取调用（例如任务的完成信息等）。"
                />
            </div>
        </div>
    );

    return <DualPane left={left} right={right} />;
}
