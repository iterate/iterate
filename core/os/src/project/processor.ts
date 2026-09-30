// src/project/processor.ts — THE PROJECT PROCESSOR: the reduce of the project's own creation facts
// and of the certificates cross-posted to `/` (the catalog: first certificate wins — a repo, a
// workspace is born once; a secret's latest `set` is its
// row — and a death certificate drops the entry; the config repo's commits, whose latest is the tip
// the project follows), and its EFFECTS, each run from state at head. THE CREATION SAGA: the config
// repo (`itx.repos.create("/repos/config")`, the same collection a caller uses), its seed committed
// when `main` is unborn (the default template, below), the project's ingress pointed at its
// published config (`itx/ingress-configured` to `itx.config`, the core's, once), then the
// certificate, once the seed's publication has landed. THE PUBLICATION OF THE CONFIG REPO: every
// `repo/commit-completed` from `/repos/config` gets ONE outcome on `/`, as the generation of its
// fact's offset — its commit published (publication.ts) if it is `main`'s head as its attempt
// begins: the pointer `itx.config` moved to it and `project/worker-updated`, in one batch; or
// `project/worker-update-failed`, a commit refused or one main moved on from first — so a commit
// changes the project's code everywhere, and whoever made it can wait for its outcome by its oid.
// Subscribed to `/` (the row `session.projects.create` enables), it runs again after every
// eviction: an attempt lost with an incarnation is simply run again by the next — the
// repo tolerates existing, a born `main` refuses the seed, a publication is keyed by its generation,
// the ingress and the certificate are keyed. Its reach is its constructor's arguments; a
// unit test constructs it with `new` and reduces rows (processor.test.ts, in node) or hands it a fake
// download (templates.test.ts); the effects are proven on the worker (test/vitest/os/session.e2e.test.ts: the
// catalog, the apex answering the seed; test/vitest/os/website-publication.e2e.test.ts: a commit publishes).

import { errorCode, resolveContextPath } from "iterate/lib";
import { failureKind, isPlatformFailureKind } from "iterate/platform-retry";
import {
  parseConfigRepoTemplateReference,
  type ConfigRepoTemplateReference,
} from "iterate/config-repo-template";
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "iterate/stream/processor";
import { pinPkgPrNewDependencies } from "iterate/pkg-pr-new";
import { runningUnder } from "../cause.ts";
import { templateFiles } from "../generated/config-templates.js";
import { readPackage } from "../context/module-resolution.ts";
import type { WorkerManifest } from "../context/worker-manifest.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { reduceSecretCatalog } from "../secret/contract.ts";
import { reduceIntegrations } from "../integrations/contract.ts";
import { unavailableError } from "../unavailable.ts";
import { MINIMAL_CONFIG_FILES } from "./minimal-config.ts";
import { ProjectContract, type CustomHostnameObservation, type ProjectState } from "./contract.ts";
import { customHostnameProblem, type CustomHostnameProvider } from "./custom-hostnames.ts";
import type { DomainConnectLink } from "./domain-connect.ts";
import { configPointer, manifestOf, type ProjectPublisher } from "./publication.ts";

/** How long one publication may take before the platform gives up on it for now: a publication
 *  resolves its npm dependencies from esm.sh, and a commit whose publication the platform could
 *  not finish stays owed to the project's next incarnation. */
const PUBLICATION_BUDGET_MS = 60_000;

/** The waits before each attempt of one publication: at once, then after a platform failure 5 s
 *  and 30 s later, within PUBLICATION_BUDGET_MS. */
const PUBLICATION_ATTEMPT_WAITS_MS = [0, 5_000, 30_000] as const;

/** One attempt of a publication (`ProjectProcessor#attemptPublication`): its manifest admitted,
 *  or refused and why. */
