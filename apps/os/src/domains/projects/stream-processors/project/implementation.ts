// Implements the "project" processor (see ./contract.ts for the event
// taxonomy), hosted on ProjectDurableObject via createStreamProcessorHost.
//
// `reduce` projects the lifecycle events into state (the DO keeps no project
// table of its own — this snapshot IS the project's durable state).
// `processEvent` owns the creation side effects END TO END: the one D1
// `projects` projection (platform-host routing reads it), the project
// repo, the example egress secret, the agents root, and a cross-post of
// create-requested onto the deployment-wide `global` namespace's /projects
// stream (the global audit surface for project lifecycle). Each step leaves
// its fact on the stream and is idempotent, so at-least-once delivery is
// safe. The worker build deliberately does NOT gate
// create-completed: ingress requests build on demand, so a failed build
// self-heals on the next request.
//
// Forwarding root-stream events to the worker's own processEvent hook is
// NOT this processor's job: the sibling project-config-worker processor owns
// that, with checkpointed at-least-once delivery.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { projectFacts, ProjectProcessorContract, type ProjectProcessorState } from "./contract.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import {
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { jsonataReactorEventTypes } from "~/domains/agents/stream-processors/jsonata-reactor/contract.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
  EXAMPLE_EGRESS_SECRET_METADATA,
} from "~/domains/secrets/example-secret.ts";
import { ensureProjectRepoInfoForProject } from "~/domains/repos/entrypoints/repo-capability.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { PROJECT_REPO_SLUG } from "~/domains/repos/project-repo.ts";
import {
  ONBOARDING_AGENT_INPUT,
  projectOnboardingBootstrapMarkdown,
} from "~/domains/repos/project-repo-template.ts";
import type { AppConfig } from "~/config.ts";

export { PROJECT_STREAM_PATH, projectFacts, ProjectProcessorContract } from "./contract.ts";
export type { ProjectFacts, ProjectProcessorState } from "./contract.ts";

const ONBOARDING_AGENT_PATH = StreamPath.parse("/agents/onboarding");

/**
 * High-level deps from the hosting DO: bindings, its loopback exports, and
 * the worker host. The step LOGIC lives in this class, not behind closures.
 */
export type ProjectProcessorDeps = {
  env: {
    AGENT: DurableObjectNamespace<AgentDurableObject>;
    DB: D1Database;
    REPO: DurableObjectNamespace<RepoDurableObject>;
    STREAM: DurableObjectNamespace<StreamDurableObject>;
  };
  /** The hosting DO's `ctx.exports` (loopback entrypoints, e.g. secrets). */
  exports: unknown;
  /** The hosting DO's own project id — payloads must match (see #ownEvent). */
  projectId: () => string;
  appConfig: () => AppConfig;
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
      default:
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["processEvent"]>[0],
  ): void {
    const { event } = args;
    if (event.type !== "events.iterate.com/project/create-requested") return;
    if (!this.#ownEvent(event.payload)) {
      console.warn(
        `[project] ignoring create-requested for "${event.payload.projectId}" ` +
          `on project "${this.deps.projectId()}" (offset ${event.offset}).`,
      );
      return;
    }
    const { projectId, slug } = event.payload;

    args.blockProcessorWhile(async () => {
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
      await this.#ensureAgentsRoot(projectId);
      await this.#writeAgentsRootRule(projectId);
      await this.#ensureOnboardingAgent(projectId);
      await this.#appendOnboardingAgentInput(projectId);
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/project/create-completed",
          idempotencyKey: `project-create-completed:${projectId}`,
          payload: { projectId },
        },
      });
    });
  }

  // ---- creation steps -------------------------------------------------------

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
   * create-requested is cross-posted to /projects in the "global" namespace.
   */
  async #crossPostToGlobalProjects(input: { projectId: string; slug: string }) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.deps.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: "global",
      path: StreamPath.parse("/projects"),
    });
    await stream.append({
      type: "events.iterate.com/project/create-requested",
      idempotencyKey: `project-create-requested:${input.projectId}`,
      payload: { projectId: input.projectId, slug: input.slug },
    });
  }

  /** The project's repo (slug `project`), with its own fact on the stream. */
  async #ensureProjectRepo(input: { projectId: string; slug: string }) {
    const repo = await ensureProjectRepoInfoForProject({
      env: this.deps.env,
      projectId: input.projectId,
      projectSlug: input.slug,
    });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/project/repo-initialized",
        idempotencyKey: `project-repo-initialized:${input.projectId}:${repo.slug}`,
        payload: {
          defaultBranch: repo.defaultBranch,
          projectId: input.projectId,
          repoSlug: repo.slug,
        },
      },
    });
  }

  async #seedOnboardingBootstrap(input: { projectId: string; slug: string }) {
    const repo = await getInitializedDoStub({
      allowCreate: false,
      namespace: this.deps.env.REPO,
      name: {
        projectId: input.projectId,
        repoSlug: PROJECT_REPO_SLUG,
      },
    });
    if (!repo) throw new Error(`Project repo for ${input.projectId} was not initialized.`);

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

  async #ensureAgentsRoot(projectId: string) {
    await getInitializedDoStub({
      allowCreate: true,
      namespace: this.deps.env.AGENT,
      name: getAgentDurableObjectName({
        agentPath: AGENTS_STREAM_PATH,
        projectId,
      }),
    });
  }

  async #ensureOnboardingAgent(projectId: string) {
    await getInitializedDoStub({
      allowCreate: true,
      namespace: this.deps.env.AGENT,
      name: getAgentDurableObjectName({
        agentPath: ONBOARDING_AGENT_PATH,
        projectId,
      }),
    });
  }

  async #appendOnboardingAgentInput(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.deps.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
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

  async #writeAgentsRootRule(projectId: string) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.deps.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: AGENTS_STREAM_PATH,
    });

    await stream.append({
      type: jsonataReactorEventTypes.ruleConfigured,
      idempotencyKey: `agents-child-stream-setup:${projectId}`,
      payload: {
        slug: "agents-child-stream-setup",
        matcher: "type = 'events.iterate.com/stream/child-stream-created'",
        reactions: [],
      },
    });
  }
}
