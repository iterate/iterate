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
import { isWorkerBuildFailedError } from "../workers/artifact-store.ts";
import { WORKER_BUILDING_HEADER } from "../workers/worker-fetch-dispatch.ts";
import { WORKER_SERVE_HEADER } from "../workers/worker-serve-info.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import {
  parseProjectCreationTerminal,
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
// the config repo's birth includes a git artifact push and has produced an
// observed 65s preview tail under full-suite load, so 75s is the smallest
// honest bounded horizon with operational headroom.
const SIBLING_BIRTH_BARRIER_TIMEOUT_MS = 75_000;

/**
 * The project root processor. It lives on the project's `/` stream and does
 * four jobs, end to end:
 *
 * BOOTSTRAP. `project/create-requested` is the durable intent. Its blocking
 * reaction creates every sibling processor a project is born with — the root
 * capability host on `/`, the primary scheduler on `/scheduler/primary`, the
 * config repo on `/repos/config` (its `repos/create-requested` batch also arms
 * the `cross-post:/` rule that copies later config-repo events back onto `/`),
 * and the email router on `/integrations/email` (seeded with the creator's
 * email as the first sender-allowlist entry). Every append has a deterministic
 * idempotency key, so redelivery dedupes instead of double-creating. The frame
 * then WAITS (bounded by
 * SIBLING_BIRTH_BARRIER_TIMEOUT_MS) for each sibling to reduce its own birth
 * batch.
 *
 * TERMINAL. The config repo's creation saga commits `repos/created` on its own
 * stream; the cross-post rule copies it here. The reaction probes the default
 * project worker, then atomically installs the ordinary root `project-worker`
 * feed and appends the terminal `project/created` certificate that create()
 * callers await plus the first `project/worker-updated` lifecycle fact. The
 * feed begins after `project/create-requested`: creation facts belong to this
 * platform saga, while the clean worker-update fact is userspace input.
 *
 * A config-repo failure or deterministic worker source-build failure closes
 * the saga with `project/create-failed`. Transient worker availability errors
 * and an in-progress build leave the reaction open for durable redelivery.
 *
 * WORKER LIFECYCLE. After terminal creation, every later config-repo
 * `repo/commit-completed` fact is copied onto `/` by that same cross-post
 * rule. Once the current default worker answers its readiness probe, this
 * processor translates the raw repo fact into `project/worker-updated`;
 * deterministic source-build failures become `project/worker-update-failed`,
 * while transient availability remains open for durable redelivery. The
 * trusted seed commit is creation input and is deliberately not translated;
 * creation's successful probe publishes its worker-update certificate.
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
 * Side-effect lanes: the bootstrap, terminal and custom-domain reactions are
 * at-least-once per-event consequences. Their appends have stable idempotency
 * keys, and `blockProcessorWhile` keeps the event cursor behind every
 * consequence until it commits.
 */
