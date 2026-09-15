import type {NodeBase} from "../Node";
import type {State} from "../NodeField/AttriGroup/State";
import type {AffiliationFields} from "../NodeField/AttriGroup/Affiliation";
import type {ScheduleFields} from "../NodeField/AttriGroup/Schedule";
import type {NodeEvidenceKindValue, NodeFrameworkKindValue} from "../NodeKind/NodeKind";

export interface EvidenceNode extends NodeBase,
    State, AffiliationFields, ScheduleFields
{
    kind: NodeEvidenceKindValue;
}