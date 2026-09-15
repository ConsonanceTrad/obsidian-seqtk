/**
 * ExecDesignPanel — 执行设计视图的渲染件（占位）
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 ExecDesign.ts；结构复用 P7_Render 的 DualPane / PlaceholderPane。
 */

import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";
import { PlaceholderPane } from "../../P7_Render/Structure/S1_Container/PlaceholderPane";

export function ExecDesignPanel() {
    return (
        <DualPane
            left={
                <PlaceholderPane
                    title="执行程序 / 脚本"
                    empty="暂无执行程序"
                    hint="功能待接入：内置可切换的可视化执行程序或执行脚本程序（可视化以脚本为基础的渲染，脚本为事实源）。"
                />
            }
            right={
                <PlaceholderPane
                    title="双栏编辑器"
                    badge="规划中 · 尚未实现"
                    desc="提供触发式或手动式的自动程序；连接 Obsidian 右侧附属信息叶子窗口。"
                />
            }
        />
    );
}
