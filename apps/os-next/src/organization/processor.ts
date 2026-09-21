// src/organization/processor.ts — the organization processor's PURE class (the triplet's middle):
// folds the organization's facts into its record. Imports only the pure kernel, so the node lane
// constructs it with `new` (processor.test.ts); the host (durable-object.ts) reduces it on demand.
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import { OrganizationContract, type OrganizationView } from "./contract.ts";

export class OrganizationProcessor extends StreamProcessor<
  ProcessorState<typeof OrganizationContract>,
  ConsumedEvent<typeof OrganizationContract>
> {
  readonly contract = OrganizationContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<OrganizationView, ConsumedEvent<typeof OrganizationContract>>):
    | OrganizationView
    | undefined {
    if (
      event.type === "events.iterate.com/organization/created" ||
      event.type === "events.iterate.com/organization/renamed"
    )
      return { ...state, name: event.payload.name };
    if (event.type === "events.iterate.com/organization/deleted")
      return state.deletedAt ? undefined : { ...state, deletedAt: event.createdAt };
    if (event.type === "events.iterate.com/organization/project-created") {
      const { projectId, slug } = event.payload;
      if (state.projects[projectId]) return undefined; // created once
      return {
        ...state,
        projects: { ...state.projects, [projectId]: { slug, createdAt: event.createdAt } },
      };
    }
    return undefined;
  }
}