export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  // ------------------------------------------------------------ processEvent
  protected override processEvent(args: ProcessEventArgs<ProjectProcessorContract>): undefined {
    const { event, state, append, blockProcessorWhile } = args;
    // Nothing reacts before the request. Once it reduces, its blocking frame
    // has birthed every sibling before the cursor can reach a later command,
    // so commands appended during a non-blocking create remain actionable
    // instead of being acknowledged and lost while project/created is open.
    if (
      state.createRequest === null &&
      event?.type !== "events.iterate.com/project/create-requested"
    )
      return;
    if (state.createFailure !== null) return;

    switch (event?.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.offset !== state.createRequestedAtOffset) break;
        blockProcessorWhile(() => this.#createSiblingProcessors(args, event.payload.config));
        break;
      }
      case "events.iterate.com/repos/created":
      case "events.iterate.com/repos/create-failed": {
        // Arrives as a cross-posted copy: the config repo commits its
        // terminal result on its own stream, and the `cross-post:/` rule
        // armed at create copies it here — this saga only ever reacts to
        // events ON `/`. The payload carries no path, so the config repo is
        // recognized by exact cross-post provenance.
        const origin = event.source?.crossPostedFrom?.at(-1);
        if (
          origin?.projectId !== this.deps.itx.projectId ||
          origin.path !== CONFIG_REPO_PATH ||
          origin.subscriptionKey !== "cross-post:/" ||
          origin.type !== event.type ||
          state.birthCertificate !== null ||
          state.createRequest === null ||
          state.createRequestedAtOffset === null
        ) {
          break;
        }
        const createRequest = state.createRequest;
        const createRequestedAtOffset = state.createRequestedAtOffset;
        blockProcessorWhile(async () => {
          const projectCreatedIdempotencyKey = `project-created:${this.deps.itx.projectId}`;
          const projectCreateFailedIdempotencyKey = "project/create-failed";
          const [existingProjectCreated, existingProjectCreateFailed] = await Promise.all([
            this.stream.getEvent({ idempotencyKey: projectCreatedIdempotencyKey }),
            this.stream.getEvent({ idempotencyKey: projectCreateFailedIdempotencyKey }),
          ]);
          if (existingProjectCreated !== undefined && existingProjectCreateFailed !== undefined) {
            throw new Error("Project creation has both a success and failure terminal.");
          }
          if (existingProjectCreated !== undefined) {
            const terminal = parseProjectCreationTerminal({
              event: existingProjectCreated,
              projectId: this.deps.itx.projectId,
              request: createRequest,
              requestOffset: createRequestedAtOffset,
            });
            if (terminal?.type !== "events.iterate.com/project/created") {
              throw new Error(
                `idempotency key "${projectCreatedIdempotencyKey}" is not this creation request's certificate`,
              );
            }
            // The permanent feed, certificate, and initial worker-update are
            // one append batch. Seeing the certificate therefore proves all
            // three committed; this is the lost-ack retry path.
            return;
          }
          if (existingProjectCreateFailed !== undefined) {
            const terminal = parseProjectCreationTerminal({
              event: existingProjectCreateFailed,
              projectId: this.deps.itx.projectId,
              request: createRequest,
              requestOffset: createRequestedAtOffset,
            });
            if (terminal?.type !== "events.iterate.com/project/create-failed") {
              throw new Error(
                `idempotency key "${projectCreateFailedIdempotencyKey}" is not this creation request's failure`,
              );
            }
            // The failure append committed but the processor checkpoint did
            // not. Do not probe again: its result could differ or even
            // succeed, creating contradictory creation terminals.
            return;
          }

          if (event.type === "events.iterate.com/repos/create-failed") {
            await append({
              type: "events.iterate.com/project/create-failed",
              idempotencyKey: projectCreateFailedIdempotencyKey,
              payload: {
                createRequestedAtOffset,
                error: `Config repo creation failed: ${event.payload.error}`,
                request: createRequest,
              },
            });
            return;
          }

          const timing = { projectId: this.deps.itx.projectId };
          let seedCommitOid: string;
          try {
            seedCommitOid = await timedStep("create-timing", timing, "worker-probe", () =>
              this.#waitForDefaultProjectWorker(),
            );
          } catch (error) {
            if (!isWorkerBuildFailedError(error)) throw error;
            await append({
              type: "events.iterate.com/project/create-failed",
              idempotencyKey: projectCreateFailedIdempotencyKey,
              payload: {
                createRequestedAtOffset,
                error: `Default project worker bootstrap failed: ${errorMessage(error)}`,
                request: createRequest,
              },
            });
            return;
          }
          await timedStep("create-timing", timing, "project-created-append", () =>
            append(
              {
                type: "events.iterate.com/stream/subscription-configured",
                idempotencyKey: `project-worker-subscription:${this.deps.itx.projectId}`,
                payload: {
                  subscriptionKey: "project-worker",
                  description:
                    "Default project worker: every later root event; project creation remains platform-owned.",
                  delivery: { mode: "push", expression: ["processEventBatch"] },
                  deliver: { afterOffset: createRequestedAtOffset },
                  onPoison: "skip",
                },
              },
              {
                type: "events.iterate.com/project/created",
                idempotencyKey: projectCreatedIdempotencyKey,
                payload: { ...createRequest, createRequestedAtOffset },
              },
              {
                type: "events.iterate.com/project/worker-updated",
                idempotencyKey: `project/worker-update:${seedCommitOid}`,
                payload: { commitOid: seedCommitOid },
              },
            ),
          );
        });
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        const origin = event.source?.crossPostedFrom?.at(-1);
        if (
          origin?.projectId !== this.deps.itx.projectId ||
          origin.path !== CONFIG_REPO_PATH ||
          origin.subscriptionKey !== "cross-post:/" ||
          origin.type !== event.type ||
          state.birthCertificate === null
        ) {
          break;
        }
        blockProcessorWhile(async () => {
          const outcomeIdempotencyKey = `project/worker-update:${event.payload.commitOid}`;
          const existingOutcome = await this.stream.getEvent({
            idempotencyKey: outcomeIdempotencyKey,
          });
          if (existingOutcome !== undefined) {
            if (
              (existingOutcome.type !== "events.iterate.com/project/worker-updated" &&
                existingOutcome.type !== "events.iterate.com/project/worker-update-failed") ||
              existingOutcome.payload?.commitOid !== event.payload.commitOid
            ) {
              throw new Error(
                `idempotency key "${outcomeIdempotencyKey}" is not this config commit's worker update outcome`,
              );
            }
            return;
          }

          try {
            await this.#waitForDefaultProjectWorker();
          } catch (error) {
            if (!isWorkerBuildFailedError(error)) throw error;
            await append({
              type: "events.iterate.com/project/worker-update-failed",
              idempotencyKey: outcomeIdempotencyKey,
              payload: {
                commitOid: event.payload.commitOid,
                error: errorMessage(error),
              },
            });
            return;
          }
          await append({
            type: "events.iterate.com/project/worker-updated",
            idempotencyKey: outcomeIdempotencyKey,
            payload: { commitOid: event.payload.commitOid },
          });
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
      // created/heartbeat-triggered/onboarding-completed/notification facts,
      // catalog facts, egress rules and approval events: no platform side
      // effect. The project worker handles userspace lifecycle events.
    }
  }

  /**
   * The opening reaction for `project/create-requested`: create the sibling processors
   * every project is born with, then wait (bounded) for each to reduce its
   * own birth batch. Every append is idempotency-keyed, so a redelivered
   * birth frame dedupes to the committed events and only re-runs the waits.
   */
  async #createSiblingProcessors(
    args: ProcessEventArgs<ProjectProcessorContract>,
    config: NonNullable<ProjectProcessorState["createRequest"]>["config"],
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
      // starter seed), the repo processor subscription, and the cross-post
      // rule that copies subsequent config-repo events onto the project
      // stream `/` — including the saga's terminal `repos/created`
      // certificate, which is what starts the worker delivery barrier and
      // catalogs the repo (so no dedicated catalog subscription here).
      timedStep("create-timing", timing, "config-repo-append", () =>
        appendTo(
          CONFIG_REPO_PATH,
          ...repoCreationEvents({
            path: CONFIG_REPO_PATH,
            projectId: this.deps.itx.projectId,
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

    // The terminal project/created event must not race the sibling processors
    // created by this request: every universally available project capability
    // must have reduced its complete birth batch before the worker bootstrap
    // begins. These remote processor facades are nested inside the
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

  /** Probe until the default worker answers and return OS-stamped source identity. */
  async #waitForDefaultProjectWorker(): Promise<string> {
    for (let attempt = 1; attempt <= PROJECT_WORKER_READY_ATTEMPTS; attempt += 1) {
      // Use the platform's fetch lane, not `itx.worker.fetch`: the latter is
      // ordinary capability dispatch and returns the userspace Response
      // without the trusted source stamp. DynamicWorkerRunner owns this
      // authority boundary and replaces any userspace-authored serve header
      // with the commit it actually resolved, built, loaded, and invoked.
      const response = await this.deps.workerFetch(
        new Request("https://iterate-project.localhost/__itx_project_ready"),
      );
      try {
        if (response.headers.get(WORKER_BUILDING_HEADER) !== "1") {
          // Any application response proves the module built and loaded. Its
          // HTTP status belongs to userspace fetch behavior, not bootstrap.
          const commitOid = response.headers.get(WORKER_SERVE_HEADER);
          if (commitOid === null) {
            throw new Error(
              `Default project worker response is missing trusted "${WORKER_SERVE_HEADER}" source identity.`,
            );
          }
          return commitOid;
        }
      } finally {
        // The returned Response can be a Cap'n Web RPC stub, and keeping that
        // stub alive after the probe finishes pins the JS-RPC session.
        disposeRpcResult(response);
      }
      if (attempt < PROJECT_WORKER_READY_ATTEMPTS) {
        await this.#sleep(PROJECT_WORKER_READY_RETRY_MS);
      }
    }
    const error = new Error(
      "Default project worker is still building after the bounded readiness probe.",
    );
    error.name = "WorkerBuildInProgressError";
    throw error;
  }

  #customDomainProvisioner(): ProjectCustomDomainDeps {
    if (!this.deps.customDomains) throw new Error("Custom-domain provisioning is not configured.");
    return this.deps.customDomains;
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduction, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<ProjectProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (state.createRequest !== null) return state;
        return {
          ...state,
          createRequest: event.payload,
          createRequestedAtOffset: event.offset,
          onboardingActive: event.payload.config.onboardingActive === true,
        };
      case "events.iterate.com/project/created":
      case "events.iterate.com/project/create-failed": {
        if (
          state.createRequest === null ||
          state.createRequestedAtOffset === null ||
          state.birthCertificate !== null ||
          state.createFailure !== null
        ) {
          return state;
        }
        const terminal = parseProjectCreationTerminal({
          event,
          projectId: this.deps.itx.projectId,
          request: state.createRequest,
          requestOffset: state.createRequestedAtOffset,
        });
        if (terminal === null) return state;
        return terminal.type === "events.iterate.com/project/created"
          ? { ...state, birthCertificate: terminal.payload }
          : { ...state, createFailure: terminal.payload };
      }
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
  /** Fetch-lane dispatch into the default worker; successful responses carry OS source identity. */
  workerFetch: (request: Request) => Promise<Response>;
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
  state: {
    birthCertificate: { config: { slug: string } } | null;
    createRequest: { config: { slug: string } } | null;
  },
  projectId: string,
): ProjectDirectoryRecord {
  const slug = state.birthCertificate?.config.slug ?? state.createRequest?.config.slug ?? projectId;
  return { id: projectId, slug, organizationId: null, name: slug };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
