/**
 * Template/Slice/TemplateHost — 模板切片的最小宿主契约
 *
 * 模板切片的函数以「宿主」为第一参数（原先直接写 TemplateView 类）。把宿主收窄成
 * 结构接口，是为了让**委托面板**也能复用同一套动作：模板左栏被委托到侧栏之后，
 * 即便模板视图已经关掉，面板里的新建 / 重命名 / 删除 / 应用模板照旧可用 ——
 * 而面板手上只有 app / pipe / settings，没有视图实例。
 *
 * TemplateView 天然满足本接口（它本来就是这些能力的来源），所以视图侧调用一行不用改。
 */

import type { App } from 'obsidian';
import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { PluginSettings } from '../../../../P3_Settings/Settings';

export interface TemplateHost {
    readonly app: App;
    readonly pipe: DataPipe;
    readonly settings: PluginSettings;
    /** 选中项若已不存在就清掉（删除后的收尾）；委托面板侧的宿主可省 */
    collapseSelectionIfGone?(): void;
}
