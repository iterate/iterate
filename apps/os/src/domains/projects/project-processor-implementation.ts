import { StreamProcessor } from "../streams/stream-processor.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CONFIG_REPO_PATH } from "../repos/utils.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import type { StreamListItem } from "../streams/schemas.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "../agents/cloudflare-ai-processor-contract.ts";
import { OpenAiWsProcessorContract } from "../agents/openai-ws-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { TelegramAgentProcessorContract } from "../integrations/telegram-agent-processor-contract.ts";
import {
  slackConnectionFromAgentPath,
  telegramConnectionFromAgentPath,
} from "../integrations/utils.ts";
import { EmailAgentProcessorContract } from "../email/email-agent-processor-contract.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH, isEmailAgentPath } from "../email/utils.ts";
import { PrAgentProcessorContract } from "../repos/pr-agent-processor-contract.ts";
import { isPrAgentPath } from "../repos/pr-agent-utils.ts";
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
      case "events.iterate.com/project/create-requested":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return {
          ...state,
          createRequest: {
            projectId: event.payload.projectId,
            slug: event.payload.slug,
          },
          onboardingActive: event.payload.onboardingActive === true,
        };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return { ...state, created: true };
      case "events.iterate.com/project/onboarding-completed":
        return { ...state, onboardingActive: false, onboardingCompletedAt: event.createdAt };
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return recordStream(state, event.payload.path, event.createdAt);
      case "events.iterate.com/stream/child-stream-created":
        return recordStream(state, event.payload.childPath, event.createdAt);
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

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.itx.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.itx.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          // The root saga, the config repo, and the email router arm in
          // parallel — each is one batched append, cutting the create
          // round-trips (see tasks/os-cold-create-latency.md). The Slack
          // webhook router is NOT armed here: connection streams
          // (/integrations/slack/{connection}) are born at connect time by
          // recordSlackConnection. The onboarding agent is deliberately NOT
          // born here: its policy comes from the project worker, so birth
          // waits for the repo-created lane below — after the worker
          // readiness probe — where the pump delivers the birth announcement
          // to an already-built worker and policy lands immediately instead
          // of opening a stock-defaults window.
          await Promise.all([
            timedStep("create-timing", timing, "root-saga-append", () =>
              append(
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
            // The config repo is an ordinary repo on its own stream. Its
            // birth batch is: the repo processor subscription, the
            // cross-post rule that copies EVERY config-repo event onto the
            // project stream `/` (deliver: "all", so the full history —
            // including the `repo/created` this saga's next lane waits for —
            // arrives with provenance), and the create request itself.
            timedStep("create-timing", timing, "config-repo-append", () =>
              appendTo(
                CONFIG_REPO_PATH,
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
                    delivery: {
                      mode: "push",
                      expression: ["streams", ["get", "/"], "acceptCrossPost"],
                    },
                    deliver: "all",
                  },
                },
                {
                  type: "events.iterate.com/repo/create-requested",
                  idempotencyKey: `repo-create-requested:${this.deps.itx.projectId}:${CONFIG_REPO_PATH}`,
                  payload: {
                    path: CONFIG_REPO_PATH,
                    projectId: this.deps.itx.projectId,
                  },
                },
              ),
            ),
            // Arm the email thread router on `/integrations/email` from birth
            // (Slack routers are per-connection and armed by the connect
            // flow); the email ingress door repeats the subscription append
            // (same idempotency key) for projects born before the router
            // existed. The creator's email seeds the project sender allowlist
            // so the owner can email their project from day one without any
            // config.
            timedStep("create-timing", timing, "email-router-append", () =>
              appendTo(
                EMAIL_INTEGRATION_STREAM_PATH,
                buildDurableObjectProcessorSubscriptionConfiguredEvent({
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.itx.projectId,
                    path: EMAIL_INTEGRATION_STREAM_PATH,
                  }),
                  idempotencyKey: `email-router-subscription:${this.deps.itx.projectId}`,
                  processor: ["email", "processor"],
                  processorSlug: EmailProcessorContract.slug,
                }),
                ...(event.payload.creatorEmail === undefined
                  ? []
                  : [
                      {
                        type: "events.iterate.com/email/sender-allowed" as const,
                        idempotencyKey: `email-sender-allowed:${this.deps.itx.projectId}:${event.payload.creatorEmail.toLowerCase()}`,
                        payload: {
                          pattern: event.payload.creatorEmail,
                          reason: "project-owner",
                        },
                      },
                    ]),
              ),
            ),
          ]);
        });
        break;
      }
      case "events.iterate.com/stream/child-stream-created": {
        const childPath = event.payload.childPath;
        if (
          !childPath.startsWith("/agents/") &&
          !childPath.startsWith("/secrets/") &&
          !childPath.startsWith("/scheduler/")
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          const durableObjectName = DurableObjectNameCodec.stringify({
            projectId: this.deps.itx.projectId,
            path: childPath,
          });
          if (childPath.startsWith("/scheduler/")) {
            // A scheduler stream's birth certificate is just its processor
            // subscription: the Scheduler Durable Object reduces schedules and
            // owns the alarm from the first delivered batch onward.
            await appendTo(
              childPath,
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName,
                idempotencyKey: `stream/subscription-configured:${durableObjectName}#${SchedulerProcessorContract.slug}`,
                processor: ["schedulers", ["get", childPath], "processor"],
                processorSlug: SchedulerProcessorContract.slug,
              }),
            );
            return;
          }
          if (childPath.startsWith("/agents/")) {
            // MECHANICS only: the processor subscriptions that make a stream
            // an agent. POLICY — system prompt, model/provider, capability
            // mounts, boot context — is appended by the PROJECT WORKER, which
            // sees this same child-stream-created event through its stream
            // delivery and applies itx.agents.defaults (see
            // project-repo-template/worker.ts and agents/agent-defaults.ts).
            // Slack/Telegram-agent wiring requires the full routed-path shape
            // — the connection segment is what replies authenticate with.
            const isSlack = slackConnectionFromAgentPath(childPath) !== null;
            const isTelegram = telegramConnectionFromAgentPath(childPath) !== null;
            await appendTo(
              childPath,
              // Identical idempotency keys to the create-time onboarding
              // subscriptions, so whichever lane runs second dedupes cleanly.
              ...agentSubscriptionEvents({
                childPath,
                email: isEmailAgentPath(childPath),
                githubPr: isPrAgentPath(childPath),
                projectId: this.deps.itx.projectId,
                slack: isSlack,
                telegram: isTelegram,
              }),
            );
            return;
          }

          await appendTo(
            childPath,
            buildDurableObjectProcessorSubscriptionConfiguredEvent({
              durableObjectName,
              processor: ["secrets", ["get", childPath], "processor"],
              processorSlug: SecretProcessorContract.slug,
            }),
          );
        });
        return;
      }
      case "events.iterate.com/repo/created": {
        // Arrives as a cross-posted copy: the config repo commits its facts
        // on its own stream, and the `cross-post:/` rule armed at create
        // copies them here — this saga only ever reacts to events ON `/`.
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== CONFIG_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          await timedStep("create-timing", timing, "worker-probe", () =>
            waitForDefaultProjectWorker(this.deps.itx),
          );
          await timedStep("create-timing", timing, "project-created-append", () =>
            append({
              type: "events.iterate.com/project/created",
              idempotencyKey: this.idempotencyKey("created"),
              payload: state.createRequest!,
            }),
          );
          // THE onboarding-agent birth, deliberately after the worker probe:
          // the pump delivers the birth announcement to an already-built
          // worker, so the policy (prompt, provider, kickoff) lands
          // immediately — no window where the agent runs on stock defaults.
          await timedStep("create-timing", timing, "onboarding-agent-birth", () =>
            appendTo(ONBOARDING_AGENT_PATH, ...onboardingAgentStartEvents(this.deps)),
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

function onboardingAgentStartEvents(deps: { itx: Pick<ProjectRpcTarget, "projectId"> }) {
  // Mechanics only — the onboarding agent's policy (prompt, provider, the
  // "Start onboarding now" kickoff input) is appended by the project worker
  // once it first builds, via the same child-stream-created reaction as every
  // other agent. Until then the agent answers with the stock defaults.
  return agentSubscriptionEvents({
    childPath: ONBOARDING_AGENT_PATH,
    projectId: deps.itx.projectId,
  });
}

/**
 * The MECHANICS an agent stream is born with: the processor subscriptions
 * that give it an LLM loop, a capability host, and (for Slack/Telegram/email
 * threads) its domain transcriber. Policy — prompt, model, mounts, boot context —
 * comes from the project worker via itx.agents.defaults
 * (agents/agent-defaults.ts).
 */
function agentSubscriptionEvents(input: {
  childPath: string;
  email?: boolean;
  githubPr?: boolean;
  projectId: string;
  slack?: boolean;
  telegram?: boolean;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: input.childPath,
  });
  const subscription = (processorSlug: string, hostKind: "agent" | "capability-host") =>
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${processorSlug}`,
      processor:
        hostKind === "agent"
          ? ["agents", ["get", input.childPath], "processor"]
          : ["capabilityHosts", ["get", input.childPath], "processor"],
      processorSlug,
    });
  return [
    subscription(AgentProcessorContract.slug, "agent"),
    // Both provider processors subscribe; only the one matching the agent's
    // selected llmProvider answers llm-request-requested events.
    subscription(CloudflareAiProcessorContract.slug, "agent"),
    subscription(OpenAiWsProcessorContract.slug, "agent"),
    subscription(CapabilityHostProcessorContract.slug, "capability-host"),
    ...(input.slack ? [subscription(SlackAgentProcessorContract.slug, "agent")] : []),
    ...(input.telegram ? [subscription(TelegramAgentProcessorContract.slug, "agent")] : []),
    ...(input.email ? [subscription(EmailAgentProcessorContract.slug, "agent")] : []),
    ...(input.githubPr ? [subscription(PrAgentProcessorContract.slug, "agent")] : []),
  ];
}

function recordStream<
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
    agents: path.startsWith("/agents/") ? addStreamListItem(state.agents, item) : state.agents,
    repos: path.startsWith("/repos/") ? addStreamListItem(state.repos, item) : state.repos,
    secrets: path.startsWith("/secrets/") ? addStreamListItem(state.secrets, item) : state.secrets,
    streams: addStreamListItem(state.streams, item),
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
      // This probe only cares that the project worker accepted the request. The
      // returned Response can be a Cap'n Web RPC stub, and keeping that stub
      // alive after the probe succeeds is exactly the lifecycle pattern these
      // stream tests are trying to avoid: a short-lived readiness check should
      // not retain a remote object until the whole project bootstrap session
      // ends. Dispose when the runtime supplies Symbol.dispose; local/miniflare
      // Response objects without that hook are a no-op here.
      disposeRpcResult(response);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === PROJECT_WORKER_READY_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROJECT_WORKER_READY_RETRY_MS));
    }
  }
  throw new Error("Default project worker did not become ready before project/created.", {
    cause: lastError,
  });
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
