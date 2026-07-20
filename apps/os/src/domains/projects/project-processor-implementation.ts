import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs, StreamEvent, StreamListItem } from "iterate/processors";
import { timedStep } from "../../lib/step-timing.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CONFIG_REPO_PATH } from "../repos/paths.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CapabilityHostProcessorContract,
  capabilityFallbackForScope,
} from "../capability-host/capability-host-processor-contract.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { SCHEDULER_PRIMARY_PATH } from "../scheduler/utils.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { NotificationProcessorContract } from "../notifications/notification-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "../email/utils.ts";
import { WORKER_BUILDING_HEADER } from "../workers/worker-fetch-dispatch.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import {
  ProjectProcessorContract,
  type ProjectProcessorState,
} from "./project-processor-contract.ts";

// Not a bound on build time: the probe fetch carries no buildBudgetMs, so
// each attempt BLOCKS until the seeded worker's cold build (npm install
// included) resolves or fails. The retry window only papers over transient
// dispatch errors around that first build.
const PROJECT_WORKER_READY_ATTEMPTS = 20;
const PROJECT_WORKER_READY_RETRY_MS = 100;
// Bounds each sibling-birth wait so a broken sibling fails the frame into
// ordinary durable redelivery instead of pinning project creation forever;
// generous because the config repo's birth includes a git artifact push.
const SIBLING_BIRTH_BARRIER_TIMEOUT_MS = 60_000;

/**
 * The project root processor. It lives on the project's `/` stream and does
 * four jobs, end to end:
 *
 * BOOTSTRAP. `project/created` is the birth certificate. Its one blocking
 * reaction creates every sibling processor a project is born with — the root
 * capability host on `/`, the primary scheduler on `/scheduler/primary`, the
 * config repo on `/repos/config` (whose birth batch also arms the
 * `cross-post:/` rule that copies later config-repo events back onto `/`),
 * and the email router on `/integrations/email` (seeded with the creator's
 * email as the first sender-allowlist entry). Every appended event carries a
 * deterministic idempotency key, so a redelivered birth frame dedupes instead
 * of double-creating. The frame then WAITS (bounded by
 * SIBLING_BIRTH_BARRIER_TIMEOUT_MS) for each sibling to reduce its own birth
 * batch: `projects.create()` blocks on this Project frame, and the boundary
 * must not race the capabilities it promises.
 *
 * READY. The config repo commits `repo/ready` on its own stream; the
 * cross-post rule copies it here. The reaction probes the default project
 * worker (each probe attempt blocks on the worker's cold build) and then
 * appends `project/ready` — the fact `projects.create()` callers poll.
 *
 * CATALOGS. `reduce` projects cross-posted domain facts into list state:
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
 * append would lose the reaction forever) and use `blockProcessorWhile`. The
 * one state-derived effect — backfilling the notification facet onto
 * projects born before it existed — runs under `delivery.caughtUp` in
 * `runInBackground`: any later at-head delivery re-derives it from
 * `notificationReady === false`, and its appends are idempotency-keyed on
 * the project id.
 */
