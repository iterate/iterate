// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace is born once; a secret's latest `set` is its
// row — and a death certificate drops the entry; the config repo's commits, whose latest is the tip
// the apex follows), and TWO EFFECTS, each run from state at head. THE CREATION SAGA: the config repo
// (`itx.repos.create("/repos/config")`, the same collection a caller uses), its seed committed when
// `main` is unborn (the homepage worker and an AGENTS.md, below), that commit published, then the
// certificate. THE CONFIG WORKER FOLLOWING THE CONFIG REPO: every `repo/commit-completed` from
// `/repos/config` publishes that commit — the ingress (`itx/ingress-configured`, the core's) and
// the config worker's subscription (`itx/subscription-configured`) both re-pointed at it in one
// append — so publishing a config-repo website or processEvent needs a commit, nothing by hand.
// Subscribed to `/` (the row `session.projects.create` enables), it runs again after every eviction:
// an attempt lost with an incarnation is simply run again by the next — the repo tolerates existing,
// a born `main` refuses the seed, every publication is keyed (the saga's by its commit, every
// later one by the commit's fact), the certificate is keyed. The host's `withItx` and the template download are its constructor
// arguments; a unit test constructs it with `new` and reduces rows (processor.test.ts, in node) or
// hands it a fake download (templates.test.ts); the effects are proven on
// the worker (e2e/session.e2e.test.ts: the catalog, the apex answering the seed;
// e2e/website-publication.e2e.test.ts: a commit publishes; e2e/config-worker.e2e.test.ts: a commit
// moves processEvent with fetch).

import { z } from "zod";
import { jsonEqual, resolveContextPath } from "iterate/lib";
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
import { pinPkgPrNewDependencies } from "@iterate-com/shared/pkg-pr-new";
import { defaultFiles } from "../generated/config-templates.js";
import { readPackage } from "../context/module-resolution.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { reduceIntegrations } from "../integrations/contract.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";
import { customHostnameProblem, type CustomHostnameProvider } from "./custom-hostnames.ts";
import type { DomainConnectLink } from "./domain-connect.ts";

/** Where the apex points for the config repo at `commitOid`: the repo's whole tree at that exact
 *  commit as the worker's modules (package.json's `main` the main module, every `.js` file under
 *  its own path, so relative imports resolve as in the tree — the repo facet's `modules`), cached
 *  under the commit. The saga writes it for the seed and the follower for every later commit — the same
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

/** What a config repo's `iterate.json` declares: the events its worker's `processEventBatch` is
 *  handed. */
const ConfigRepoManifest = z.object({ events: z.array(z.string().min(1)).default([]) });

/** THE PUBLICATION of the config repo at `commitOid`, one append: the apex points at the worker at
 *  that commit, and the `config-worker` subscription hands that same worker the `events` its
 *  `iterate.json` names (a commit that names none removes the row), so fetch and processEvent run
 *  one version of the config worker at a time. Keyed by `key`, so a publication run again lands
 *  nothing twice. A replaced row's cursor starts again (stream/subscription-delivery.ts): at
 *  `afterOffset` when given, else at the publication (the append boundary drops an undefined one). */
function configRepoPublication(
  commitOid: string,
  events: string[],
  { key, afterOffset }: { key: string; afterOffset?: number },
) {
  const target = configRepoIngressTarget(commitOid);
  return [
    {
      type: "events.iterate.com/itx/ingress-configured" as const,
      idempotencyKey: `itx/ingress-configured:${key}`,
      payload: { target },
    },
    {
      type: "events.iterate.com/itx/subscription-configured" as const,
      idempotencyKey: `project/config-worker:${key}`,
      payload: events.length
        ? {
            name: "config-worker",
            consumes: events,
            target: [...target, "processEventBatch"],
            afterOffset,
          }
        : { name: "config-worker", target: null },
    },
  ];
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
  /** The signed Domain Connect link that writes `hostname`'s records at its DNS provider, or null
   *  (domain-connect.ts `domainConnectLinkOf`). */
  connect(hostname: string): Promise<DomainConnectLink | null>;
  /** The zone `hostname` lives in and who hosts it, by a provider id the dash has instructions
   *  for (dns-provider.ts `dnsZoneOf`). */
  dnsZone(hostname: string): Promise<{ zone: string; provider: string | null } | null>;
};

