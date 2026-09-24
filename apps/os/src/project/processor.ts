// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace is born once; a secret's latest `set` is its
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
// at, the certificate is keyed. The host's `withItx` and the template download are its constructor
// arguments; a unit test constructs it with `new` and reduces rows (processor.test.ts, in node) or
// hands it a fake download (templates.test.ts); the effects are proven on
// the worker (e2e/session.e2e.test.ts: the catalog, the apex answering the seed;
// e2e/website-publication.e2e.test.ts: a commit publishes).

import { z } from "zod";
import {
  parseConfigRepoTemplateReference,
  type ConfigRepoTemplateReference,
} from "@iterate-com/shared/config-repo-template/reference";
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/stream/processor";
import type { WithItx } from "iterate/sdk";
import { defaultFiles } from "../generated/config-templates.js";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";
import { customHostnameProblem, type CustomHostnameProvider } from "./custom-hostnames.ts";

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

/** The files of a config-repo template, which seed a project created from one: the host passes
 *  `downloadPublicGithubTemplate` (@iterate-com/shared/config-repo-template/github). */
type TemplateDownload = (
  reference: ConfigRepoTemplateReference,
) => Promise<Array<{ content: string; path: string }>>;

/** What the custom-hostname effect reaches, for THIS project (durable-object.ts builds it): the
 *  deployment's reserved zones, the control plane's hostname table, and Cloudflare — null when the
 *  deployment cannot provision one (no `customHostnames` block, or no token). */
export type ProjectHostnames = {
  reservedZones: readonly string[];
  claim(hostname: string): Promise<void>;
  release(hostname: string): Promise<void>;
  provider: CustomHostnameProvider | null;
};

