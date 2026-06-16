// Implements the "project" processor (see ./contract.ts for the event
// taxonomy), hosted by ProjectDurableObject.
//
// In OS, processors make things happen by reacting to facts on streams and
// appending more facts to streams. The important pattern here is:
//
//   1. A project-root stream receives `stream/child-stream-created`.
//   2. The project processor recognizes the child path as one of its domains.
//   3. It appends a tiny setup batch to the CHILD stream: processor
//      subscriptions plus any project-owned birth-certificate facts.
//
// No separate Durable Object initializer is involved. Durable Object instances
// are just hosts for processors and RPC tools; the durable state is the event
// log plus each processor's reduced snapshot.
//
// `reduce` projects project lifecycle and child-stream facts into state. The
// one remaining D1 write is the `projects` projection used by hostname routing;
// domain state such as repos/agents/workspaces is reduced from stream facts.
//
// `processEventBatch` owns idempotent project creation effects: routing
// projection, project repo setup, onboarding stream setup, and cross-posting the
// create-requested fact to the global /projects audit stream. Each effect leaves
// a fact on a stream so replay and at-least-once delivery are safe.
//
// The processor also forwards project-root facts to the project's own worker
// processEvent hook, with checkpointed at-least-once delivery. The platform's
// create-requested trigger is consumed here to bootstrap the project; the
// project worker starts from the emitted facts.

import { StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";
import { projectFacts, ProjectProcessorContract, type ProjectProcessorState } from "./contract.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { agentProcessorSubscriptionConfiguredEvents } from "~/domains/agents/agent-stream-subscriptions.ts";
import { SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE } from "~/domains/agents/agent-prompt-guidance.ts";
import { DEFAULT_WORKERS_AI_AGENT_MODEL } from "~/domains/agents/stream-processors/agent/contract.ts";
import {
  getSlackAgentDurableObjectName,
  type SlackAgentDurableObject,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { getSlackIntegrationDurableObjectName } from "~/domains/slack/slack-naming.ts";
import { SlackAgentProcessorContract } from "~/domains/slack/stream-processors/slack-agent/contract.ts";
import { SlackProcessorContract } from "~/domains/slack/stream-processors/slack/contract.ts";
import { ensureProjectRepoInfoForProject } from "~/domains/repos/entrypoints/repo-capability.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { PROJECT_REPO_ONBOARDING_MD } from "~/domains/repos/project-repo-template.ts";
import type { AppConfig } from "~/config.ts";
import { SLACK_INTEGRATION_STREAM_PATH } from "~/domains/secrets/integration-stream-constants.ts";

export { PROJECT_STREAM_PATH, projectFacts, ProjectProcessorContract } from "./contract.ts";
export type { ProjectFacts, ProjectProcessorState } from "./contract.ts";

const ONBOARDING_AGENT_PATH = StreamPath.parse("/agents/onboarding");
function reduceChildStreamCreated(
  state: ProjectProcessorState,
  event: StreamEvent,
): ProjectProcessorState {
  const path = StreamPath.safeParse((event.payload as { childPath?: unknown }).childPath);
  if (!path.success) return state;

  const child = { createdAt: event.createdAt, path: path.data };
  if (path.data.startsWith("/agents/")) {
    return { ...state, agents: appendChildStream(state.agents, child) };
  }
  if (path.data.startsWith("/repos/")) {
    return { ...state, repos: appendChildStream(state.repos, child) };
  }
  if (path.data.startsWith("/workspaces/")) {
    return { ...state, workspaces: appendChildStream(state.workspaces, child) };
  }
  return state;
}

function appendChildStream(
  children: ProjectProcessorState["repos"],
  child: ProjectProcessorState["repos"][number],
) {
  if (children.some((existing) => existing.path === child.path)) return children;
  return [...children, child];
}

/**
 * High-level deps from the hosting DO: bindings, its loopback exports, and
 * the worker host. The step LOGIC lives in this class, not behind closures.
 */
export type ProjectProcessorDeps = {
  env: {
    AGENT: DurableObjectNamespace<AgentDurableObject>;
    DB: D1Database;
    REPO: DurableObjectNamespace<RepoDurableObject>;
    SLACK_AGENT: DurableObjectNamespace<SlackAgentDurableObject>;
    STREAM: DurableObjectNamespace<StreamDurableObject>;
  };
  /** The hosting DO's `ctx.exports` (loopback entrypoints for project-owned side effects). */
  exports: unknown;
  /** The hosting DO's own project id — payloads must match (see #ownEvent). */
  projectId: () => string;
  appConfig: () => AppConfig;
  /**
   * Delivers one root-stream event to the project's worker processEvent hook.
   * User-code failures are swallowed by the host; platform failures throw so
   * the processor checkpoint holds and the event is replayed.
   */
  forwardToProjectWorker: (event: StreamEvent) => Promise<void>;
};

export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  /**
   * Anyone holding the project's itx handle can append arbitrary events to
   * its streams, so creation events are only honored when their payload
   * names THIS project — otherwise a crafted create-requested on project A's
   * stream could run creation side effects (D1 upsert, repo setup) for an
   * arbitrary project id.
   */
  #ownEvent(payload: { projectId: string }): boolean {
    return payload.projectId === this.deps.projectId();
  }

  protected override reduce(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["reduce"]>[0],
  ): ProjectProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (!this.#ownEvent(event.payload)) return state;
        return { ...state, phase: state.phase === "ready" ? state.phase : "creating" };
      case "events.iterate.com/project/created":
        if (!this.#ownEvent(event.payload)) return state;
        return { ...state, project: event.payload };
      case "events.iterate.com/project/create-completed":
        if (!this.#ownEvent(event.payload)) return state;
        return { ...state, phase: "ready" };
      case "events.iterate.com/project/onboarding-completed":
        if (!this.#ownEvent(event.payload)) return state;
        return { ...state, onboarding: "completed" };
      case "events.iterate.com/stream/child-stream-created":
        return reduceChildStreamCreated(state, event);
      default:
        return state;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    for (const reducedEvent of args.reducedEvents) {
      await this.#processRootEvent({
        event: reducedEvent.event,
        state: reducedEvent.state,
      });
    }
  }

  async #processRootEvent(args: {
    event: Parameters<StreamProcessor<ProjectProcessorContract>["processEvent"]>[0]["event"];
    state: ProjectProcessorState;
  }) {
    const { event, state } = args;
    if (event.type === "events.iterate.com/stream/child-stream-created") {
      await this.#reactToChildStreamCreated(event);
    }

    if (event.type === "events.iterate.com/project/create-requested") {
      if (!this.#ownEvent(event.payload)) {
        console.warn(
          `[project] ignoring create-requested for "${event.payload.projectId}" ` +
            `on project "${this.deps.projectId()}" (offset ${event.offset}).`,
        );
      } else {
        await this.#createProject(event.payload);
      }
      return;
    }

    if (state.project === null) return;

    await this.deps.forwardToProjectWorker(event);
  }

  // ---- creation steps -------------------------------------------------------

  async #createProject(input: { projectId: string; slug: string }) {
    const { projectId, slug } = input;
    const facts = projectFacts({ config: this.deps.appConfig(), projectId, slug });
    await this.#upsertProjectProjection({ projectId, slug });
    await this.#crossPostToGlobalProjects({ projectId, slug });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/project/created",
        idempotencyKey: `project-created:${projectId}`,
        payload: facts,
      },
    });
    await this.#ensureProjectRepo({ projectId, slug });
    await this.#appendAgentStreamBirthCertificate({
      agentPath: ONBOARDING_AGENT_PATH,
      projectId,
    });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/project/create-completed",
        idempotencyKey: `project-create-completed:${projectId}`,
        payload: { projectId },
      },
    });
  }

  /**
   * The one D1 projection of project identity. Platform-host routing
   * (src/ingress/lookup.ts) resolves <slug>.<base> hosts from this table.
   */
  async #upsertProjectProjection(input: { projectId: string; slug: string }) {
    const row = await this.deps.env.DB.prepare(
      `INSERT INTO projects (id, slug, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
       ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        updated_at = excluded.updated_at
       RETURNING id`,
    )
      .bind(input.projectId, input.slug)
      .first<{ id: string }>();

    if (!row) throw new Error(`Project ${input.projectId} projection was not written.`);
  }

  /**
   * The deployment-wide audit surface for project lifecycle: every
   * create-requested is cross-posted to /projects in the global project scope.
   */
  async #crossPostToGlobalProjects(input: { projectId: string; slug: string }) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.deps.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: null,
      path: StreamPath.parse("/projects"),
    });
    await stream.append({
      type: "events.iterate.com/project/create-requested",
      idempotencyKey: `project-create-requested:${input.projectId}`,
      payload: { projectId: input.projectId, slug: input.slug },
    });
  }

  /** The project's repo (`/repos/project`), with its own fact on the stream. */
  async #ensureProjectRepo(input: { projectId: string; slug: string }) {
    const repo = await ensureProjectRepoInfoForProject({
      env: this.deps.env,
      projectId: input.projectId,
    });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/project/repo-initialized",
        idempotencyKey: `project-repo-initialized:${input.projectId}:${repo.path}`,
        payload: {
          defaultBranch: repo.defaultBranch,
          projectId: input.projectId,
          repoPath: repo.path,
        },
      },
    });
  }

  /**
   * Child stream creation is the project processor's domain hook.
   *
   * The Stream DO emits `child-stream-created` on the parent when a child path
   * first exists. That event is the only signal this processor needs. For
   * known project-local domains, it appends the domain's setup facts onto the
   * child stream itself. Unknown child streams are still tracked in the reduced
   * child lists when they match a known prefix, but they do not get setup here.
   */
  async #reactToChildStreamCreated(event: Extract<StreamEvent, { type: string }>) {
    const childPath = StreamPath.safeParse((event.payload as { childPath?: unknown }).childPath);
    if (!childPath.success) return;

    if (childPath.data.startsWith("/agents/")) {
      await this.#appendAgentStreamBirthCertificate({
        agentPath: childPath.data,
        projectId: this.deps.projectId(),
      });
      return;
    }

    if (childPath.data === SLACK_INTEGRATION_STREAM_PATH) {
      await this.#appendSlackIntegrationBirthCertificate({
        projectId: this.deps.projectId(),
      });
    }
  }

  /**
   * Project-authored birth certificate for an agent stream.
   *
   * This is intentionally just event appends. It does not instantiate an agent
   * Durable Object, call an initializer, or write a side table. The appended
   * facts say:
   *
   * - the main agent processor should consume this stream;
   * - the default OpenAI provider processor should consume LLM requests;
   * - Slack-routed agent streams also get the Slack-agent processor;
   * - the project contributes the default visible configuration.
   *
   * The default provider selection is `ifUnset`, so a domain-specific
   * `agent/llm-provider-selected` fact appended by the UI, a project config
   * worker, or another processor wins when it arrives first. LLM request
   * events carry their selected provider, so extra subscribed provider
   * processors can safely ignore requests addressed to another provider.
   */
  async #appendAgentStreamBirthCertificate(input: { agentPath: StreamPath; projectId: string }) {
    await this.ctx.stream.appendBatch({
      streamPath: input.agentPath,
      events: [
        {
          type: "events.iterate.com/agent/config-updated",
          idempotencyKey: "project-agent-setup:config",
          payload: {
            systemPrompt: defaultAgentSystemPrompt(input.agentPath),
          },
        },
        {
          type: "events.iterate.com/agent/llm-provider-selected",
          idempotencyKey: "project-agent-setup:llm-provider",
          payload: {
            ifUnset: true,
            model: DEFAULT_WORKERS_AI_AGENT_MODEL,
            provider: "openai-ws",
          },
        },
        ...agentProcessorSubscriptionConfiguredEvents({
          agentPath: input.agentPath,
          processorSlugs: ["agent", "openai-ws"],
          projectId: input.projectId,
        }),
        ...(isSlackAgentPath(input.agentPath)
          ? [slackAgentProcessorSubscriptionConfiguredEvent(input)]
          : []),
        ...(input.agentPath === ONBOARDING_AGENT_PATH
          ? [
              {
                type: "events.iterate.com/agent/input-added",
                idempotencyKey: "project-onboarding:start",
                payload: {
                  content:
                    "Start onboarding now. Send the first onboarding message for this new project. " +
                    "Follow ONBOARDING.md and ask exactly one focused question.",
                },
              },
            ]
          : []),
      ],
    });
  }

  async #appendSlackIntegrationBirthCertificate(input: { projectId: string }) {
    await this.ctx.stream.append({
      streamPath: SLACK_INTEGRATION_STREAM_PATH,
      event: {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `slack-subscription:${input.projectId}:workers-rpc:callable`,
        payload: {
          subscriptionKey: `slack:${input.projectId}`,
          subscriber: durableObjectProcessorSubscriber({
            bindingName: "SLACK_INTEGRATION",
            durableObjectName: getSlackIntegrationDurableObjectName(input.projectId),
            processorName: SlackProcessorContract.slug,
          }),
        },
      },
    });
  }
}