export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  // ------------------------------------------------------------ processEvent
  protected override processEvent(args: ProcessEventArgs<ProjectProcessorContract>): undefined {
    const { event, state, append, blockProcessorWhile, runInBackground, delivery } = args;
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
        blockProcessorWhile(
          "project birth is delivered once; a dropped sibling-create would leave the project permanently missing its root processors",
          () => this.#createSiblingProcessors(args, event.payload.config),
        );
        break;
      }
      case "events.iterate.com/repo/ready": {
        // Arrives as a cross-posted copy: the config repo commits its facts
        // on its own stream, and the `cross-post:/` rule armed at create
        // copies them here — this saga only ever reacts to events ON `/`.
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== CONFIG_REPO_PATH ||
          state.ready
        ) {
          break;
        }
        blockProcessorWhile(
          "the ready fact is a per-event consequence of the config repo's ready; a dropped append would leave the project never marked ready",
          async () => {
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
          },
        );
        break;
      }
      case "events.iterate.com/project/custom-domain-add-requested":
      case "events.iterate.com/project/custom-domain-refresh-requested": {
        const { hostname } = event.payload;
        blockProcessorWhile(
          "the add/refresh request is delivered once; a lost provision attempt and its observation would strand the domain request",
          async () => {
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
          },
        );
        break;
      }
      case "events.iterate.com/project/custom-domain-remove-requested": {
        const { hostname } = event.payload;
        blockProcessorWhile(
          "the remove request is delivered once; a lost removal or failure record would strand the domain in project state",
          async () => {
            try {
              const domain = state.customDomains.find(
                (candidate) => candidate.hostname === hostname,
              );
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
          },
        );
        break;
      }
      // created/ready/onboarding-completed/notification/created, the catalog
      // facts, egress rules and approval events: no per-event effect — they
      // matter through reduce.
    }

    // ---------------------------------------- state-derived side effects
    // Backfill the notification facet onto projects born before it existed.
    // Droppable background attempt: any later at-head delivery re-derives it
    // from `notificationReady === false`, and both appends are
    // idempotency-keyed on the project id. Skipped on the birth frame — the
    // birth batch above appends the same events itself.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null || state.notificationReady) return;
    if (event?.type === "events.iterate.com/project/created") return;
    runInBackground(() =>
      append(
        {
          type: "events.iterate.com/notification/created",
          idempotencyKey: `notification-created:${this.deps.itx.projectId}`,
          payload: { config: {} },
        },
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName: DurableObjectNameCodec.stringify({
            projectId: this.deps.itx.projectId,
            path: "/",
          }),
          idempotencyKey: `notification-subscription:${this.deps.itx.projectId}`,
          processor: ["notificationProcessor"],
          processorSlug: NotificationProcessorContract.slug,
        }),
      ),
    );
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
          {
            type: "events.iterate.com/capability-host/created",
            idempotencyKey: `capability-host/created:${this.deps.itx.projectId}:/`,
            // The root host ends capability resolution: no fallback.
            payload: { config: {}, fallback: capabilityFallbackForScope("/") },
          },
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: this.deps.itx.projectId,
              path: "/",
            }),
            idempotencyKey: `capability-host-subscription:${this.deps.itx.projectId}:/`,
            processor: ["capabilityHosts", ["get", "/"], "processor"],
            processorSlug: CapabilityHostProcessorContract.slug,
          }),
          {
            type: "events.iterate.com/notification/created",
            idempotencyKey: `notification-created:${this.deps.itx.projectId}`,
            payload: { config: {} },
          },
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: this.deps.itx.projectId,
              path: "/",
            }),
            idempotencyKey: `notification-subscription:${this.deps.itx.projectId}`,
            processor: ["notificationProcessor"],
            processorSlug: NotificationProcessorContract.slug,
          }),
        ),
      ),
      timedStep("create-timing", timing, "primary-scheduler-append", () =>
        appendTo(
          SCHEDULER_PRIMARY_PATH,
          {
            type: "events.iterate.com/scheduler/created",
            idempotencyKey: `scheduler-created:${this.deps.itx.projectId}:${SCHEDULER_PRIMARY_PATH}`,
            payload: { config: {} },
          },
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: this.deps.itx.projectId,
              path: SCHEDULER_PRIMARY_PATH,
            }),
            idempotencyKey: `scheduler-subscription:${this.deps.itx.projectId}:${SCHEDULER_PRIMARY_PATH}`,
            processor: ["schedulers", ["get", SCHEDULER_PRIMARY_PATH], "processor"],
            processorSlug: SchedulerProcessorContract.slug,
          }),
        ),
      ),
      // The config repo is an ordinary repo on its own stream. Its birth
      // batch contains the birth certificate, repo processor subscription,
      // and the cross-post rule that copies subsequent config-repo events
      // onto the project stream `/`. The repo processor cross-posts its own
      // birth certificate for the project catalog, so replaying the setup
      // batch here would duplicate it.
      timedStep("create-timing", timing, "config-repo-append", () =>
        appendTo(
          CONFIG_REPO_PATH,
          {
            type: "events.iterate.com/repo/created",
            idempotencyKey: `repo-created:${this.deps.itx.projectId}:${CONFIG_REPO_PATH}`,
            payload: { config: {} },
          },
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: this.deps.itx.projectId,
              path: CONFIG_REPO_PATH,
            }),
            idempotencyKey: `repo-processor-subscription:${this.deps.itx.projectId}:${CONFIG_REPO_PATH}`,
            processor: ["repos", ["get", CONFIG_REPO_PATH], "processor"],
            processorSlug: RepoProcessorContract.slug,
          }),
          {
            type: "events.iterate.com/stream/subscription-configured",
            idempotencyKey: `config-repo-cross-post:${this.deps.itx.projectId}`,
            payload: {
              // The key crossPostTo would pick for destination "/", so
              // `removeCrossPost({ path: "/" })` can manage this rule.
              subscriptionKey: "cross-post:/",
              description:
                "Special project config repo: every event after the birth/setup batch is cross-posted to the project root so the project processor can react when config changes.",
              delivery: {
                mode: "push",
                expression: ["streams", ["get", "/"], "acceptCrossPost"],
              },
              deliver: "new",
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
          {
            type: "events.iterate.com/email/created",
            idempotencyKey: `email-created:${this.deps.itx.projectId}`,
            payload: { config: {} },
          },
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName: DurableObjectNameCodec.stringify({
              projectId: this.deps.itx.projectId,
              path: EMAIL_INTEGRATION_STREAM_PATH,
            }),
            idempotencyKey: `email-router-subscription:${this.deps.itx.projectId}`,
            processor: ["email", "processor"],
            processorSlug: EmailProcessorContract.slug,
          }),
          ...(config.creatorEmail === undefined
            ? []
            : [
                {
                  type: "events.iterate.com/email/sender-allowed" as const,
                  idempotencyKey: `email-sender-allowed:${this.deps.itx.projectId}:${config.creatorEmail.toLowerCase()}`,
                  payload: {
                    pattern: config.creatorEmail,
                    reason: "project-owner",
                  },
                },
              ]),
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

    // `projects.create()` waits for this Project processor to finish the
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

  /**
   * Probe the default project worker until it answers without the
   * still-building marker. Each probe attempt BLOCKS on the seeded worker's
   * cold build (npm install included); the retry window only papers over
   * transient dispatch errors around that first build.
   */
  async #waitForDefaultProjectWorker(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PROJECT_WORKER_READY_ATTEMPTS; attempt += 1) {
      try {
        // Capability dispatch, on purpose: `worker.fetch` here is an ordinary
        // method call whose Response comes back as a serialized copy — exactly
        // enough for "the worker built, loaded, and answered". Protocol traffic
        // (real HTTP, WebSockets) rides the fetch lane instead; a probe has no
        // protocol needs (docs/dynamic-worker-dispatch.md).
        const response = await this.deps.itx.worker.fetch(
          new Request("https://iterate-project.localhost/__itx_project_ready"),
        );
        try {
          if (response.headers.get(WORKER_BUILDING_HEADER) === "1") {
            throw new Error("Default project worker is still building");
          }
          if (!response.ok) {
            throw new Error(
              `Default project worker readiness probe returned HTTP ${response.status}`,
            );
          }
          return;
        } finally {
          // The returned Response can be a Cap'n Web RPC stub, and keeping
          // that stub alive after the probe finishes is exactly the lifecycle
          // pattern these stream tests are trying to avoid. Dispose on every
          // attempt; local/miniflare Response objects without the hook are a
          // no-op here.
          disposeRpcResult(response);
        }
      } catch (error) {
        lastError = error;
        if (attempt === PROJECT_WORKER_READY_ATTEMPTS) break;
        await this.#sleep(PROJECT_WORKER_READY_RETRY_MS);
      }
    }
    throw new Error("Default project worker did not become ready before project/ready.", {
      cause: lastError,
    });
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
        if (state.birthCertificate !== null) {
          throw new Error("Project processor received more than one project/created event");
        }
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
      case "events.iterate.com/repo/created":
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
          ownershipVerification: null,
          sslStatus: null,
          status: "requested",
          updatedAt: event.createdAt,
          validationRecords: [],
          wildcard: true,
        });
      }
      case "events.iterate.com/project/custom-domain-cloudflare-observed":
        return upsertCustomDomain(state, {
          ...event.payload,
          createdAt:
            state.customDomains.find((domain) => domain.hostname === event.payload.hostname)
              ?.createdAt ?? event.createdAt,
          updatedAt: event.createdAt,
        });
      case "events.iterate.com/project/custom-domain-provision-failed": {
        const failedDomain = state.customDomains.find(
          (domain) => domain.hostname === event.payload.hostname,
        );
        // Keep the last observed Cloudflare snapshot; only record the error —
        // an active domain stays active when a later refresh attempt fails.
        if (!failedDomain) return state;
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
        if (!domain) return state;
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
        // repo/ready, the approval lifecycle events, and everything else the
        // wildcard delivers: consumed for their delivery turn (or by the DO's
        // own readers), no state change here.
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

export type ProjectProcessorDeps = {
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
  const path = event.source?.processor?.stream.path ?? event.source?.crossPostedFrom?.[0]?.path;
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

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