export class ProjectProcessor extends StreamProcessor<
  ProjectState,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly downloadTemplate: TemplateDownload;
  private readonly hostnames: () => ProjectHostnames | null;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    downloadTemplate: TemplateDownload,
    hostnames: () => ProjectHostnames | null = () => null,
  ) {
    super();
    this.withItx = withItx;
    this.downloadTemplate = downloadTemplate;
    this.hostnames = hostnames;
  }

  /** The hostnames this incarnation is working on — ONE worker per hostname, so an add and a remove
   *  (or two adds) never race each other's claim — and the newest state any delivery has shown. A
   *  worker DRAINS: a request that arrives while it runs is run by the same worker once its answer
   *  lands, without waiting for another delivery. The durable ground is `state.hostnames[…].requested`. */
  #hostnameWork = new Set<string>();
  #newestHostnames: ProjectState["hostnames"] = {};

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
          : {
              ...state,
              creation: {
                status: "requested",
                offset: event.offset,
                configRepoTemplate: event.payload.configRepoTemplate,
              },
            };
      case "events.iterate.com/project/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/project/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/project/hostname-add-requested": {
        const known = state.hostnames[event.payload.hostname];
        return {
          ...state,
          hostnames: {
            ...state.hostnames,
            [event.payload.hostname]: {
              requested: { verb: "add", offset: event.offset },
              cloudflare: known?.cloudflare ?? null,
              error: null,
            },
          },
        };
      }
      case "events.iterate.com/project/hostname-add-answered": {
        // it settles only its own request — one asked since stays owed; one that lands after a
        // remove was asked changes nothing; a failure keeps what Cloudflare last said
        const { hostname, requestOffset, cloudflare, error } = event.payload;
        const known = state.hostnames[hostname];
        if (!known || known.requested?.verb === "remove") return undefined;
        const requested = known.requested?.offset === requestOffset ? null : known.requested;
        return {
          ...state,
          hostnames: {
            ...state.hostnames,
            [hostname]: { requested, cloudflare: cloudflare || known.cloudflare, error },
          },
        };
      }
      case "events.iterate.com/project/hostname-remove-requested": {
        const known = state.hostnames[event.payload.hostname];
        if (!known) return undefined;
        return {
          ...state,
          hostnames: {
            ...state.hostnames,
            [event.payload.hostname]: {
              ...known,
              requested: { verb: "remove", offset: event.offset },
            },
          },
        };
      }
      case "events.iterate.com/project/hostname-removed": {
        const { hostname, requestOffset } = event.payload;
        const known = state.hostnames[hostname];
        if (!known) return undefined;
        // an add asked since the remove stays owed, from nothing
        if (known.requested && known.requested.offset !== requestOffset)
          return {
            ...state,
            hostnames: { ...state.hostnames, [hostname]: { ...known, cloudflare: null } },
          };
        const { [hostname]: _gone, ...hostnames } = state.hostnames;
        return { ...state, hostnames };
      }
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
    // THE CUSTOM HOSTNAMES — state-derived, at head, in the background: the request each hostname
    // still owes, one hostname at a time, and any later delivery runs it again after an eviction.
    // Every step is idempotent: the claim for the same project, Cloudflare's find-or-create and
    // delete, the answer keyed by the request's offset.
    this.#newestHostnames = state.hostnames;
    for (const [hostname, entry] of Object.entries(state.hostnames)) {
      if (!entry.requested || this.#hostnameWork.has(hostname)) continue;
      this.#hostnameWork.add(hostname);
      runInBackground(async () => {
        try {
          // Drain: the newest request as of each pass, never the one just answered again. Whether
          // the hostname is serving is the worker's own to carry: the state it drains from may not
          // have reduced its last answer yet.
          let answered = 0;
          let serving = Boolean(entry.cloudflare);
          for (
            let owed = entry;
            owed?.requested && owed.requested.offset !== answered;
            owed = this.#newestHostnames[hostname]
          ) {
            const { verb, offset } = owed.requested;
            const answer =
              verb === "add"
                ? await this.#addHostname(hostname, offset, serving)
                : await this.#removeHostname(hostname, offset);
            await append(answer);
            serving =
              "cloudflare" in answer.payload ? serving || !!answer.payload.cloudflare : false;
            answered = offset;
          }
        } finally {
          this.#hostnameWork.delete(hostname);
        }
      });
    }
    // THE APEX FOLLOWS THE CONFIG REPO — state-derived, at head, in the background: the latest commit
    // of `/repos/config` (its fact cross-posted here by the repo facet) is published by pointing the
    // ingress at it, keyed by the commit, so this and the seed's own append in the saga below land
    // ONE event, and an attempt lost with an incarnation is run again by the next for nothing. The
    // target is `configRepoIngressTarget`, the same one the saga writes for the seed.
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
          const reference = state.creation?.configRepoTemplate;
          const changes = reference
            ? await this.downloadTemplate(parseConfigRepoTemplateReference(reference))
            : defaultFiles;
          if (!changes.some((file) => file.path === "worker.ts"))
            throw new Error("The config template needs a worker.ts entrypoint");
          const seeded = (await this.withItx((itx) =>
            config(itx).commitFiles({
              message: reference ? `seed: ${reference}` : "seed: minimal project config",
              changes,
            }),
          )) as unknown as { commitOid: string | null };
          commitOid = seeded.commitOid;
        }
        if (!commitOid) throw new Error("the config repo's seed left main unborn");
        const manifestText = await this.withItx((itx) =>
          config(itx).readFile("iterate.json", { commitOid: commitOid! }),
        );
        const manifest = z
          .object({ events: z.array(z.string().min(1)).default([]) })
          .parse(manifestText ? JSON.parse(manifestText) : {});
        if (manifest.events.length) {
          await this.withItx((itx) =>
            itx.append({
              type: "events.iterate.com/stream/subscription-configured",
              idempotencyKey: `project/config-worker:${commitOid}`,
              payload: {
                name: "config-worker",
                consumes: manifest.events,
                target: [...configRepoIngressTarget(commitOid), "processEventBatch"],
              },
            }),
          );
        }
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

  /** Claim the hostname, then find-or-create its custom hostname: the answer to an add. A refusal
   *  after the claim releases it unless the hostname was already serving (a failed re-check keeps it). */
  async #addHostname(hostname: string, offset: number, provisioned: boolean) {
    const hostnames = this.hostnames();
    let cloudflare = null;
    let error = null;
    let claimed = false;
    try {
      if (!hostnames?.provider) throw new Error("This deployment cannot add custom hostnames.");
      const problem = customHostnameProblem(hostname, hostnames.reservedZones);
      if (problem) throw new Error(problem);
      await hostnames.claim(hostname);
      claimed = true;
      cloudflare = await hostnames.provider.provision(hostname);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (claimed && !provisioned) await hostnames!.release(hostname);
    }
    return {
      type: "events.iterate.com/project/hostname-add-answered" as const,
      idempotencyKey: `project/hostname-add:${hostname}:${offset}`,
      payload: { hostname, requestOffset: offset, cloudflare, error },
    };
  }

  /** Delete the custom hostname, then release the claim: the answer to a remove. */
  async #removeHostname(hostname: string, offset: number) {
    const hostnames = this.hostnames();
    await hostnames?.provider?.remove(hostname);
    await hostnames?.release(hostname);
    return {
      idempotencyKey: `project/hostname-remove:${hostname}:${offset}`,
      type: "events.iterate.com/project/hostname-removed" as const,
      payload: { hostname, requestOffset: offset },
    };
  }
}