function isSlackAgentPath(agentPath: string) {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/slack" || normalized.startsWith("/agents/slack/");
}

export function defaultAgentSystemPrompt(agentPath: string) {
  const isSlack = isSlackAgentPath(agentPath);
  const isOnboarding = agentPath === ONBOARDING_AGENT_PATH;
  return [
    `You are the iterate AI agent running on stream ${agentPath}.`,
    ...(isOnboarding
      ? [
          "You are this project's onboarding agent. Follow the project repo file ONBOARDING.md exactly:",
          PROJECT_REPO_ONBOARDING_MD,
        ]
      : []),
    "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Use capabilities announced as itx/capability-provided events.",
    isSlack
      ? `For Slack, reply only when mentioned, directly asked, or clearly needed. Use await itx.slack.chat.postMessage({ channel, thread_ts, text }) on the same thread. ${SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE}`
      : `For web chat, reply with await itx.chat.sendMessage({ message }). ${SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE}`,
    "Use itx.streams.get(path) to read and append project stream events.",
    "Use the project repo as durable memory for stable project knowledge.",
  ].join("\n\n");
}

function slackAgentProcessorSubscriptionConfiguredEvent(input: {
  agentPath: StreamPath;
  projectId: string;
}) {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `slack-agent-subscription:${input.projectId}:${input.agentPath}:workers-rpc:callable`,
    payload: {
      subscriptionKey: `slack-agent:${input.projectId}:${input.agentPath}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "SLACK_AGENT",
        durableObjectName: getSlackAgentDurableObjectName({
          projectId: input.projectId,
          path: input.agentPath,
        }),
        processorName: SlackAgentProcessorContract.slug,
      }),
    },
  };
}
