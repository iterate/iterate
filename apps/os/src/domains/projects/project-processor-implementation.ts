import { StreamProcessor } from "iterate/processors";
import type { StreamEvent, StreamListItem } from "iterate/processors";
import { timedStep } from "../../lib/step-timing.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CONFIG_REPO_PATH } from "../repos/paths.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CapabilityHostProcessorContract,
  capabilityFallbackForScope,
} from "../capability-host/capability-host-processor-contract.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { SCHEDULER_PRIMARY_PATH } from "../scheduler/utils.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "../email/utils.ts";
import { WORKER_BUILDING_HEADER } from "../workers/worker-serve-info.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { processCustomDomainEvent, reduceCustomDomainEvent } from "./custom-domain-processor.ts";

// Not a bound on build time: the probe fetch carries no buildBudgetMs, so
// each attempt BLOCKS until the seeded worker's cold build (npm install
// included) resolves or fails. The retry window only papers over transient
// dispatch errors around that first build.
const PROJECT_WORKER_READY_ATTEMPTS = 20;
const PROJECT_WORKER_READY_RETRY_MS = 100;
const PROJECT_WORKER_READY_URL = "https://iterate-project.localhost/__itx_project_ready";
const SIBLING_BIRTH_BARRIER_TIMEOUT_MS = 60_000;

export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  {
    itx: ProjectRpcTarget;
    customDomains?: ProjectCustomDomainDeps;
  }
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<ProjectProcessorContract>["reduce"]>[0]) {
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
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return recordPhysicalStream(state, event.payload.path, event.createdAt);
      case "events.iterate.com/stream/child-stream-created":
        return recordPhysicalStream(state, event.payload.childPath, event.createdAt);
      case "events.iterate.com/agent/created":
        return recordDomainObject(state, "agents", event);
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
      default:
        return reduceCustomDomainEvent({ event, state }) ?? state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    state,
    append,
    appendTo,
  }: Parameters<StreamProcessor<ProjectProcessorContract>["processEvent"]>[0]): undefined {
    // Project worker delivery is NOT here: every project stream (this one
    // included) pumps its own events into the worker's `processEventBatch`
    // with a durable checkpoint (see streams/project-worker-delivery.ts).

    // Event-less at-head pass: this processor has no at-head work.
    if (event === null) return;
    if (event.type !== "events.iterate.com/project/created" && state.birthCertificate === null) {
      return;
    }

    switch (event.type) {
      case "events.iterate.com/project/created": {
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          const config = event.payload.config;
          // The root capability host, primary scheduler, config repo, and
          // email router are explicit sibling processors created by the
          // project's birth saga. A physical child stream never implies any
          // processor identity.
          // The project's AI Search instance is born WITH the project so
          // itx.search works from the first query instead of warming lazily
          // (Jonas, 2026-07-13). Fire-and-forget, NOT awaited in the saga:
          // it's a third-party management API call whose latency must never
          // gate project creation or block this processor's delivery (e2e
          // fixture churn showed exactly that). Failure or cancellation is
          // fine — the query/index paths lazily self-heal.
          void this.deps.itx.search.ensureIndex().catch((error: unknown) => {
            console.warn(
              `project create: search instance ensure failed (lazy self-heal remains): ${String(error).slice(0, 200)}`,
            );
          });
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
                  processor: ["capabilityHosts", ["get", "/"], "processor"],
                  processorSlug: CapabilityHostProcessorContract.slug,
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
            // The config repo is an ordinary repo on its own stream. Its
            // birth batch contains the birth certificate, repo processor
            // subscription, and the cross-post rule that copies subsequent
            // config-repo events onto the project stream `/`. The repo
            // processor cross-posts its own birth certificate for the project
            // catalog, so replaying the setup batch here would duplicate it.
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
            // (Slack routers are per-connection and armed by the connect
            // flow). Email ingress only records received mail; it never
            // creates or subscribes the router. The creator's email seeds the
            // project sender allowlist so the owner can email their project
            // from day one without any config.
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

          const capabilityHostOffset = capabilityHostBirth.reduce(
            (maximum, event) => Math.max(maximum, event.offset),
            0,
          );
          const schedulerOffset = schedulerBirth.reduce(
            (maximum, event) => Math.max(maximum, event.offset),
            0,
          );
          const configRepoOffset = configRepoBirth.reduce(
            (maximum, event) => Math.max(maximum, event.offset),
            0,
          );
          const emailRouterOffset = emailRouterBirth.reduce(
            (maximum, event) => Math.max(maximum, event.offset),
            0,
          );
          if (
            capabilityHostOffset === 0 ||
            schedulerOffset === 0 ||
            configRepoOffset === 0 ||
            emailRouterOffset === 0
          ) {
            throw new Error("project birth saga committed an incomplete sibling birth batch");
          }

          // `projects.create()` waits for this Project processor to finish the
          // birth reaction. Do not let that boundary race the sibling
          // processors it created: once the Project birth is processed, every
          // universally available project capability must have folded its own
          // complete birth batch too.
          // These remote processor facades are nested inside the Project
          // processor's own blocking frame. Keep one acknowledgement in
          // flight at a time: the sibling streams already start concurrently
          // from the append batch above, so this does not serialize their
          // processing; it only avoids retaining four cross-DO facade calls
          // through one frame. Every wait is bounded so a broken sibling
          // fails the frame and enters ordinary durable redelivery instead of
          // pinning project creation forever.
          const siblingBirthDeadline = Date.now() + SIBLING_BIRTH_BARRIER_TIMEOUT_MS;
          const remainingSiblingBirthWaitMs = () => {
            const remaining = siblingBirthDeadline - Date.now();
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
        });
        break;
      }
      case "events.iterate.com/repo/ready": {
        // Arrives as a cross-posted copy: the config repo commits its facts
        // on its own stream, and the `cross-post:/` rule armed at create
        // copies them here — this saga only ever reacts to events ON `/`.
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== CONFIG_REPO_PATH ||
          state.ready ||
          state.birthCertificate === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          await timedStep("create-timing", timing, "worker-probe", () =>
            waitForDefaultProjectWorker(this.deps.itx),
          );
          await timedStep("create-timing", timing, "project-ready-append", () =>
            append({
              type: "events.iterate.com/project/ready",
              idempotencyKey: this.idempotencyKey("ready"),
              payload: {},
            }),
          );
        });
        return;
      }

      default:
        if (
          processCustomDomainEvent({
            append,
            blockProcessorWhile,
            customDomains: this.deps.customDomains,
            event,
            idempotencyKey: (key) => this.idempotencyKey(key, event),
            projectId: this.deps.itx.projectId,
            state,
          })
        ) {
          return;
        }
        return;
    }
  }
}