type PublicationAttempt =
  | { kind: "admitted"; manifest: WorkerManifest }
  | { kind: "refused"; error: string };

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
  /** Whether another project holds `hostname`'s claim: then its Cloudflare custom hostname is
   *  that project's too, and a remove here leaves it. */
  heldElsewhere(hostname: string): Promise<boolean>;
  /** The ownership record for `hostname` and whether DNS has it (custom-hostnames.ts
   *  `ownershipRecordOf`); a lookup that fails is not proof. */
  proof(
    hostname: string,
  ): Promise<{ record: CustomHostnameObservation["records"][number]; proven: boolean }>;
  setPrimaryHostname(hostname: string | null): Promise<void>;
  provider: CustomHostnameProvider | null;
  /** The signed Domain Connect link that writes `hostname`'s records at its DNS provider, or null
   *  (domain-connect.ts `domainConnectLinkOf`). */
  connect(hostname: string): Promise<DomainConnectLink | null>;
  /** The zone `hostname` lives in and who hosts it, by a provider id the dash has instructions
   *  for (dns-provider.ts `dnsZoneOf`). */
  dnsZone(hostname: string): Promise<{ zone: string; provider: string | null } | null>;
};

/** Whether a hostname serves: the project holds its claim, and Cloudflare says its hostname and its
 *  certificate are both active — what a primary hostname must be. */
