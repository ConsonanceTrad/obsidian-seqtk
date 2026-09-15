import type {NodeBase} from "../Node";
import type {State} from "../NodeField/AttriGroup/State";
import type {AffiliationFields} from "../NodeField/AttriGroup/Affiliation";
import type {ScheduleFields} from "../NodeField/AttriGroup/Schedule";
import type {NodeRuntimeKindValue} from "../NodeKind/NodeKind";

export interface RuntimeNode extends NodeBase,
    State, AffiliationFields, ScheduleFields
{
    kind: NodeRuntimeKindValue;
}