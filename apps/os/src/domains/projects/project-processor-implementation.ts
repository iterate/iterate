import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs, StreamEvent, StreamListItem } from "iterate/processors";
import { timedStep } from "../../lib/step-timing.ts";
import { CONFIG_REPO_PATH } from "../repos/paths.ts";
import { repoCreationEvents } from "../repos/repo-defaults.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import { capabilityHostCreationEvents } from "../capability-host/capability-host-defaults.ts";
import { schedulerCreationEvents } from "../scheduler/scheduler-defaults.ts";
import { SCHEDULER_PRIMARY_PATH } from "../scheduler/utils.ts";
import { emailRouterCreationEvents } from "../email/email-defaults.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "../email/utils.ts";
import { defaultProjectWorkerRef, isRepoNotSeededError } from "../repos/utils.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { isWorkerBuildInProgressError } from "../workers/worker-loader.ts";
import type { ProjectWorker } from "../workers/schemas.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import {
  ProjectProcessorContract,
  type ProjectProcessorState,
} from "./project-processor-contract.ts";

// One bounded recovery window for the expected source/build/DO lifecycle
// between the config repo's durable creation certificate and its worker
// becoming callable. The 60s horizon sits above the observed 47.5s
// non-retried preview-e2e tail; 500ms polling avoids amplifying full-suite
// build pressure. Unknown/application failures remain immediately terminal.
const PROJECT_WORKER_READY_TIMEOUT_MS = 60_000;
const PROJECT_WORKER_READY_BUILD_BUDGET_MS = 5_000;
const PROJECT_WORKER_READY_RETRY_MS = 500;
// Bounds each sibling-birth wait so a broken sibling fails the frame into
// ordinary durable redelivery instead of pinning project creation forever;
// the config repo's birth includes a git artifact push and has produced an
// observed 65s preview tail under full-suite load, so 75s is the smallest
// honest bounded horizon with operational headroom.
const SIBLING_BIRTH_BARRIER_TIMEOUT_MS = 75_000;

/**
 * The project root processor. It lives on the project's `/` stream and does
 * four jobs, end to end:
 *
 * BOOTSTRAP. `project/created` is the birth certificate. Its one blocking
 * reaction creates every sibling processor a project is born with — the root
 * capability host on `/`, the primary scheduler on `/scheduler/primary`, the
 * config repo on `/repos/config` (its `repos/create-requested` batch also
 * arms the `project-config-to-root` subscription that copies later config-repo events
 * onto `/`), and the email router on `/integrations/email` (seeded with the
 * creator's email as the first sender-allowlist entry). Every appended event
 * carries a deterministic idempotency key, so a redelivered birth frame
 * dedupes instead of double-creating. The frame then WAITS (bounded by
 * SIBLING_BIRTH_BARRIER_TIMEOUT_MS) for each sibling to reduce its own birth
 * batch: `projects.get(slug).create()` blocks on this Project frame, and the boundary
 * must not race the capabilities it promises.
 *
 * READY. The config repo's creation saga commits its terminal
 * `repos/created` certificate on its own stream; that subscription copies
 * it here. The reaction completes the default worker's platform-owned
 * readiness handshake (whose probes block on any cold build) and then appends
 * `project/ready` — the fact `projects.get(slug).create()` callers await.
 *
 * CATALOGS. `reduce` projects received domain facts into list state:
 * physical streams (`stream/created`, `stream/child-stream-created`),
 * devices, repos and secrets (their `created` facts, keyed by the source
 * stream's path). Purely physical bookkeeping — a path in the catalog never
 * implies a processor identity.
 *
 * CUSTOM DOMAINS + EGRESS POLICY. Custom-domain requests call the injected
 * Cloudflare provisioner and record what happened as
 * `custom-domain-cloudflare-observed` / `custom-domain-provision-failed` /
 * `custom-domain-removed` facts; state holds the newest snapshot per
 * hostname. Egress rules and human-approval keys are pure reductions — the
 * Project DO's egress gate reads them from state; the approval lifecycle
 * events (`human-approval-*`) are appended by the DO and the approve CLI,
 * not by this processor.
 *
 * Side-effect lanes: the bootstrap, ready and custom-domain reactions are
 * per-event consequences (each triggering event is delivered once; a lost
 * append would lose the reaction forever) and use `blockProcessorWhile`.
 */
