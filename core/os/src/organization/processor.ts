// src/organization/processor.ts — THE ORGANIZATION PROCESSOR: the reduce of the organization's own
// secrets' certificates (cross-posted from `/organizations/<orgId>/secrets/<name>`) into their
// catalog. The organization's activity facts ride the same log and fold into nothing: its record is
// the control-plane database's (contract.ts). A PURE FOLD, so a unit test constructs it with `new`
// and reduces rows (processor.test.ts).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { OrganizationContract, type OrganizationState } from "./contract.ts";

export class OrganizationProcessor extends StreamProcessor<
  OrganizationState,
  ConsumedEvent<typeof OrganizationContract>
> {
  readonly contract = OrganizationContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<OrganizationState, ConsumedEvent<typeof OrganizationContract>>):
    | OrganizationState
    | undefined {
    // Every certificate folded here is the platform's cross-post (`source.platform`, caller.ts
    // `Caller.platform`): a member can append any type to the organization's context, and that one
    // stays on the log, attributed to them, and changes nothing.
    if (event.source?.platform !== true) return undefined;
    const secrets = reduceSecretCatalog(state.secrets, event);
    return secrets && { ...state, secrets };
  }
}
