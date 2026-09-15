import type {NodeBase} from "../Node";
import type {State} from "../NodeField/AttriGroup/State";
import type {AffiliationFields} from "../NodeField/AttriGroup/Affiliation";
import type {ScheduleFields} from "../NodeField/AttriGroup/Schedule";
import type {NodeAffairKindValue, NodeFrameworkKindValue} from "../NodeKind/NodeKind";

export interface AffairNode extends NodeBase,
    State, AffiliationFields, ScheduleFields
{
    kind: NodeAffairKindValue;
}