export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  // ------------------------------------------------------------ processEvent
  protected override processEvent(args: ProcessEventArgs<ProjectProcessorContract>): undefined {
    const { event, state, append, blockProcessorWhile } = args;
    // Project worker delivery is NOT here: every project stream (this one
    // included) pumps its own events into the worker's `processEventBatch`
    // with a durable checkpoint (see streams/project-worker-delivery.ts).

    // Nothing reacts before birth (the created event itself excepted).
    if (
      event !== null &&
      event.type !== "events.iterate.com/project/created" &&
      state.birthCertificate === null
    ) {
      return;
    }

    switch (event?.type) {
      case "events.iterate.com/project/created": {
        blockProcessorWhile(() => this.#createSiblingProcessors(args, event.payload.config));
        break;
      }
      case "events.iterate.com/repos/created": {
        // Arrives as a copied event: the config repo commits its terminal
        // certificate on its own stream, and the `project-config-to-root`
        // subscription copies it here — this saga only ever reacts
        // to events ON `/`. The certificate payload carries no path, so the
        // config repo is recognized by its recorded source coordinates.
        const origin = event.source?.copiedFrom?.at(-1);
        if (
          origin?.projectId !== this.deps.itx.projectId ||
          origin.path !== CONFIG_REPO_PATH ||
          state.ready
        ) {
          break;
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          await timedStep("create-timing", timing, "worker-probe", () =>
            this.#waitForDefaultProjectWorker(),
          );
          await timedStep("create-timing", timing, "project-ready-append", () =>
            append({
              type: "events.iterate.com/project/ready",
              idempotencyKey: this.idempotencyKey("ready"),
              payload: {},
            }),
          );
        });
        break;
      }
      case "events.iterate.com/project/custom-domain-add-requested":
      case "events.iterate.com/project/custom-domain-refresh-requested": {
        const { hostname } = event.payload;
        // Direct registrations (owned apexes on worker routes + an
        // operator-primed hostname-directory entry) have no Cloudflare
        // hostname to provision or poll. Running ensure() for one would
        // create a pending SaaS hostname whose non-active snapshot DELETES
        // the live KV registration — taking the domain down. Inert on
        // purpose.
        if (customDomainKind(state, hostname) === "direct") break;
        blockProcessorWhile(async () => {
          try {
            const provisioner = this.#customDomainProvisioner();
            const project =
              (await provisioner.readProject()) ??
              projectRecordFromState(state, this.deps.itx.projectId);
            const snapshot =
              event.type === "events.iterate.com/project/custom-domain-add-requested"
                ? await provisioner.ensure({ hostname, project })
                : await provisioner.refresh({
                    cloudflareHostnameId: state.customDomains.find(
                      (candidate) => candidate.hostname === hostname,
                    )?.cloudflareHostnameId,
                    hostname,
                    project,
                  });
            await append({
              type: "events.iterate.com/project/custom-domain-cloudflare-observed",
              idempotencyKey: this.idempotencyKey("custom-domain-observed", event),
              payload: snapshot,
            });
          } catch (error) {
            await append({
              type: "events.iterate.com/project/custom-domain-provision-failed",
              idempotencyKey: this.idempotencyKey("custom-domain-failed", event),
              payload: { error: errorMessage(error), hostname },
            });
          }
        });
        break;
      }
      case "events.iterate.com/project/custom-domain-remove-requested": {
        const { hostname } = event.payload;
        // Direct registrations are operator-managed: no Cloudflare hostname
        // to delete, and the KV registration must stay. An operator retires
        // one by appending `custom-domain-removed` (a pure reduction) after
        // unrouting it out of band.
        if (customDomainKind(state, hostname) === "direct") break;
        blockProcessorWhile(async () => {
          try {
            const domain = state.customDomains.find((candidate) => candidate.hostname === hostname);
            if (!domain) {
              throw new Error(`Custom domain "${hostname}" is not configured on this project.`);
            }
            const provisioner = this.#customDomainProvisioner();
            const project =
              (await provisioner.readProject()) ??
              projectRecordFromState(state, this.deps.itx.projectId);
            await provisioner.remove({
              cloudflareHostnameId: domain.cloudflareHostnameId,
              hostname,
              project,
            });
            await append({
              type: "events.iterate.com/project/custom-domain-removed",
              idempotencyKey: this.idempotencyKey("custom-domain-removed", event),
              payload: { hostname },
            });
          } catch (error) {
            await append({
              type: "events.iterate.com/project/custom-domain-provision-failed",
              idempotencyKey: this.idempotencyKey("custom-domain-remove-failed", event),
              payload: { error: errorMessage(error), hostname },
            });
          }
        });
        break;
      }
      // created/ready/onboarding-completed/notification/created, the catalog
      // facts, egress rules and approval events: no per-event effect — they
      // matter through reduce.
    }
  }

  /**
   * The birth reaction for `project/created`: create the sibling processors
   * every project is born with, then wait (bounded) for each to reduce its
   * own birth batch. Every append is idempotency-keyed, so a redelivered
   * birth frame dedupes to the committed events and only re-runs the waits.
   */
  async #createSiblingProcessors(
    args: ProcessEventArgs<ProjectProcessorContract>,
    config: NonNullable<ProjectProcessorState["birthCertificate"]>["config"],
  ): Promise<void> {
    const { append, appendTo } = args;
    const timing = { projectId: this.deps.itx.projectId };
    // The root capability host, primary scheduler, config repo, and email
    // router are explicit sibling processors created by the project's birth
    // saga. A physical child stream never implies any processor identity.
    const siblingBirths = Promise.all([
      timedStep("create-timing", timing, "root-saga-append", () =>
        append(
          // The shared birth batch: the root host's created certificate (its
          // default payload ends capability resolution at "/") plus the
          // subscription arming its processor — the same events an explicit
          // capabilityHosts.get("/").create() would append, so the keys
          // collide by design.
          ...capabilityHostCreationEvents({ path: "/", projectId: this.deps.itx.projectId }),
        ),
      ),
      timedStep("create-timing", timing, "primary-scheduler-append", () =>
        appendTo(
          SCHEDULER_PRIMARY_PATH,
          ...schedulerCreationEvents({
            path: SCHEDULER_PRIMARY_PATH,
            projectId: this.deps.itx.projectId,
          }),
        ),
      ),
      // The config repo is an ordinary repo on its own stream. Its request
      // batch contains the creation intent (`repos/create-requested`, empty
      // starter seed), the repo processor subscription, and the stream subscription
      // that copies subsequent config-repo events onto the project
      // stream `/` — including the saga's terminal `repos/created`
      // certificate, which is what marks the project ready and catalogs the
      // repo (so no separate catalog rule is needed here).
      timedStep("create-timing", timing, "config-repo-append", () =>
        appendTo(
          CONFIG_REPO_PATH,
          ...repoCreationEvents({
            path: CONFIG_REPO_PATH,
            projectId: this.deps.itx.projectId,
          }),
          {
            type: "events.iterate.com/stream/subscription-configured",
            idempotencyKey: `config-repo-subscription:${this.deps.itx.projectId}`,
            payload: {
              subscriptionKey: "project-config-to-root",
              description:
                "Sends every config-repo event after the birth batch to the project root so the project processor can react when configuration changes.",
              receiver: {
                action: "copy-to-stream",
                receivingStreamPath: "/",
                delivery: {
                  start: "now",
                  onFailingEvent: "halt",
                },
              },
            },
          },
        ),
      ),
      // Arm the email thread router on `/integrations/email` from birth
      // (Slack routers are per-connection and armed by the connect flow).
      // Email ingress only records received mail; it never creates or
      // subscribes the router. The creator's email seeds the project sender
      // allowlist so the owner can email their project from day one without
      // any config.
      timedStep("create-timing", timing, "email-router-append", () =>
        appendTo(
          EMAIL_INTEGRATION_STREAM_PATH,
          ...emailRouterCreationEvents({
            ...(config.creatorEmail === undefined ? {} : { initialSender: config.creatorEmail }),
            projectId: this.deps.itx.projectId,
          }),
        ),
      ),
    ]);
    const [capabilityHostBirth, schedulerBirth, configRepoBirth, emailRouterBirth] =
      await siblingBirths;

    const maxOffset = (events: StreamEvent[]) =>
      events.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    const capabilityHostOffset = maxOffset(capabilityHostBirth);
    const schedulerOffset = maxOffset(schedulerBirth);
    const configRepoOffset = maxOffset(configRepoBirth);
    const emailRouterOffset = maxOffset(emailRouterBirth);
    if (
      capabilityHostOffset === 0 ||
      schedulerOffset === 0 ||
      configRepoOffset === 0 ||
      emailRouterOffset === 0
    ) {
      throw new Error("project birth saga committed an incomplete sibling birth batch");
    }

    // `projects.get(slug).create()` waits for this Project processor to finish the
    // birth reaction. Do not let that boundary race the sibling processors
    // it created: once the Project birth is processed, every universally
    // available project capability must have reduced its own complete birth
    // batch too. These remote processor facades are nested inside the
    // Project processor's own blocking frame. Keep one acknowledgement in
    // flight at a time: the sibling streams already start concurrently from
    // the append batch above, so this does not serialize their processing;
    // it only avoids retaining four cross-DO facade calls through one
    // frame. Every wait is bounded so a broken sibling fails the frame and
    // enters ordinary durable redelivery instead of pinning project
    // creation forever.
    const siblingBirthDeadline = this.#now() + SIBLING_BIRTH_BARRIER_TIMEOUT_MS;
    const remainingSiblingBirthWaitMs = () => {
      const remaining = siblingBirthDeadline - this.#now();
      if (remaining <= 0) {
        throw new Error(
          `project sibling birth barrier timed out after ${SIBLING_BIRTH_BARRIER_TIMEOUT_MS}ms`,
        );
      }
      return remaining;
    };
    await timedStep("create-timing", timing, "wait-root-capability-host-birth", () =>
      this.deps.itx.capabilityHost.processor.waitUntilProcessed({
        offset: capabilityHostOffset,
        timeoutMs: remainingSiblingBirthWaitMs(),
      }),
    );
    await timedStep("create-timing", timing, "wait-primary-scheduler-birth", () =>
      this.deps.itx.scheduler.processor.waitUntilProcessed({
        offset: schedulerOffset,
        timeoutMs: remainingSiblingBirthWaitMs(),
      }),
    );
    await timedStep("create-timing", timing, "wait-config-repo-birth", () =>
      this.deps.itx.repo.processor.waitUntilProcessed({
        offset: configRepoOffset,
        timeoutMs: remainingSiblingBirthWaitMs(),
      }),
    );
    await timedStep("create-timing", timing, "wait-email-router-birth", () =>
      this.deps.itx.email.processor.waitUntilProcessed({
        offset: emailRouterOffset,
        timeoutMs: remainingSiblingBirthWaitMs(),
      }),
    );
  }

  /** Complete the default worker's platform handshake, retrying only
   * explicitly classified source/build/DO lifecycle states within one
   * deadline. The handshake is a primitive value, not an application HTTP
   * response or live Response stub. */
  async #waitForDefaultProjectWorker(): Promise<void> {
    const startedAt = this.#now();
    const transientOutcomes = new Map<ProjectWorkerReadinessTransientOutcome, number>();
    let attempts = 0;
    let lastError: unknown;
    while (attempts === 0 || this.#now() - startedAt < PROJECT_WORKER_READY_TIMEOUT_MS) {
      const remainingBeforeAttemptMs = PROJECT_WORKER_READY_TIMEOUT_MS - (this.#now() - startedAt);
      attempts += 1;
      let acknowledgement: unknown;
      try {
        acknowledgement = await this.deps.itx.workers
          .get<ProjectWorker>(defaultProjectWorkerRef(), {
            buildBudgetMs: Math.min(PROJECT_WORKER_READY_BUILD_BUDGET_MS, remainingBeforeAttemptMs),
            flattenNestedPaths: true,
          })
          .invokeCapability({
            args: [],
            path: ["__iteratePlatformReady"],
          });
      } catch (error) {
        const outcome = classifyProjectWorkerReadinessTransient(error);
        if (outcome === null) {
          throw new Error(
            `Default project worker readiness handshake failed terminally on attempt ${attempts}: ${errorIdentity(error)}`,
            { cause: error },
          );
        }
        lastError = error;
        transientOutcomes.set(outcome, (transientOutcomes.get(outcome) ?? 0) + 1);
        const remainingMs = PROJECT_WORKER_READY_TIMEOUT_MS - (this.#now() - startedAt);
        if (remainingMs <= 0) break;
        await this.#sleep(Math.min(PROJECT_WORKER_READY_RETRY_MS, remainingMs));
        continue;
      }

      if (acknowledgement !== true) {
        throw new Error(
          "Default project worker readiness handshake violated its protocol on " +
            `attempt ${attempts}: expected true, received ${String(acknowledgement)} ` +
            `(${typeof acknowledgement})`,
        );
      }
      if (attempts > 1) {
        console.info("default project worker readiness converged", {
          attempts,
          projectId: this.deps.itx.projectId,
          transientOutcomes: Object.fromEntries(transientOutcomes),
          waitedMs: this.#now() - startedAt,
        });
      }
      return;
    }
    throw new Error(
      `Default project worker did not become ready within ${PROJECT_WORKER_READY_TIMEOUT_MS}ms ` +
        `after ${attempts} attempts; transient outcomes: ${[...transientOutcomes]
          .map(([outcome, count]) => `${outcome}=${count}`)
          .join(", ")}; last error: ${errorIdentity(lastError)}`,
      { cause: lastError },
    );
  }

  #customDomainProvisioner(): ProjectCustomDomainDeps {
    if (!this.deps.customDomains) throw new Error("Custom-domain provisioning is not configured.");
    return this.deps.customDomains;
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduction, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<ProjectProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/project/created":
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          onboardingActive: event.payload.config.onboardingActive === true,
        };
      case "events.iterate.com/project/ready":
        return { ...state, ready: true };
      case "events.iterate.com/project/onboarding-completed":
        return { ...state, onboardingActive: false, onboardingCompletedAt: event.createdAt };
      case "events.iterate.com/notification/created":
        return { ...state, notificationReady: true };
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return {
          ...state,
          streams: addStreamListItem(state.streams, {
            path: event.payload.path,
            createdAt: event.createdAt,
          }),
        };
      case "events.iterate.com/stream/child-stream-created":
        return {
          ...state,
          streams: addStreamListItem(state.streams, {
            path: event.payload.childPath,
            createdAt: event.createdAt,
          }),
        };
      case "events.iterate.com/device/created":
        return recordDomainObject(state, "devices", event);
      case "events.iterate.com/repos/created":
        return recordDomainObject(state, "repos", event);
      case "events.iterate.com/secret/created":
        return recordDomainObject(state, "secrets", event);
      case "events.iterate.com/project/egress-rules-configured":
        return { ...state, egressRules: event.payload.rules };
      case "events.iterate.com/project/human-approval-key-added":
        if (state.humanApprovalKeys.some((key) => key.keyId === event.payload.keyId)) return state;
        return {
          ...state,
          humanApprovalKeys: [
            ...state.humanApprovalKeys,
            {
              keyId: event.payload.keyId,
              publicKey: event.payload.publicKey,
              label: event.payload.label ?? "",
              addedAt: event.createdAt,
              revokedAt: null,
            },
          ],
        };
      case "events.iterate.com/project/human-approval-key-revoked":
        return {
          ...state,
          humanApprovalKeys: state.humanApprovalKeys.map((key) =>
            key.keyId === event.payload.keyId && key.revokedAt === null
              ? { ...key, revokedAt: event.createdAt }
              : key,
          ),
        };
      case "events.iterate.com/project/custom-domain-add-requested": {
        const existingDomain = state.customDomains.find(
          (domain) => domain.hostname === event.payload.hostname,
        );
        if (existingDomain) {
          // A direct registration has no provisioning lifecycle to restart.
          if (existingDomain.kind === "direct") return state;
          return upsertCustomDomain(state, {
            ...existingDomain,
            error: null,
            status: existingDomain.status === "active" ? "active" : "requested",
            updatedAt: event.createdAt,
          });
        }
        return upsertCustomDomain(state, {
          cloudflareHostnameId: null,
          createdAt: event.createdAt,
          error: null,
          hostname: event.payload.hostname,
          hostnameStatus: null,
          kind: "cloudflare",
          ownershipVerification: null,
          sslStatus: null,
          status: "requested",
          updatedAt: event.createdAt,
          validationRecords: [],
          wildcard: true,
        });
      }
      case "events.iterate.com/project/custom-domain-cloudflare-observed": {
        const observedDomain = state.customDomains.find(
          (domain) => domain.hostname === event.payload.hostname,
        );
        // A direct registration outranks any Cloudflare snapshot — a stray
        // observed fact (e.g. a pre-direct obligation settling late) must not
        // resurrect lifecycle fields and their refresh/remove affordances.
        if (observedDomain?.kind === "direct") return state;
        return upsertCustomDomain(state, {
          ...event.payload,
          kind: "cloudflare",
          createdAt: observedDomain?.createdAt ?? event.createdAt,
          updatedAt: event.createdAt,
        });
      }
      case "events.iterate.com/project/custom-domain-direct-observed": {
        // An operator's statement of routing truth: the hostname is live on
        // worker routes + a primed hostname-directory registration. Active by
        // definition; no Cloudflare snapshot ever describes it.
        const existingDomain = state.customDomains.find(
          (domain) => domain.hostname === event.payload.hostname,
        );
        return upsertCustomDomain(state, {
          cloudflareHostnameId: null,
          createdAt: existingDomain?.createdAt ?? event.createdAt,
          error: null,
          hostname: event.payload.hostname,
          hostnameStatus: null,
          kind: "direct",
          ownershipVerification: null,
          sslStatus: null,
          status: "active",
          updatedAt: event.createdAt,
          validationRecords: [],
          wildcard: false,
        });
      }
      case "events.iterate.com/project/custom-domain-provision-failed": {
        const failedDomain = state.customDomains.find(
          (domain) => domain.hostname === event.payload.hostname,
        );
        // Keep the last observed Cloudflare snapshot; only record the error —
        // an active domain stays active when a later refresh attempt fails.
        // Direct registrations have no provisioning to fail.
        if (!failedDomain || failedDomain.kind === "direct") return state;
        return upsertCustomDomain(state, {
          ...failedDomain,
          error: event.payload.error,
          status: failedDomain.status === "active" ? "active" : "failed",
          updatedAt: event.createdAt,
        });
      }
      case "events.iterate.com/project/custom-domain-remove-requested": {
        const domain = state.customDomains.find(
          (candidate) => candidate.hostname === event.payload.hostname,
        );
        // Direct registrations never enter `removing`: the request is inert
        // (see processEvent) and the entry only leaves state through an
        // operator-appended `custom-domain-removed`.
        if (!domain || domain.kind === "direct") return state;
        return upsertCustomDomain(state, {
          ...domain,
          status: "removing",
          updatedAt: event.createdAt,
        });
      }
      case "events.iterate.com/project/custom-domain-removed":
        return {
          ...state,
          customDomains: state.customDomains.filter(
            (domain) => domain.hostname !== event.payload.hostname,
          ),
        };
      default:
        // The approval lifecycle events and everything else the wildcard
        // delivers: consumed for their delivery turn (or by the DO's own
        // readers), no state change here.
        return state;
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #sleep(ms: number): Promise<void> {
    return this.deps.sleep === undefined
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : this.deps.sleep(ms);
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

