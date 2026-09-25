// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace is born once; a secret's latest `set` is its
// row — and a death certificate drops the entry; the config repo's commits, whose latest is the tip
// the apex follows), and TWO EFFECTS, each run from state at head. THE CREATION SAGA: the config repo
// (`itx.repos.create("/repos/config")`, the same collection a caller uses), its seed committed when
// `main` is unborn (the homepage worker and an AGENTS.md, below), the project's ingress pointed at
// that commit (`itx/ingress-configured`, the core's), then the certificate. THE APEX FOLLOWING
// THE CONFIG REPO: every `repo/commit-completed` from `/repos/config` re-points the ingress at that
// commit — publishing a config-repo website needs a commit, not a manual ingress event.
// Subscribed to `/` (the row `session.projects.create` enables), it runs again after every eviction:
// an attempt lost with an incarnation is simply run again by the next — the repo tolerates existing,
// a born `main` refuses the seed, every ingress append is keyed by the commit it points at, the
// certificate is keyed. The host's `withItx` and the template download are its constructor
// arguments; a unit test constructs it with `new` and reduces rows (processor.test.ts, in node) or
// hands it a fake download (templates.test.ts); the effects are proven on
// the worker (e2e/session.e2e.test.ts: the catalog, the apex answering the seed;
// e2e/website-publication.e2e.test.ts: a commit publishes).

import { z } from "zod";
import { jsonEqual } from "iterate/lib";
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

/** The shape `configRepoIngressTarget` writes, read back: the commit is its cache key. */
const ConfigRepoIngressTarget = z.tuple([
  z.literal("itx"),
  z.literal("workers"),
  z.tuple([z.literal("get"), z.object({ source: z.unknown(), cacheKey: z.string().min(1) })]),
]);

/** The commit an ingress target publishes: the one `configRepoIngressTarget` names, when the target
 *  is exactly what it writes for it; null for any other target, a worker set by hand or none. */
function configRepoCommitOf(target: unknown): string | null {
  const commitOid = ConfigRepoIngressTarget.safeParse(target).data?.[2][1].cacheKey;
  return commitOid && jsonEqual(target, configRepoIngressTarget(commitOid)) ? commitOid : null;
}

/** The files of a config-repo template, which seed a project created from one: the host passes
 *  `downloadPublicGithubTemplate` (repo/github-template.ts). */
type TemplateDownload = (
  reference: ConfigRepoTemplateReference,
) => Promise<Array<{ content: string; path: string }>>;

/** What the custom-hostname effect reaches, for THIS project (durable-object.ts builds it): the
 *  deployment's reserved zones, the control plane's hostname table and the project's primary
 *  hostname there, and Cloudflare — null when the deployment cannot provision one (no
 *  `customHostnames` block, or no token). */
export type ProjectHostnames = {
  reservedZones: readonly string[];
  claim(hostname: string): Promise<void>;
  release(hostname: string): Promise<void>;
  setPrimaryHostname(hostname: string | null): Promise<void>;
  provider: CustomHostnameProvider | null;
};

/** Whether a hostname serves: Cloudflare says its hostname and its certificate are both active —
 *  what a primary hostname must be. */
const hostnameIsLive = (entry: ProjectState["hostnames"][string] | undefined) =>
  entry?.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active";

/** What the deletion saga reaches, for THIS project (durable-object.ts builds it): the registry of
 *  its contexts (a table in the facet's own storage, kept from `itx/child-created`), a context's
 *  destruction, and the project's own kv, files and Artifacts repos. */
export type ProjectDeletion = {
  /** A descendant announced itself: its row in the registry. */
  recordContext(path: string): void;
  /** A descendant was destroyed: its row goes. */
  forgetContext(path: string): void;
  /** Every descendant the registry names (never `/`). */
  contextPaths(): Promise<string[]>;
  /** Everything the context at `path` holds goes: its log, its facets' storage, its alarm. */
  destroyContext(path: string): Promise<void>;
  /** The project's kv keys, files and Artifacts repos. */
  deleteProjectStorage(): Promise<void>;
};

