import {Load_Core} from "./Core";
import {Register_View} from "./View";
import {Register_Ribbon} from "./Ribbon";
import {Register_SettingsTab} from "../P3_Settings/SettingsTab";
import {Register_Comd} from "./Comd";
import type SeqtkPlugin from "../main"; // 类型引用，防止环依赖访问未生成完成的实例

// 面板模块副作用导入：装饰器仅在模块被 import 时执行。
// 参与散布式注册（@AutoView / @AutoRegister）的视图类文件在此登记，
// 使其声明在打包时被收集 —— 新接入 / 重新接入的视图文件在此追加（或取消注释）一行即可。
// 注：以下视图尚处内部依赖迁移（import 未收敛，指向 old/core/types/components 等），
//     暂不登记以免阻塞构建；待视图内部迁移完成后取消注释即重新启用其注册与打开指令。
import "../P6_Views/V0_Common/Blank";
import "../P6_Views/V0_Common/Hub";
import "../P6_Views/V0_Common/Log";
import "../P6_Views/V0_Common/Recycle";
import "../P6_Views/V1_Affair/DelegatedTree";
import "../P6_Views/V1_Affair/Design/Core/Design";
import "../P6_Views/V1_Affair/Overview";
import "../P6_Views/V1_Affair/Route";
import "../P6_Views/V1_Affair/Template";
import "../P6_Views/V2_Rule/ExecBind";
import "../P6_Views/V2_Rule/FlowDraft";
import "../P6_Views/V2_Rule/FlowPush";
import "../P6_Views/V3_Script/ExecDesign";
import "../P6_Views/V3_Script/FlowDesign";
import "../P6_Views/V3_Script/QueryDesign";
import "../P6_Views/V4_Agent/AgentDesign";
import "../P6_Views/V4_Agent/AgentHook";
import "../P6_Views/V4_Agent/SubInter";

export function Module_Register(p:SeqtkPlugin){
    // 初始化核心模块，包括文件、数据库等的空实例对象
    Load_Core(p);
    // 注册面板（消费 @AutoView 收集的注册条目）
    Register_View(p);
    // 注册 Ribbon
    Register_Ribbon(p);
    // 注册设置面板
    Register_SettingsTab(p);
    // 注册全部指令（消费 @AutoRegister 收集的命令）
    Register_Comd(p);
}