type ProjectProcessorDeps = {
  /** The project's own itx surface: sibling processor facades + worker dispatch. */
  itx: ProjectRpcTarget;
  /** Cloudflare custom-hostname provisioning; absent in hosts without it. */
  customDomains?: ProjectCustomDomainDeps;
  /** Injectable clock and sleep — virtual time in tests, real time in prod. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

function recordDomainObject<
  State extends { devices: StreamListItem[]; repos: StreamListItem[]; secrets: StreamListItem[] },
  Key extends "devices" | "repos" | "secrets",
>(state: State, key: Key, event: StreamEvent): State {
  const path = event.source?.processor?.stream.path ?? event.source?.copiedFrom?.[0]?.path;
  if (path === undefined) return state;
  return {
    ...state,
    [key]: addStreamListItem(state[key], { path, createdAt: event.createdAt }),
  };
}

function addStreamListItem(items: StreamListItem[], item: StreamListItem): StreamListItem[] {
  if (items.some((existing) => existing.path === item.path)) return items;
  return [...items, item].sort((a, b) => a.path.localeCompare(b.path));
}

function customDomainKind(
  state: { customDomains: ProjectProcessorState["customDomains"] },
  hostname: string,
): ProjectProcessorState["customDomains"][number]["kind"] | undefined {
  return state.customDomains.find((domain) => domain.hostname === hostname)?.kind;
}

function upsertCustomDomain<
  State extends { customDomains: ProjectProcessorState["customDomains"] },
>(state: State, domain: ProjectProcessorState["customDomains"][number]): State {
  const next = [
    ...state.customDomains.filter((candidate) => candidate.hostname !== domain.hostname),
    domain,
  ].sort((a, b) => a.hostname.localeCompare(b.hostname));
  return { ...state, customDomains: next };
}

/** The directory record fallback when the project directory has no entry yet. */
function projectRecordFromState(
  state: { birthCertificate: { config: { slug: string } } | null },
  projectId: string,
): ProjectDirectoryRecord {
  const slug = state.birthCertificate?.config.slug ?? projectId;
  return { id: projectId, slug, organizationId: null, name: slug };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProjectWorkerReadinessTransientOutcome =
  | "durable_object_unavailable"
  | "repo_not_seeded"
  | "worker_build_in_progress";

function classifyProjectWorkerReadinessTransient(
  error: unknown,
): ProjectWorkerReadinessTransientOutcome | null {
  if (isWorkerBuildInProgressError(error)) return "worker_build_in_progress";
  if (isRepoNotSeededError(error)) return "repo_not_seeded";
  if (isRetryableDurableObjectAvailabilityError(error)) return "durable_object_unavailable";
  return null;
}

function errorIdentity(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown; name?: unknown };
    if (typeof candidate.name === "string" && typeof candidate.message === "string") {
      return `${candidate.name}: ${candidate.message}`;
    }
  }
  return String(error);
}
