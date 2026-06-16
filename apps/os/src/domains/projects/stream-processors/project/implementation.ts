// Implements the "project" processor (see ./contract.ts for the event
// taxonomy), hosted on ProjectDurableObject via createStreamProcessorHost.
//
// `reduce` projects the lifecycle events into state (the DO keeps no project
// table of its own — this snapshot IS the project's durable state).
// `processEvent` owns the creation side effects END TO END: the one D1
// `projects` projection (platform-host routing reads it), the project
// repo, the example egress secret, the agents root, and a cross-post of
// create-requested onto the deployment-wide global project scope's /projects
// stream (the global audit surface for project lifecycle). Each step leaves
// its fact on the stream and is idempotent, so at-least-once delivery is
// safe. The worker build deliberately does NOT gate
// create-completed: ingress requests build on demand, so a failed build
// self-heals on the next request.
//
// This processor also forwards project-root facts to the project's own worker
// processEvent hook, with checkpointed at-least-once delivery. The platform's
// create-requested trigger is consumed here to bootstrap the project; the
// worker starts from the emitted facts.

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
import {
  agentProcessorSubscriptionConfiguredEvents,
  AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import {
  getSlackAgentDurableObjectName,
  type SlackAgentDurableObject,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { SlackAgentProcessorContract } from "~/domains/slack/stream-processors/slack-agent/contract.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
  EXAMPLE_EGRESS_SECRET_METADATA,
} from "~/domains/secrets/example-secret.ts";
import { ensureProjectRepoInfoForProject } from "~/domains/repos/entrypoints/repo-capability.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getRepoDurableObjectName } from "~/domains/repos/repo-durable-object-name.ts";
import { PROJECT_REPO_PATH } from "~/domains/repos/project-repo.ts";
import {
  ONBOARDING_AGENT_INPUT,
  projectOnboardingBootstrapMarkdown,
} from "~/domains/repos/project-repo-template.ts";
import type { AppConfig } from "~/config.ts";

export { PROJECT_STREAM_PATH, projectFacts, ProjectProcessorContract } from "./contract.ts";
export type { ProjectFacts, ProjectProcessorState } from "./contract.ts";

const ONBOARDING_AGENT_PATH = StreamPath.parse("/agents/onboarding");
const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.5";

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
  /** The hosting DO's `ctx.exports` (loopback entrypoints, e.g. secrets). */
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
   * stream could run creation side effects (D1 upsert, repo, secrets) for an
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
      const childPath = StreamPath.safeParse(event.payload.childPath);
      if (childPath.success && childPath.data.startsWith("/agents/")) {
        await this.#ensureAgentStreamSetup({
          agentPath: childPath.data,
          projectId: this.deps.projectId(),
        });
      }
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
    await this.#seedOnboardingBootstrap({ projectId, slug });
    await this.#ensureExampleEgressSecret(projectId);
    await this.#ensureAgentStreamSetup({ agentPath: ONBOARDING_AGENT_PATH, projectId });
    await this.#appendOnboardingAgentInput(projectId);
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
      projectSlug: input.slug,
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

  async #seedOnboardingBootstrap(input: { projectId: string; slug: string }) {
    const repo = this.deps.env.REPO.getByName(
      getRepoDurableObjectName({
        path: PROJECT_REPO_PATH,
        projectId: input.projectId,
      }),
    );

    await repo.commitFiles({
      author: { name: "Iterate", email: "support@iterate.com" },
      changes: [
        {
          path: "BOOTSTRAP.md",
          content: projectOnboardingBootstrapMarkdown(input),
        },
      ],
      message: "Seed onboarding bootstrap",
    });
  }

  async #ensureExampleEgressSecret(projectId: string) {
    const secrets = getSecretsCapability({
      exports: this.deps.exports as Parameters<typeof getSecretsCapability>[0]["exports"],
      props: { projectId },
    });

    const existing = await secrets.getSecretSummaryByKeyOrNull({
      key: EXAMPLE_EGRESS_SECRET_KEY,
    });
    if (existing) return;

    await secrets.setSecret({
      key: EXAMPLE_EGRESS_SECRET_KEY,
      material: EXAMPLE_EGRESS_SECRET_MATERIAL,
      metadata: EXAMPLE_EGRESS_SECRET_METADATA,
    });
  }

  async #appendOnboardingAgentInput(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.deps.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId,
      path: ONBOARDING_AGENT_PATH,
    });

    await stream.append({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `project-onboarding-agent-input:${projectId}`,
      payload: {
        content: ONBOARDING_AGENT_INPUT,
      },
    });
  }

  async #ensureAgentStreamSetup(input: { agentPath: StreamPath; projectId: string }) {
    await this.ctx.stream.appendBatch({
      streamPath: input.agentPath,
      events: [
        {
          type: AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
          idempotencyKey: "project-agent-setup:provider",
          payload: { model: DEFAULT_OPENAI_AGENT_MODEL, provider: "openai-ws" },
        },
        {
          type: "events.iterate.com/agent/system-prompt-updated",
          idempotencyKey: "project-agent-setup:system-prompt",
          payload: {
            systemPrompt: defaultAgentSystemPrompt(input.agentPath),
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
      ],
    });
  }
}

function isSlackAgentPath(agentPath: string) {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/slack" || normalized.startsWith("/agents/slack/");
}

function defaultAgentSystemPrompt(agentPath: string) {
  const isSlack = isSlackAgentPath(agentPath);
  return [
    `You are the iterate AI agent running on stream ${agentPath}.`,
    "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Use capabilities announced as itx/capability-provided events.",
    isSlack
      ? "For Slack, reply only when mentioned, directly asked, or clearly needed. Use itx.slack.chat.postMessage({ channel, thread_ts, text }) on the same thread."
      : "For web chat, reply with itx.chat.sendMessage({ message }).",
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
