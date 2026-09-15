/**
 * ExecBindPanel — 执行绑定视图的渲染件（占位）
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见 ../V2_Rule/ExecBind.ts；结构复用 P7_Render 的 DualPane / PlaceholderPane。
 */

import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";
import { PlaceholderPane } from "../../P7_Render/Structure/S1_Container/PlaceholderPane";

export function ExecBindPanel() {
    return (
        <DualPane
            left={
                <PlaceholderPane
                    title="绑定规则"
                    desc="将执行行为绑定到指定时间点，或绑定到某事件（节点）完成后自动触发。"
                    cards={[
                        { title: "定时触发", desc: "一次性时间点或周期触发（复用流程脚本规则语法）。" },
                        { title: "事件后触发", desc: "监听节点完成等状态变化后触发绑定行为。" },
                    ]}
                />
            }
            right={
                <PlaceholderPane
                    title="编辑与记录"
                    badge="规划中 · 尚未实现"
                    cards={[
                        { title: "规则编辑", desc: "绑定规则（触发条件 → 执行行为）以可视化或脚本化方式编辑与阅览，供执行设计接入自动程序。" },
                        { title: "管理阅览", desc: "绑定规则的启停控制、触发记录与执行日志。" },
                    ]}
                />
            }
        />
    );
}