/** Whether a hostname serves: Cloudflare says its hostname and its certificate are both active —
 *  what a primary hostname must be. */
const hostnameIsLive = (entry: ProjectState["hostnames"][string] | undefined) =>
  entry?.cloudflare?.status === "active" && entry.cloudflare.sslStatus === "active";

/** What the deletion saga reaches, for THIS project (durable-object.ts builds it): a context's
 *  destruction, the Artifacts repo a context's path backs, and the project's own kv and files. The
 *  contexts it destroys, and whose repos it deletes, are the registry's (`state.contexts`). */
export type ProjectDeletion = {
  /** Everything the context at `path` holds goes: its log, its facets' storage, its alarm. The
   *  root's only once the catalog holds the project as deleted: before, it throws (the pass is run
   *  again). */
  destroyContext(path: string): Promise<void>;
  /** The Artifacts repo the context at `path` backs, deleted by its name: a repo's git is not in
   *  its context's storage, and the binding lists no repo by project, so the name is how a
   *  project's repo is found. Nothing to do for a path no repo can back, or one already gone. */
  deleteRepo(path: string): Promise<void>;
  /** The project's kv keys and files. */
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
   *  ground is `state.deletion`. `#deletionFailed`: this incarnation gave up after its bounded
   *  retries (`project/delete-failed` says why), so its own append does not start it again; a later
   *  incarnation does. `#newestState`: the newest state any delivery has shown, so an attempt that
   *  waited reads the contexts and hostnames registered meanwhile. */
  #deleting = false;
  #deletionFailed = false;
  #newestState: ProjectState | null = null;

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
   *  into `state.publishedCommitOid` and `publishedAt`: a delivery whose state holds the tip's
   *  publication, after the tip's fact, marks it
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
        // The platform's fact alone (the session appends it just before the control plane drops
        // the row): a member can append this type to `/`, and theirs deletes nothing.
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
              cloudflare: known?.cloudflare || null,
              error: null,
              connectedAt: event.payload.connected ? event.createdAt : known?.connectedAt || null,
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
        const settled = { ...known, requested, cloudflare: cloudflare || known.cloudflare, error };
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
      case "events.iterate.com/secret/deleted":
      case "events.iterate.com/secret/lent":
      case "events.iterate.com/secret/borrowed":
      case "events.iterate.com/secret/lend-revoked": {
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
      case "events.iterate.com/slack/connected":
      case "events.iterate.com/google/connected":
      case "events.iterate.com/cloudflare/connected":
      case "events.iterate.com/github/connected":
      case "events.iterate.com/waitrose/connected":
      case "events.iterate.com/slack/disconnected":
      case "events.iterate.com/google/disconnected":
      case "events.iterate.com/cloudflare/disconnected":
      case "events.iterate.com/github/disconnected":
      case "events.iterate.com/waitrose/disconnected": {
        const integrations = reduceIntegrations(state.integrations, event);
        return integrations && { ...state, integrations };
      }
      case "events.iterate.com/repo/commit-completed":
        // Only the config repo moves the apex; another repo's commit is a fact for its own log.
        if (event.payload.path !== "/repos/config") return undefined;
        return {
          ...state,
          configRepoTip: { commitOid: event.payload.commitOid, offset: event.offset },
        };
      case "events.iterate.com/itx/ingress-configured": {
        // A target set by hand publishes no commit and moves nothing. Every publication is recorded
        // with its offset: a pull can return main to a commit published before, which is owed again.
        const commitOid = configRepoCommitOf(event.payload.target);
        if (!commitOid) return undefined;
        return { ...state, publishedCommitOid: commitOid, publishedAt: event.offset };
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
    this.#newestState = state;
    // THE PRIMARY HOSTNAME, published to the control plane (the edge's redirect and `itx.url` read
    // it there) by the event that changed it: the cursor waits for the write, so an eviction or a
    // failed write runs it again, and every write is the value as of its event, in log order.
    if (state.primaryHostname !== previousState.primaryHostname)
      blockProcessorWhile(
        async () => await this.hostnames()?.setPrimaryHostname(state.primaryHostname),
      );
    if (!delivery.caughtUp) return;
    // THE DELETION SAGA — state-derived, at head, in the background, and alone: a project being
    // deleted starts none of the sagas below, and this one first waits out any this incarnation
    // already started. Each pass reads the NEWEST state, so a context announced while it waited
    // (the creation saga's `/repos/config`) is destroyed too; deepest first, so a retried
    // destruction (which wakes a context, and it announces itself) only reaches ancestors that still
    // exist. Nothing the saga writes is read back, so nothing a member appends can make it skip a
    // context: a pass after an eviction destroys every registered one again, harmlessly. A pass that
    // fails is run again twice (5 s, 30 s); then `project/delete-failed` records why, the engine
    // reports it, and this incarnation stops — a later one, woken by any delivery, starts again.
    // Only the platform's request opens it.
    if (state.deletion) {
      if (this.#deleting || this.#deletionFailed) return;
      const deletion = this.deletion();
      if (!deletion) return;
      this.#deleting = true;
      runInBackground(async () => {
        try {
          while (this.#creating || this.#publishing || this.#hostnameWork.size > 0)
            await new Promise((resolve) => setTimeout(resolve, 100));
          // Every step is idempotent, so a failed pass is run again, a bounded number of times, while
          // this attempt (and the engine's claim on the context's alarm) is still in flight.
          const retryDelaysMs = [5_000, 30_000];
          for (let retry = 0; ; retry += 1) {
            try {
              await this.#deletionPass(deletion, append);
              return;
            } catch (error) {
              if (retry < retryDelaysMs.length) {
                await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[retry]));
                continue;
              }
              this.#deletionFailed = true;
              await append({
                type: "events.iterate.com/project/delete-failed",
                payload: { error: error instanceof Error ? error.message : String(error) },
              });
              throw error; // the engine reports it (processor.background)
            }
          }
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
    // THE CONFIG WORKER FOLLOWS THE CONFIG REPO — state-derived, at head, in the background: the
    // latest commit of `/repos/config` (its fact cross-posted here by the repo facet) is published
    // (`configRepoPublication`), keyed by that fact, so an attempt lost with an incarnation is run
    // again by the next and lands nothing twice, and a return to a commit published before is a new
    // fact, published again. The worker at the commit is handed its own commit's fact onwards: the
    // previous version may have been handed it too (every delivery is at least once), never neither.
    // While the project is being created its saga publishes, the certificate in the same append;
    // a commit that lands meanwhile is published here once it has. A tip the state holds published
    // AFTER its fact is owed nothing: no append, and no background work to claim the context's
    // alarm for.
    if (state.configRepoTip) {
      this.#newestTip = state.configRepoTip;
      if (
        state.configRepoTip.commitOid === state.publishedCommitOid &&
        (state.publishedAt || 0) > state.configRepoTip.offset
      )
        this.#published = state.configRepoTip.offset;
    }
    if (
      state.creation?.status !== "requested" &&
      this.#newestTip &&
      this.#published !== this.#newestTip.offset &&
      !this.#publishing
    ) {
      this.#publishing = true;
      runInBackground(async () => {
        try {
          // Drain: the newest tip as of each pass — one that landed during the append is next.
          for (
            let tip = this.#newestTip;
            tip && this.#published !== tip.offset;
            tip = this.#newestTip
          ) {
            await append(
              ...configRepoPublication(
                tip.commitOid,
                await this.#configWorkerEventsAt(tip.commitOid),
                { key: `${tip.commitOid}@${tip.offset}`, afterOffset: tip.offset - 1 },
              ),
            );
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
    // only onto an unborn `main`, the publication is keyed by the commit it publishes, the
    // certificate is keyed. The certificate rides the publication's append: the config worker is
    // subscribed, and the apex answers, before `project/created`.
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
          // The seed pins its pkg.pr.new dependencies: a template's `…@main` means main's newest
          // build, and the loader refuses a ref that moves (@iterate-com/shared/pkg-pr-new). A ref
          // that cannot be pinned fails the creation, like a download that fails.
          const changes = await pinPkgPrNewDependencies(
            reference
              ? await this.downloadTemplate(parseConfigRepoTemplateReference(reference))
              : defaultFiles,
          );
          // The seed checks the template's entry with the loader's own rule (`readPackage`).
          readPackage(
            Object.fromEntries(changes.map((file) => [file.path, file.content])),
            "The config template",
          );
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
        await append(
          ...configRepoPublication(commitOid, await this.#configWorkerEventsAt(commitOid), {
            key: commitOid,
          }),
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

  /** The events the config repo's `iterate.json` names at `commitOid`: none without one. A manifest
   *  that is not `{ "events": [string] }` names none either, and the log says why: its commit is
   *  published all the same, its worker handed nothing, never the previous commit's worker. */
  async #configWorkerEventsAt(commitOid: string): Promise<string[]> {
    const text = await this.withItx((itx) =>
      itx.repos.get("/repos/config").readFile("iterate.json", { commitOid }),
    );
    let manifest: unknown = {};
    let error: unknown = null;
    try {
      if (text) manifest = JSON.parse(text);
    } catch (caught) {
      error = caught;
    }
    const parsed = ConfigRepoManifest.safeParse(manifest);
    if (!error && parsed.success) return parsed.data.events;
    console.info({
      event: "project.config-manifest-invalid",
      namespace: "project",
      message:
        "the config repo's iterate.json is not { events: [string] }: its commit's config worker is handed no events",
      commitOid,
      error: String(error ?? parsed.error),
    });
    return [];
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
      const observed = await hostnames.provider.provision(hostname);
      // while there is something to add: one click at the owner's DNS provider, and who that
      // provider is, for the instructions by hand — both best effort, a failure logged and left out
      const live = observed.status === "active" && observed.sslStatus === "active";
      const bestEffort = <T>(what: string, ask: () => Promise<T | null>) =>
        live
          ? null
          : ask().catch((caught: unknown) => {
              console.warn(`${what} for ${hostname}: ${String(caught)}`);
              return null;
            });
      const [connect, dns] = await Promise.all([
        bestEffort("domain connect", () => hostnames.connect(hostname)),
        bestEffort("dns zone", () => hostnames.dnsZone(hostname)),
      ]);
      cloudflare = { ...observed, connect, dns };
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

  /** One pass of the deletion saga, over the newest state: every registered context, deepest first,
   *  and the repo its path backs once it is destroyed (nothing left running there can create it
   *  again), until no context registered meanwhile is left; then each custom hostname at Cloudflare
   *  and then its claim; the project's storage; the certificate; and `/` last. The registry, not
   *  the catalog, names the repos: a repo's context announces itself when it wakes to run its
   *  creation, so the registry also holds a repo whose certificate never landed, and nothing a
   *  member appends drops an entry from it (a forged `repo/deleted` drops a catalog one). */
  async #deletionPass(
    deletion: ProjectDeletion,
    append: (event: EmittedEventInput<typeof ProjectContract>) => Promise<unknown>,
  ) {
    const destroyed = new Set<string>();
    for (;;) {
      // every descendant the registry names, as a canonical path below `/`: the root is last
      const paths = Object.keys(this.#newestState?.contexts ?? {}).filter(
        (path) => path !== "/" && resolveContextPath("/", path) === path && !destroyed.has(path),
      );
      if (paths.length === 0) break;
      paths.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
      for (const path of paths) {
        await deletion.destroyContext(path);
        await deletion.deleteRepo(path);
        destroyed.add(path);
        await append({
          type: "events.iterate.com/project/context-deleted",
          idempotencyKey: `project/context-deleted:${path}`,
          payload: { path },
        });
      }
    }
    for (const hostname of Object.keys(this.#newestState?.hostnames ?? {})) {
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