function recordPhysicalStream<
  State extends {
    agents: StreamListItem[];
    repos: StreamListItem[];
    secrets: StreamListItem[];
    streams: StreamListItem[];
  },
>(state: State, path: string, createdAt: string): State {
  const item = { path, createdAt };
  return {
    ...state,
    streams: addStreamListItem(state.streams, item),
  };
}

function recordDomainObject<
  State extends {
    agents: StreamListItem[];
    repos: StreamListItem[];
    secrets: StreamListItem[];
  },
  Key extends "agents" | "repos" | "secrets",
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

async function waitForDefaultProjectWorker(itx: ProjectRpcTarget): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_WORKER_READY_ATTEMPTS; attempt += 1) {
    try {
      // Capability dispatch, on purpose: `worker.fetch` here is an ordinary
      // method call whose Response comes back as a serialized copy — exactly
      // enough for "the worker built, loaded, and answered". Protocol traffic
      // (real HTTP, WebSockets) rides the fetch lane instead; a probe has no
      // protocol needs (docs/dynamic-worker-dispatch.md).
      const response = await itx.worker.fetch(new Request(PROJECT_WORKER_READY_URL));
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
        // The returned Response can be a Cap'n Web RPC stub, and keeping that
        // stub alive after the probe finishes is exactly the lifecycle pattern
        // these stream tests are trying to avoid. Dispose on every attempt;
        // local/miniflare Response objects without the hook are a no-op here.
        disposeRpcResult(response);
      }
    } catch (error) {
      lastError = error;
      if (attempt === PROJECT_WORKER_READY_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROJECT_WORKER_READY_RETRY_MS));
    }
  }
  throw new Error("Default project worker did not become ready before project/ready.", {
    cause: lastError,
  });
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
