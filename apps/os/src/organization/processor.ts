// src/organization/processor.ts — THE ORGANIZATION PROCESSOR: the reduce of the organization's
// facts into its record — its name, its members, its projects — and of its own secrets'
// certificates (cross-posted from `/organizations/<orgId>/secrets/<name>`) into their catalog. No
// effect: a PURE FOLD. The facts are landed by the session on the context
// (session.ts `publishOrganizationFact`) after the control-plane database writes them. Pure, so a
// unit test constructs it with `new` and reduces rows (processor.test.ts).
import {
  type ConsumedEvent,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
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
    switch (event.type) {
      case "events.iterate.com/organization/created":
      case "events.iterate.com/organization/renamed":
        return { ...state, name: event.payload.name };
      case "events.iterate.com/organization/deleted":
        return state.deletedAt ? undefined : { ...state, deletedAt: event.createdAt };
      case "events.iterate.com/organization/member-added": {
        // The latest role is the row; the first membership's time stays. The same role again is a no-op.
        const { userId, role } = event.payload;
        const known = state.members[userId];
        if (known?.role === role) return undefined;
        return {
          ...state,
          members: {
            ...state.members,
            [userId]: { role, since: known?.since ?? event.createdAt },
          },
        };
      }
      case "events.iterate.com/organization/member-removed": {
        if (!state.members[event.payload.userId]) return undefined;
        const { [event.payload.userId]: _gone, ...members } = state.members;
        return { ...state, members };
      }
      case "events.iterate.com/organization/project-created": {
        const { projectId, slug } = event.payload;
        if (state.projects[projectId]) return undefined; // created once
        return {
          ...state,
          projects: { ...state.projects, [projectId]: { slug, createdAt: event.createdAt } },
        };
      }
      case "events.iterate.com/secret/set":
      case "events.iterate.com/secret/deleted": {
        const secrets = reduceSecretCatalog(state.secrets, event);
        return secrets && { ...state, secrets };
      }
      default:
        return undefined;
    }
  }
}