export class ProjectProcessor extends StreamProcessor<
  ProjectState,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly downloadTemplate: TemplateDownload;
  private readonly hostnames: () => ProjectHostnames | null;
  private readonly deletion: () => ProjectDeletion | null;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    downloadTemplate: TemplateDownload,
    hostnames: () => ProjectHostnames | null = () => null,
    deletion: () => ProjectDeletion | null = () => null,
  ) {
    super();
    this.withItx = withItx;
    this.downloadTemplate = downloadTemplate;
    this.hostnames = hostnames;
    this.deletion = deletion;
  }

  /** This incarnation's deletion attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.deletion`. */
  #deleting = false;

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
   *  and the offset it has published. The durable ground is the keyed ingress event itself, reduced
   *  into `state.publishedCommitOid`: a delivery whose state holds the tip's publication marks it
   *  published, so a fresh incarnation owes nothing for a commit an earlier one published. The
   *  state learns of this incarnation's own append a delivery later, so the mark is kept here too.
   *  One attempt runs at a time and DRAINS: a tip that arrives while an append is in flight is
   *  published by the same attempt once that append settles, without waiting for another delivery
   *  (an idempotent hit lands no fresh event to be delivered). */
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
      case "events.iterate.com/project/delete-requested":
        // The platform's fact alone (the session appends it once the control plane dropped the
        // row): a member can append this type to `/`, and theirs deletes nothing.
        if (event.source?.platform !== true || state.deletion) return undefined;
        return { ...state, deletion: { offset: event.offset } };
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
      case "events.iterate.com/project/hostname-add-settled": {
        // it settles only its own request — one asked since stays owed; one that lands after a
        // remove was asked changes nothing; a failure keeps what Cloudflare last said
        const { hostname, requestOffset, cloudflare, error } = event.payload;
        const known = state.hostnames[hostname];
        if (!known || known.requested?.verb === "remove") return undefined;
        const requested = known.requested?.offset === requestOffset ? null : known.requested;
        const settled = { requested, cloudflare: cloudflare || known.cloudflare, error };
        return {
          ...state,
          hostnames: { ...state.hostnames, [hostname]: settled },
          // a primary that stops serving is no longer primary
          primaryHostname:
            state.primaryHostname === hostname && !hostnameIsLive(settled)
              ? null
              : state.primaryHostname,
        };
      }
      case "events.iterate.com/project/hostname-remove-requested": {
        const known = state.hostnames[event.payload.hostname];
        if (!known) return undefined;
        return {
          ...state,
          primaryHostname:
            state.primaryHostname === event.payload.hostname ? null : state.primaryHostname,
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
      case "events.iterate.com/project/primary-hostname-configured": {
        // only a live hostname the project holds becomes primary; null clears it
        const { hostname } = event.payload;
        if (hostname === state.primaryHostname) return undefined;
        if (hostname && !hostnameIsLive(state.hostnames[hostname])) return undefined;
        return { ...state, primaryHostname: hostname };
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
      case "events.iterate.com/itx/child-created":
        if (state.contexts[event.payload.childPath]) return undefined;
        return {
          ...state,
          contexts: {
            ...state.contexts,
            [event.payload.childPath]: { createdAt: event.createdAt },
          },
        };
      case "events.iterate.com/repo/commit-completed":
        // Only the config repo moves the apex; another repo's commit is a fact for its own log.
        if (event.payload.path !== "/repos/config") return undefined;
        return {
          ...state,
          configRepoTip: { commitOid: event.payload.commitOid, offset: event.offset },
        };
      case "events.iterate.com/itx/ingress-configured": {
        // A target set by hand publishes no commit and moves nothing: the appends below are keyed
        // by their commit, so a commit once published is never owed again, whatever the apex names.
        const commitOid = configRepoCommitOf(event.payload.target);
        if (!commitOid || commitOid === state.publishedCommitOid) return undefined;
        return { ...state, publishedCommitOid: commitOid };
      }
      default:
        return undefined;
    }
  }

  override processEvent({
    event,
    state,
    previousState,
    delivery,
    append,
    blockProcessorWhile,
    runInBackground,
  }: ProcessEventArgs<
    ProjectState,
    ConsumedEvent<typeof ProjectContract>,
    EmittedEventInput<typeof ProjectContract>
  >): undefined {
    // THE PRIMARY HOSTNAME, published to the control plane (the edge's redirect and `itx.url` read
    // it there) by the event that changed it: the cursor waits for the write, so an eviction or a
    // failed write runs it again, and every write is the value as of its event, in log order.
    if (state.primaryHostname !== previousState.primaryHostname)
      blockProcessorWhile(
        async () => await this.hostnames()?.setPrimaryHostname(state.primaryHostname),
      );
    // THE REGISTRY of the project's contexts, kept on every delivery (catch-up included): a row per
    // announced descendant (`recordContext` keeps only a canonical path below `/`). A member can
    // append this type too; a row it adds is one more context of this project the saga destroys.
    if (event?.type === "events.iterate.com/itx/child-created")
      this.deletion()?.recordContext(event.payload.childPath);
    if (!delivery.caughtUp) return;
    // THE DELETION SAGA — state-derived, at head, in the background, and alone: a project being
    // deleted starts none of the sagas below, and this one first waits out any this incarnation
    // already started. Deepest context first, so a retried destruction of one (which wakes it, and
    // it announces itself) only reaches ancestors that still exist; each destroyed context's row goes
    // as it goes, so a pass after an eviction resumes where the last stopped, and `context-deleted`
    // records it. Then each custom hostname at Cloudflare and then its claim (the claim outlives the
    // project's row, so no other project takes the name while Cloudflare still has it), kv, files and
    // Artifacts repos, the certificate, and `/` itself — the context this runs in, so nothing follows
    // it. Only the platform's request opens it; none of the facts it writes are read back.
    if (state.deletion) {
      if (this.#deleting) return;
      const deletion = this.deletion();
      if (!deletion) return;
      this.#deleting = true;
      runInBackground(async () => {
        try {
          while (this.#creating || this.#publishing || this.#hostnameWork.size > 0)
            await new Promise((resolve) => setTimeout(resolve, 100));
          const paths = await deletion.contextPaths();
          paths.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
          for (const path of paths) {
            await deletion.destroyContext(path);
            deletion.forgetContext(path);
            await append({
              type: "events.iterate.com/project/context-deleted",
              idempotencyKey: `project/context-deleted:${path}`,
              payload: { path },
            });
          }
          for (const hostname of Object.keys(state.hostnames)) {
            const hostnames = this.hostnames();
            await hostnames?.provider?.remove(hostname);
            await hostnames?.release(hostname);
          }
          await deletion.deleteProjectStorage();
          await append({
            type: "events.iterate.com/project/deleted",
            idempotencyKey: "project/deleted",
            payload: {},
          });
          await deletion.destroyContext("/");
        } finally {
          this.#deleting = false;
        }
      });
      return;
    }
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
    // ONE event, and an attempt lost with an incarnation is run again by the next. A tip the state
    // already holds published is owed nothing: no append, and no background work to claim the
    // context's alarm for. The target is `configRepoIngressTarget`, the same one the saga writes
    // for the seed.
    if (state.configRepoTip) {
      this.#newestTip = state.configRepoTip;
      if (state.configRepoTip.commitOid === state.publishedCommitOid)
        this.#published = state.configRepoTip.offset;
    }
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
              type: "events.iterate.com/itx/ingress-configured",
              idempotencyKey: `itx/ingress-configured:${tip.commitOid}`,
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
        // THE SEED LANDS ONLY ON AN UNBORN `main` (`parent: null`), so it is committed without a read
        // of the tip first — one Artifacts round trip less on every creation, and the one that hung
        // 22.8 s (2026-09-24, the latency guard). A born `main` refuses it: an attempt of this saga
        // lost with an incarnation seeded it, or another commit got there first — `create` answers
        // before this certificate, so the config repo may be written meanwhile (a voice delegation's
        // website edit was, 2026-09-24, and the seed put the seed homepage back over it). Either
        // way `main`'s tip is the project's config and what the ingress names; a failure that left
        // `main` unborn — the template's download included — is the saga's own failure.
        let commitOid: string | null;
        const reference = state.creation?.configRepoTemplate;
        try {
          const changes = reference
            ? await this.downloadTemplate(parseConfigRepoTemplateReference(reference))
            : defaultFiles;
          if (!changes.some((file) => file.path === "worker.ts"))
            throw new Error("The config template needs a worker.ts entrypoint");
          const seeded = (await this.withItx((itx) =>
            config(itx).commitFiles({
              message: reference ? `seed: ${reference}` : "seed: minimal project config",
              changes,
              parent: null,
            }),
          )) as unknown as { commitOid: string | null };
          commitOid = seeded.commitOid;
        } catch (error) {
          // Over the loopback stub a facet call's answer types as an RPC result; the wire copied it.
          commitOid = (await this.withItx((itx) => config(itx).tip())) as unknown as string | null;
          if (!commitOid) throw error;
          console.info({
            event: "project.seed-on-born-main",
            namespace: "project",
            message:
              "the seed threw with main born — an earlier attempt seeded it, or a commit got there first (the seed refused itself), or the seed landed without its answer: main's tip is the project's config",
            commitOid,
            error: error instanceof Error ? error.message : String(error),
          });
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
              type: "events.iterate.com/itx/subscription-configured",
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
            type: "events.iterate.com/itx/ingress-configured",
            idempotencyKey: `itx/ingress-configured:${commitOid}`,
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
      type: "events.iterate.com/project/hostname-add-settled" as const,
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
