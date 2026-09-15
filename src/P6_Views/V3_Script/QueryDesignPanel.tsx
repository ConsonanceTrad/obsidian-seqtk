/**
 * QueryDesignPanel — 查询设计视图的渲染件（占位）
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 QueryDesign.ts；结构复用 P7_Render 的 DualPane / PlaceholderPane。
 */

import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";
import { PlaceholderPane } from "../../P7_Render/Structure/S1_Container/PlaceholderPane";

export function QueryDesignPanel() {
    return (
        <DualPane
            left={
                <PlaceholderPane
                    title="查询脚本"
                    desc="使用内置脚本配合 db 实现相关信息查询，支持复杂语句。"
                    cards={[
                        { title: "内置脚本", desc: "内置脚本库与脚本化查询入口。" },
                        { title: "复杂语句", desc: "支持复杂语句的查询编辑区。" },
                    ]}
                />
            }
            right={
                <PlaceholderPane
                    title="查询与结果"
                    badge="规划中 · 尚未实现"
                    cards={[
                        { title: "查询执行", desc: "执行查询并预览原始结果。" },
                        { title: "结果解析输出", desc: "查询结果解析输出模块以供使用。" },
                    ]}
                />
            }
        />
    );
}
