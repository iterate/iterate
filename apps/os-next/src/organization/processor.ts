// src/organization/processor.ts — THE ORGANIZATION PROCESSOR: the reduce of the organization's
// facts into its record. No effect: nothing is provisioned for an organization, the directory
// holds its row. Pure, so a unit test constructs it with `new` and reduces rows (processor.test.ts).
import {
  type ConsumedEvent,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
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
    switch (event.type) {
      case "events.iterate.com/organization/created":
      case "events.iterate.com/organization/renamed":
        return { ...state, name: event.payload.name };
      case "events.iterate.com/organization/deleted":
        return state.deletedAt ? undefined : { ...state, deletedAt: event.createdAt };
      case "events.iterate.com/organization/project-created": {
        const { projectId, slug } = event.payload;
        if (state.projects[projectId]) return undefined; // created once
        return {
          ...state,
          projects: { ...state.projects, [projectId]: { slug, createdAt: event.createdAt } },
        };
      }
      default:
        return undefined;
    }
  }
}
