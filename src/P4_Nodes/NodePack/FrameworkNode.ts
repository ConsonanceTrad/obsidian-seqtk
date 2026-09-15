import type {NodeBase} from "../Node";
import type {NodeFrameworkKindValue} from "../NodeKind/NodeKind";
import type {State} from "../NodeField/AttriGroup/State";
import type {AffiliationFields} from "../NodeField/AttriGroup/Affiliation";
import type {ScheduleFields} from "../NodeField/AttriGroup/Schedule";

/** 框架大类：事务/信息/模板三个 kind 共享的形状 */
export interface FrameworkNode extends NodeBase,
    State, AffiliationFields, ScheduleFields
{
    kind: NodeFrameworkKindValue;
}