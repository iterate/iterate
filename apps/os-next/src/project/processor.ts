// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the birth certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace or an agent is born once, an MCP connection per grant — and a death certificate drops the entry), and THE SAGA — the project's
// creation, run from state at head: the config repo (`itx.repos.create("/repos/config")`, the same
// collection a caller uses), its seed committed when `main` is unborn (the homepage worker and an
// AGENTS.md, below), the project's ingress pointed at that commit (`project/ingress-configured`, the
// core's), then the certificate. Subscribed to `/` (the row `session.projects.create` enables), it
// runs again after every eviction: an attempt lost with an incarnation is simply run again by the
// next — the repo tolerates existing, the seed is skipped once `main` has a tip, the ingress append
// is keyed by the commit, the certificate is keyed. The host's `withItx` is its one constructor
// argument; a unit test constructs it with `new` and reduces rows (processor.test.ts, in node); the
// saga is proven on the worker (e2e/session.e2e.test.ts: the catalog, the apex answering the seed).
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import type { WithItx } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";

export class ProjectProcessor extends StreamProcessor<
  ProjectState,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  constructor(private readonly withItx: WithItx<ItxEntrypointScope>) {
    super();
  }

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
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/repo/created":
        if (state.repos[event.payload.path]) return undefined;
        return {
          ...state,
          repos: { ...state.repos, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/repo/deleted": {
        if (!state.repos[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...repos } = state.repos;
        return { ...state, repos };
      }
      case "events.iterate.com/workspace/created":
        if (state.workspaces[event.payload.path]) return undefined;
        return {
          ...state,
          workspaces: { ...state.workspaces, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/workspace/deleted": {
        if (!state.workspaces[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...workspaces } = state.workspaces;
        return { ...state, workspaces };
      }
      case "events.iterate.com/agent/created":
        if (state.agents[event.payload.path]) return undefined;
        return {
          ...state,
          agents: { ...state.agents, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/agent/deleted": {
        if (!state.agents[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...agents } = state.agents;
        return { ...state, agents };
      }
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
  }: ProcessEventArgs<
    ProjectState,
    ConsumedEvent<typeof ProjectContract>,
    EmittedEventInput<typeof ProjectContract>
  >): undefined {
    // THE SAGA — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs it again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight). Every step is idempotent
    // on its own: the config repo's create answers at once for a created repo, the seed is committed
    // only onto an unborn `main`, the ingress append is keyed by the commit it points at, the
    // certificate is keyed.
    if (!delivery.caughtUp || state.creation?.status !== "requested" || this.#creating) return;
    this.#creating = true;
    runInBackground(async () => {
      try {
        await this.withItx((itx) => itx.repos.create("/repos/config"));
        const config = (itx: ItxEntrypointScope) => itx.repos.get("/repos/config");
        // Over the loopback stub a facet call's answer types as an RPC result; the wire copied it.
        let commitOid = (await this.withItx((itx) => config(itx).tip())) as unknown as
          | string
          | null;
        if (!commitOid) {
          const seeded = (await this.withItx((itx) =>
            config(itx).commitFiles({
              message: "seed: the project's homepage worker and AGENTS.md",
              // THE SEED: `worker.ts`, the project's homepage — plain JavaScript (the loader executes
              // what it reads; `.ts` is a name) a project edits in place — and an AGENTS.md saying what
              // the repo is. Committed once, onto an unborn `main`; the ingress is pointed at this
              // commit below, so a later commit is published by appending
              // `project/ingress-configured` for its oid (the website-publication e2e is the recipe).
              changes: [
                {
                  path: "worker.ts",
                  content: `import { WorkerEntrypoint } from "cloudflare:workers";

// The project's homepage: what its apex answers. Edit and commit; then publish the commit by
// appending events.iterate.com/project/ingress-configured on / with the new commitOid.
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const { projectSlug } = await this.env.ITX.get().whoami();
    return new Response("Homepage of project " + projectSlug + "\\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
`,
                },
                {
                  path: "AGENTS.md",
                  content: `# Project configuration

This repository is the project's executable configuration. \`worker.ts\` is the project's homepage
worker (its \`fetch\` answers the project's apex); the platform seeded both files when the project was
created and never touches them again. Commit changes, then publish the commit by appending
\`events.iterate.com/project/ingress-configured\` on the project's root context with the commit's oid.
`,
                },
              ],
            }),
          )) as unknown as { commitOid: string | null };
          commitOid = seeded.commitOid;
        }
        if (!commitOid) throw new Error("the config repo's seed left main unborn");
        await append(
          {
            type: "events.iterate.com/project/ingress-configured",
            idempotencyKey: `project/ingress-configured:${commitOid}`,
            payload: {
              target: [
                "itx",
                "workers",
                [
                  "get",
                  {
                    source: [
                      "itx",
                      "repos",
                      ["get", "/repos/config"],
                      ["readFile", "worker.ts", { commitOid }],
                    ],
                    cacheKey: commitOid,
                  },
                ],
              ],
            },
          },
          {
            type: "events.iterate.com/project/created",
            payload: {},
            idempotencyKey: "project/created",
          },
        );
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
