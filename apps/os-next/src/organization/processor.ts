// src/organization/processor.ts — THE ORGANIZATION PROCESSOR: the reduce of the organization's
// facts into its record, and of its own secrets' certificates (cross-posted from
// `/organizations/<orgId>/secrets/<name>`) into their catalog. No effect: nothing is provisioned for
// an organization, the directory holds its row. Pure, so a unit test constructs it with `new` and
// reduces rows (processor.test.ts).
import { jsonEqual } from "iterate/next/lib";
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
      case "events.iterate.com/secret/set": {
        // The latest write is the row (a rotation keeps the row, a new pin or strategy replaces
        // it); the first set's time stays. The same pin and strategy again is a no-op.
        const { path, urls, refresh } = event.payload;
        const known = state.secrets[path];
        if (known && known.refresh === refresh && jsonEqual(known.urls, urls)) return undefined;
        return {
          ...state,
          secrets: {
            ...state.secrets,
            [path]: { urls, refresh, createdAt: known?.createdAt ?? event.createdAt },
          },
        };
      }
      case "events.iterate.com/secret/deleted": {
        if (!state.secrets[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...secrets } = state.secrets;
        return { ...state, secrets };
      }
      default:
        return undefined;
    }
  }
}
