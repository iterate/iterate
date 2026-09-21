// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the birth certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace or an agent is born once, an MCP client connects once per grant), and THE SAGA — the
// project's creation, run from state at head. Subscribed to `/` (the row `session.projects.create`
// enables), it runs again after every eviction: an attempt lost with an incarnation is simply run
// again by the next, and the certificate is keyed. Pure — nothing here reads itx today, so it takes
// no constructor argument — and a unit test constructs it with `new` and reduces rows
// (processor.test.ts, in node); the saga is proven on the worker (e2e/session.e2e.test.ts).
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import { ProjectContract, type ProjectState } from "./contract.ts";

export class ProjectProcessor extends StreamProcessor<
  ProjectState,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  /** This incarnation's creation attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.creation`. */
  #creating = false;

  override reduce({
    event,
    state,
  }: ReduceArgs<ProjectState, ConsumedEvent<typeof ProjectContract>>): ProjectState | undefined {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new attempt.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "requested", offset: event.offset } };
      case "events.iterate.com/project/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/project/create-failed":
        return { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/repo/created":
        if (state.repos[event.payload.path]) return undefined;
        return {
          ...state,
          repos: { ...state.repos, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/workspace/created":
        if (state.workspaces[event.payload.path]) return undefined;
        return {
          ...state,
          workspaces: { ...state.workspaces, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/agent/created":
        if (state.agents[event.payload.path]) return undefined;
        return {
          ...state,
          agents: { ...state.agents, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/project/mcp-connection-created": {
        const { grantId, path } = event.payload;
        if (state.mcpConnections[grantId]) return undefined;
        return {
          ...state,
          mcpConnections: {
            ...state.mcpConnections,
            [grantId]: { path, createdAt: event.createdAt },
          },
        };
      }
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<ProjectState, ConsumedEvent<typeof ProjectContract>>): undefined {
    // THE SAGA — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs it again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight). The platform provisions
    // NOTHING for a project yet: the certificate is the whole saga. The seeded config repo and the
    // ingress (docs/project-creation.md) go here, through the same `itx.repos.create("/repos/config")`
    // a caller uses — a withItx constructor argument the day something reads it.
    if (!delivery.caughtUp || state.creation?.status !== "requested" || this.#creating) return;
    this.#creating = true;
    runInBackground(async () => {
      try {
        await append({
          type: "events.iterate.com/project/created",
          payload: {},
          idempotencyKey: "project/created",
        });
      } catch (error) {
        await append({
          type: "events.iterate.com/project/create-failed",
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.#creating = false;
      }
    });
  }
}
