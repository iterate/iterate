// src/organization/processor.ts — THE ORGANIZATION PROCESSOR: the reduce of the organization's
// facts into its record — its name, its members, its open invitation links, its projects — and of its own secrets'
// certificates (cross-posted from `/organizations/<orgId>/secrets/<name>`) into their catalog. No
// effect: a PURE FOLD. The facts are landed by the session on the context
// (session.ts `foldPlatformFacts`) after the control-plane database writes them. Pure, so a
// unit test constructs it with `new` and reduces rows (processor.test.ts).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { reduceSecretCatalog } from "../secret/contract.ts";
import {
  dropMembership,
  OrganizationContract,
  reduceMembership,
  type OrganizationState,
} from "./contract.ts";

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
    // Every fact folded here is the platform's to write (`source.platform`, caller.ts
    // `Caller.platform`): a member can append any type to the organization's context, and that one
    // stays on the log, attributed to them, and changes nothing.
    if (event.source?.platform !== true) return undefined;
    switch (event.type) {
      case "events.iterate.com/organization/created":
      case "events.iterate.com/organization/renamed":
        return { ...state, name: event.payload.name };
      case "events.iterate.com/organization/deleted":
        return state.deletedAt ? undefined : { ...state, deletedAt: event.createdAt };
      case "events.iterate.com/organization/member-added": {
        const { userId, role } = event.payload;
        const members = reduceMembership(state.members, userId, role, event.createdAt);
        return members && { ...state, members };
      }
      case "events.iterate.com/organization/member-removed": {
        const members = dropMembership(state.members, event.payload.userId);
        return members && { ...state, members };
      }
      case "events.iterate.com/organization/invitation-created": {
        const { invitationId, ...invitation } = event.payload;
        if (state.invitations[invitationId]) return undefined;
        return {
          ...state,
          invitations: {
            ...state.invitations,
            [invitationId]: { ...invitation, createdAt: event.createdAt },
          },
        };
      }
      // used or withdrawn, the link is no longer open: its row goes (the log keeps the history)
      case "events.iterate.com/organization/invitation-accepted":
      case "events.iterate.com/organization/invitation-revoked": {
        const { [event.payload.invitationId]: gone, ...invitations } = state.invitations;
        return gone && { ...state, invitations };
      }
      case "events.iterate.com/organization/project-added": {
        const { projectId, slug } = event.payload;
        if (state.projects[projectId]) return undefined; // added once
        return {
          ...state,
          projects: { ...state.projects, [projectId]: { slug, createdAt: event.createdAt } },
        };
      }
      case "events.iterate.com/organization/project-removed": {
        const { [event.payload.projectId]: gone, ...projects } = state.projects;
        return gone && { ...state, projects };
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