const hostnameIsLive = (entry: ProjectState["hostnames"][string] | undefined) =>
  Boolean(entry?.claimed) &&
  entry?.cloudflare?.status === "active" &&
  entry.cloudflare.sslStatus === "active";

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

  private readonly getItx: () => ItxEntrypointScope & Disposable;
  private readonly downloadTemplate: TemplateDownload;
  private readonly hostnames: () => ProjectHostnames | null;
  private readonly deletion: () => ProjectDeletion | null;
  private readonly publisher: () => ProjectPublisher | null;

  constructor(
    getItx: () => ItxEntrypointScope & Disposable,
    downloadTemplate: TemplateDownload,
    hostnames: () => ProjectHostnames | null = () => null,
    deletion: () => ProjectDeletion | null = () => null,
    publisher: () => ProjectPublisher | null = () => null,
  ) {
    super();
    this.getItx = getItx;
    this.downloadTemplate = downloadTemplate;
    this.hostnames = hostnames;
    this.deletion = deletion;
    this.publisher = publisher;
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
  /** The publication of the config repo: the commits owed one as the newest delivery showed them
   *  (the durable ground is `state.unpublishedCommits`, which learns of an outcome a delivery
   *  later), and the newest fact this incarnation answered or gave up on (the platform failed it
   *  for its whole budget; the next incarnation tries again). One
   *  publication runs at a time and DRAINS, oldest first: a commit that lands while one is in
   *  flight is next, without waiting for another delivery. */
  #unpublished: ProjectState["unpublishedCommits"] = [];
  #handledThrough = 0;
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
        // The platform's fact (caller.ts `PLATFORM_FACT_TYPES`): the session appends it just before
        // the control plane drops the row.
        if (state.deletion) return undefined;
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
              claimed: known?.claimed || false,
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
        const settled = {
          ...known,
          requested,
          cloudflare: cloudflare || known.cloudflare,
          error,
          claimed: event.payload.claimed ?? Boolean(cloudflare || known.cloudflare),
        };
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
            hostnames: {
              ...state.hostnames,
              [hostname]: { ...known, cloudflare: null, claimed: false },
            },
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
      case "events.iterate.com/slack/disconnected":
      case "events.iterate.com/google/disconnected":
      case "events.iterate.com/cloudflare/disconnected":
      case "events.iterate.com/github/disconnected":
      case "events.iterate.com/x/connected":
      case "events.iterate.com/x/disconnected": {
        const integrations = reduceIntegrations(state.integrations, event);
        return integrations && { ...state, integrations };
      }
      case "events.iterate.com/repo/commit-completed":
        // Only the config repo is published; another repo's commit is a fact for its own log.
        if (event.payload.path !== "/repos/config") return undefined;
        return {
          ...state,
          configRepoTip: { commitOid: event.payload.commitOid, offset: event.offset },
          unpublishedCommits: [
            ...state.unpublishedCommits,
            {
              commitOid: event.payload.commitOid,
              offset: event.offset,
              ...(event.source?.cause && {
                cause: { ...event.source.cause, parent: `${event.path}@${event.offset}` },
              }),
            },
          ],
        };
      case "events.iterate.com/project/worker-updated": {
        const { commitOid, generation } = event.payload;
        return {
          ...state,
          unpublishedCommits: state.unpublishedCommits.filter(
            ({ offset }) => offset !== generation,
          ),
          lastPublicationFactOffset: event.offset,
          publishedCommit: commitOid,
        };
      }
      case "events.iterate.com/project/worker-update-failed": {
        // The platform's give-up (`unavailable`) leaves the commit owed.
        const { generation, unavailable } = event.payload;
        return {
          ...state,
          unpublishedCommits: unavailable
            ? state.unpublishedCommits
            : state.unpublishedCommits.filter(({ offset }) => offset !== generation),
          lastPublicationFactOffset: event.offset,
        };
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
          // the project holds the claim is the worker's own to carry: the state it drains from may
          // not have reduced its last answer yet.
          let answered = 0;
          let claimed = entry.claimed;
          for (
            let owed = entry;
            owed?.requested && owed.requested.offset !== answered;
            owed = this.#newestHostnames[hostname]
          ) {
            const { verb, offset } = owed.requested;
            const answer =
              verb === "add"
                ? await this.#addHostname(hostname, offset, claimed)
                : await this.#removeHostname(hostname, offset);
            await append(answer);
            claimed = "claimed" in answer.payload && answer.payload.claimed;
            answered = offset;
          }
        } finally {
          this.#hostnameWork.delete(hostname);
        }
      });
    }
    // THE PUBLICATION OF THE CONFIG REPO — state-derived, at head, in the background: each commit
    // fact of `/repos/config` (cross-posted here by the repo facet) is answered, oldest first, as the
    // generation of its offset (`#publish`), so a return to a commit published before (B, C, then B
    // again) is a publication of its own, and a commit is owed until an outcome of ITS generation
    // landed. An attempt lost with an incarnation is run again by the next. A state that owes
    // nothing starts no append, and no background work to claim the context's alarm for.
    this.#unpublished = state.unpublishedCommits;
    const publisher = this.publisher();
    if (publisher && this.#nextOwed() && !this.#publishing) {
      this.#publishing = true;
      runInBackground(async () => {
        try {
          for (let owed = this.#nextOwed(); owed; owed = this.#nextOwed()) {
            // under the commit's own cause, not one deeper as a processor's other effects run: a
            // publication keeps the commit's depth, and init runs one deeper (src/cause.ts)
            const commit = owed;
            await runningUnder(commit.cause, () => this.#publish(commit, publisher));
            this.#handledThrough = commit.offset;
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
    // Seeded, its publication not landed yet: the publication fact's own delivery goes on.
    if (publisher && state.configRepoTip && state.lastPublicationFactOffset === null) return;
    this.#creating = true;
    runInBackground(async () => {
      try {
        if (!state.configRepoTip) {
          await this.#seed(state);
          // Its commit's fact reaches `/`, the follower publishes it, and the publication's fact
          // lands the certificate.
          if (publisher) return;
        }
        // A CREATED PROJECT ANSWERS ON ITS HOSTS: its first publication has landed, then the
        // ingress is pointed at its published config, whichever commit that is, once — a routing
        // change, which answers only once no host can be served from a snapshot older than it — and
        // then the certificate.
        await append({
          type: "events.iterate.com/itx/ingress-configured",
          idempotencyKey: "itx/ingress-configured",
          payload: { target: ["itx", "config"] },
        });
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

  /** THE SEED: the config repo, and the template committed onto its unborn `main` — or `main` as it
   *  is, born by an earlier attempt or another commit. */
  async #seed(state: ProjectState): Promise<void> {
    // its own block: the template's download below outlasts it
    {
      using itx = this.getItx();
      await itx.repos.create("/repos/config");
    }
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
      // build, and the loader refuses a ref that moves (iterate/pkg-pr-new). A ref
      // that cannot be pinned fails the creation, like a download that fails. A preset comes from
      // the build (scripts/build.ts `--template`), with no GitHub request; no template is core's
      // minimal config.
      const changes = await pinPkgPrNewDependencies(
        reference
          ? (templateFiles[reference] ??
              (await this.downloadTemplate(parseConfigRepoTemplateReference(reference))))
          : MINIMAL_CONFIG_FILES,
      );
      // The seed checks the template's entry with the loader's own rule (`readPackage`).
      readPackage(
        Object.fromEntries(changes.map((file) => [file.path, file.content])),
        "The config template",
      );
      using itx = this.getItx();
      // Over the loopback stub the commit's answer types as an RPC result; the wire copied it.
      const seeded = (await config(itx).commitFiles({
        message: reference ? `seed: ${reference}` : "seed: minimal project config",
        changes,
        parent: null,
      })) as unknown as { commitOid: string | null };
      commitOid = seeded.commitOid;
    } catch (error) {
      using itx = this.getItx();
      // Over the loopback stub a facet call's answer types as an RPC result; the wire copied it.
      commitOid = (await config(itx).tip()) as unknown as string | null;
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
  }

  /** The oldest commit owed a publication that this incarnation has not answered or given up on. */
  #nextOwed(): ProjectState["unpublishedCommits"][number] | undefined {
    return this.#unpublished.find(({ offset }) => offset > this.#handledThrough);
  }

  /** ONE OUTCOME for the commit fact `commit`, as generation `commit.offset` (publication.ts). A
   *  commit that is `main`'s head as an attempt begins and that the probe admits is published: the
   *  pointer and `project/worker-updated` in ONE batch as the platform, so no state of `/` holds
   *  either without the other. Every context resolves through the pointer within SNAPSHOT_TTL_MS
   *  of that batch (context/rule-snapshots.ts), and the append answers once it does. A commit the
   *  probe refuses, or one main moved on from (anyone may append a fact), is
   *  `project/worker-update-failed`. Both keyed by the generation, so an attempt run again lands
   *  nothing more. A platform failure is met again after 5 s and 30 s, within
   *  PUBLICATION_BUDGET_MS; then the platform gives up for now: `project/worker-update-failed` with
   *  `unavailable`, the commit still owed. */
  async #publish(
    commit: { commitOid: string; offset: number },
    publisher: ProjectPublisher,
  ): Promise<void> {
    const { commitOid } = commit;
    const generation = commit.offset;
    const giveUpAt = Date.now() + PUBLICATION_BUDGET_MS;
    let lastFailure: unknown;
    for (const waitMs of PUBLICATION_ATTEMPT_WAITS_MS) {
      if (Date.now() + waitMs >= giveUpAt) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      let attempt: PublicationAttempt;
      // the budget's timer, cleared with the attempt: a pending timer keeps the context resident
      let budget: ReturnType<typeof setTimeout> | undefined;
      try {
        attempt = await Promise.race([
          this.#attemptPublication(commitOid, generation, publisher),
          new Promise<never>((_, reject) => {
            budget = setTimeout(
              () =>
                reject(
                  unavailableError(
                    "overloaded",
                    `publication ${generation} did not finish within ${PUBLICATION_BUDGET_MS} ms`,
                  ),
                ),
              giveUpAt - Date.now(),
            );
          }),
        ]);
      } catch (error) {
        if (!isPlatformFailureKind(failureKind(error))) throw error;
        lastFailure = error;
        continue;
      } finally {
        clearTimeout(budget);
      }
      if (attempt.kind === "refused")
        return landOnce(publisher, {
          type: "events.iterate.com/project/worker-update-failed",
          idempotencyKey: `project/publication:${generation}`,
          payload: { commitOid, generation, error: attempt.error },
        });
      const { manifest } = attempt;
      return landOnce(publisher, ...configPointer(commitOid, manifest), {
        type: "events.iterate.com/project/worker-updated",
        idempotencyKey: `project/publication:${generation}`,
        payload: { commitOid, generation, modules: manifest.modules },
      });
    }
    await publisher.appendAsPlatform({
      type: "events.iterate.com/project/worker-update-failed",
      payload: {
        commitOid,
        generation,
        error: lastFailure instanceof Error ? lastFailure.message : String(lastFailure),
        unavailable: true,
      },
    });
  }

  /** One attempt: `commitOid` refused when `main` has moved on from it, else its manifest admitted
   *  or refused — a platform failure throws. */
  async #attemptPublication(
    commitOid: string,
    generation: number,
    publisher: ProjectPublisher,
  ): Promise<PublicationAttempt> {
    const head = await publisher.head();
    if (head !== commitOid)
      return {
        kind: "refused",
        error: `main moved on to ${head || "no commit (unborn)"} before this commit was published`,
      };
    try {
      return { kind: "admitted", manifest: await manifestOf(commitOid, generation, publisher) };
    } catch (error) {
      if (isPlatformFailureKind(failureKind(error))) throw error;
      return { kind: "refused", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Claim the hostname once it is proven the project's (or again, when the project holds it), then
   *  find-or-create its custom hostname: the answer to an add. A refusal after a claim this answer
   *  took releases it; a claim held before stays (a failed re-check keeps it). */
  async #addHostname(hostname: string, offset: number, held: boolean) {
    const hostnames = this.hostnames();
    let cloudflare = null;
    let error = null;
    let claimed = held;
    try {
      if (!hostnames?.provider) throw new Error("This deployment cannot add custom hostnames.");
      const problem = customHostnameProblem(hostname, hostnames.reservedZones);
      if (problem) throw new Error(problem);
      const proof = await hostnames.proof(hostname);
      if (held || proof.proven) {
        await hostnames.claim(hostname);
        claimed = true;
      }
      const observed = await hostnames.provider.provision(hostname);
      // while there is something to add — the ownership record too, once Cloudflare is done: one
      // click at the owner's DNS provider, and who that provider is, for the instructions by hand —
      // both best effort, a failure logged and left out
      const live = claimed && observed.status === "active" && observed.sslStatus === "active";
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
      cloudflare = { ...observed, records: [...observed.records, proof.record], connect, dns };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (claimed && !held) {
        await hostnames!.release(hostname);
        claimed = false;
      }
    }
    return {
      type: "events.iterate.com/project/hostname-add-settled" as const,
      idempotencyKey: `project/hostname-add:${hostname}:${offset}`,
      payload: { hostname, requestOffset: offset, cloudflare, error, claimed },
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
      if (!(await hostnames?.heldElsewhere(hostname))) await hostnames?.provider?.remove(hostname);
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

  /** Delete the custom hostname — unless another project holds the claim, whose it is then — and
   *  release the claim: the answer to a remove. */
  async #removeHostname(hostname: string, offset: number) {
    const hostnames = this.hostnames();
    if (!(await hostnames?.heldElsewhere(hostname))) await hostnames?.provider?.remove(hostname);
    await hostnames?.release(hostname);
    return {
      idempotencyKey: `project/hostname-remove:${hostname}:${offset}`,
      type: "events.iterate.com/project/hostname-removed" as const,
      payload: { hostname, requestOffset: offset },
    };
  }
}

/** A keyed platform batch landed once: an IDEMPOTENCY_CONFLICT is a key an earlier attempt of this
 *  generation already landed, and a batch lands whole or not at all, so its outcome is there. */
async function landOnce(publisher: ProjectPublisher, ...events: StreamEventInput[]): Promise<void> {
  try {
    await publisher.appendAsPlatform(...events);
  } catch (error) {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
}
