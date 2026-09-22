// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace or an agent is born once; a secret's latest `set` is its
// row — and a death certificate drops the entry; the config repo's commits, whose latest is the tip
// the apex follows), and TWO EFFECTS, each run from state at head. THE CREATION SAGA: the config repo
// (`itx.repos.create("/repos/config")`, the same collection a caller uses), its seed committed when
// `main` is unborn (the homepage worker and an AGENTS.md, below), the project's ingress pointed at
// that commit (`project/ingress-configured`, the core's), then the certificate. THE APEX FOLLOWING
// THE CONFIG REPO: every `repo/commit-completed` from `/repos/config` re-points the ingress at that
// commit — publishing a config-repo website needs a commit, not a manual ingress event.
// Subscribed to `/` (the row `session.projects.create` enables), it runs again after every eviction:
// an attempt lost with an incarnation is simply run again by the next — the repo tolerates existing,
// the seed is skipped once `main` has a tip, every ingress append is keyed by the commit it points
// at, the certificate is keyed. The host's `withItx` is its one constructor argument; a unit test
// constructs it with `new` and reduces rows (processor.test.ts, in node); the effects are proven on
// the worker (e2e/session.e2e.test.ts: the catalog, the apex answering the seed;
// e2e/website-publication.e2e.test.ts: a commit publishes).
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import type { WithItx } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";

/** Where the apex points for the config repo at `commitOid`: the repo's whole tree at that exact
 *  commit as the worker's modules (`worker.ts` the main module, every `.js` file under its own path,
 *  so relative imports resolve as in the tree — the repo facet's `modules`), cached under the
 *  commit. The saga writes it for the seed and the follower for every later commit — the same
 *  target under the same key, so the two appends land one event. */
function configRepoIngressTarget(commitOid: string) {
  return [
    "itx",
    "workers",
    [
      "get",
      {
        source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid }]],
        cacheKey: commitOid,
      },
    ],
  ];
}

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
  /** The apex following the config repo: the newest tip any delivery has shown this incarnation,
   *  and the offset it has published — the durable ground is the keyed ingress event itself, so a
   *  fresh incarnation appending again for the same commit lands nothing. One attempt runs at a
   *  time and DRAINS: a tip that arrives while an append is in flight is published by the same
   *  attempt once that append settles, without waiting for another delivery (an idempotent hit
   *  lands no fresh event to be delivered). */
  #newestTip: { commitOid: string; offset: number } | null = null;
  #published: number | null = null;
  #publishing = false;

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
      case "events.iterate.com/secret/set":
      case "events.iterate.com/secret/deleted": {
        const secrets = reduceSecretCatalog(state.secrets, event);
        return secrets && { ...state, secrets };
      }
      case "events.iterate.com/repo/commit-completed":
        // Only the config repo moves the apex; another repo's commit is a fact for its own log.
        if (event.payload.path !== "/repos/config") return undefined;
        return {
          ...state,
          configRepoTip: { commitOid: event.payload.commitOid, offset: event.offset },
        };
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
    if (!delivery.caughtUp) return;
    // THE APEX FOLLOWS THE CONFIG REPO — state-derived, at head, in the background: the latest commit
    // of `/repos/config` (its fact cross-posted here by the repo facet) is published by pointing the
    // ingress at it, keyed by the commit, so this and the seed's own append in the saga below land
    // ONE event, and an attempt lost with an incarnation is run again by the next for nothing. The
    // target is the one the saga writes for the seed: the repo's whole tree at that exact commit as
    // the worker's modules (`worker.ts` the main module, every `.js` file under its own path, so
    // relative imports resolve as in the tree — the repo facet's `modules`), cached under the commit.
    if (state.configRepoTip) this.#newestTip = state.configRepoTip;
    if (this.#newestTip && this.#published !== this.#newestTip.offset && !this.#publishing) {
      this.#publishing = true;
      runInBackground(async () => {
        try {
          // Drain: the newest tip as of each pass — one that landed during the append is next.
          for (
            let tip = this.#newestTip;
            tip && this.#published !== tip.offset;
            tip = this.#newestTip
          ) {
            await append({
              type: "events.iterate.com/project/ingress-configured",
              idempotencyKey: `project/ingress-configured:${tip.commitOid}`,
              payload: { target: configRepoIngressTarget(tip.commitOid) },
            });
            this.#published = tip.offset;
          }
        } finally {
          this.#publishing = false;
        }
      });
    }
    // THE SAGA — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs it again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight). Every step is idempotent
    // on its own: the config repo's create answers at once for a created repo, the seed is committed
    // only onto an unborn `main`, the ingress append is keyed by the commit it points at, the
    // certificate is keyed.
    if (state.creation?.status !== "requested" || this.#creating) return;
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
              // commit below, and at every later commit by the follower above (the
              // website-publication e2e is the proof).
              changes: [
                {
                  path: "worker.ts",
                  content: `import { WorkerEntrypoint } from "cloudflare:workers";

// The project's homepage: what its apex answers. Edit and commit — a commit on this repo's main IS
// its publication: the platform points the apex at the new commit within a moment.
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
created and never touches them again. A commit on \`main\` IS its publication: the platform points the
apex at the new commit within a moment (the project processor follows this repo's commits). The whole
tree rides along: \`worker.ts\` may import any \`.js\` file in the repo by its relative path, and each
runs as a JavaScript module (\`.js\` is the one name the loader takes a module under; \`worker.ts\` is
the seed's name and runs as the main module). Keep them valid JavaScript — a broken commit takes the
site down until the next one.
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
            payload: { target: configRepoIngressTarget(commitOid) },
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
