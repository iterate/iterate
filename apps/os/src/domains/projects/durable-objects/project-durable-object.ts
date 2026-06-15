// The Project Durable Object: project-domain machinery — processors over
// the project's root stream and creation orchestration.
//
// The PROJECT CONTEXT does NOT live here: it is an ItxDurableObject like
// every other context, at the coordinate `(projectId, "/")` — createProject
// appends its subscription + creation events onto the root stream alongside
// this DO's own processor subscriptions (itx/coordinates.ts). Capability
// dispatch, live shadows, and facet caps all live on that node.
//
// The project's WORKER does not live here either: it is an ordinary
// repo-sourced capability (PROJECT_WORKER_SOURCE, itx/platform-context.ts)
// built through the generic per-commit R2 memo (itx/source-build.ts).
// Ingress loads it in the stateless ProjectIngressEntrypoint; this DO only
// forwards root-stream events to its processEvent hook
// (project-worker-runtime.ts).
//
// State lives in the project's root event stream, projected by
// ProjectProcessor (stream-processors/project-processor.ts), which also owns
// every creation side effect — including the one D1 `projects` projection.
// There is no bespoke project table and no lifecycle mixin: the DO is
// addressed by the plain project id.

import { DurableObject } from "cloudflare:workers";
import { type Event } from "@iterate-com/shared/streams/types";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { parseConfig } from "~/config.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import {
  PROJECT_STREAM_PATH,
  projectFacts,
  ProjectProcessorContract,
  type ProjectFacts,
} from "~/domains/projects/stream-processors/project/contract.ts";
import { ProjectProcessor } from "~/domains/projects/stream-processors/project/implementation.ts";
import {
  ProjectConfigWorkerProcessor,
  ProjectConfigWorkerProcessorContract,
} from "~/domains/projects/stream-processors/project-config-worker/implementation.ts";
import {
  isMissingProjectWorkerError,
  loadProjectWorker,
} from "~/domains/projects/project-worker-runtime.ts";
import { type RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { createContext } from "~/itx/coordinates.ts";
import { PLATFORM_PROJECT_CONTEXT_ADDRESS } from "~/itx/platform-context.ts";
import { DEFAULTS_DESCRIBE_FROM } from "~/itx/types.ts";
import {
  getProjectDurableObjectName,
  getProjectDurableObjectStub,
} from "~/domains/projects/durable-objects/project-durable-object-ref.ts";

export { getProjectDurableObjectName, getProjectDurableObjectStub };

export type ProjectSummary = {
  id: string;
  slug: string;
  defaultHost: string;
  hosts: string[];
};

export type CreateProjectInput = {
  projectId: string;
  slug: string;
};

type ProjectEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  APP_CONFIG: string;
  DB: D1Database;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export class ProjectDurableObject extends DurableObject<ProjectEnv> {
  // ---- processor: the project's durable state ----------------------------
  //
  // The root stream ("/") is the record; ProjectProcessor projects it into
  // the snapshot this DO reads back and owns every creation side effect.

  host = createStreamProcessorHost(this.ctx);
  #projectProcessor = this.host.add(
    ProjectProcessorContract.slug,
    (deps) =>
      new ProjectProcessor({
        ...deps,
        appConfig: () => this.getAppConfig(),
        env: this.env,
        exports: this.ctx.exports,
        projectId: () => this.projectId,
      }),
  );
  // The worker as a stream processor: every root-stream event is forwarded
  // to its processEvent export, checkpointed (project-config-worker/
  // contract.ts has the composition story — per-project agent context etc.).
  workerForwarder = this.host.add(
    ProjectConfigWorkerProcessorContract.slug,
    (deps) =>
      new ProjectConfigWorkerProcessor({
        ...deps,
        forwardToConfigWorker: (event) =>
          this.forwardEventToWorker({ event, streamPath: PROJECT_STREAM_PATH }),
      }),
  );

  /**
   * The project's processor, part of the DO's public surface:
   *
   *   await itx.project.processor.snapshot();   // one expression via itx
   *
   * A prototype getter (own instance fields don't cross Workers RPC). The
   * one-expression spelling works because `itx.project` is a path proxy that
   * awaits intermediate property segments (handle.ts) — workerd itself does
   * not pipeline calls through property accesses, so code holding a RAW
   * Workers stub must await the property first:
   *
   *   const processor = await stub.processor;
   *   await processor.snapshot();
   */
  get processor() {
    return this.#projectProcessor;
  }

  /** Subscription callables on the project's root stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  // ---- identity & creation ------------------------------------------------
  //
  // Projects are intentionally ownerless at their core. Organization
  // membership is an access grant in D1, not a property of this DO, because
  // agents can create unclaimed projects that a user or organization claims
  // later, similar to Stripe sandboxes.

  /** The DO name IS the project id (see getProjectDurableObjectName). */
  private get projectId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("ProjectDurableObject must be addressed by name (the project id).");
    return name;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    // The DO's name IS the project id; a mismatched input would wire the
    // subscription and creation events to another project's stream.
    if (input.projectId !== this.projectId) {
      throw new Error(
        `createProject(${input.projectId}) dialed on the DO for "${this.projectId}".`,
      );
    }

    // Both appends are idempotent, as is every downstream creation step —
    // calling createProject again is a no-op that returns the summary.
    await this.ensureProjectSubscription(input.projectId);
    // The PROJECT CONTEXT: an ItxDurableObject at (projectId, "/"), created
    // like any other context — subscription + creation event on the root
    // stream. Its parent is the platform defaults (the chain's code root).
    await createContext({
      env: this.env as unknown as Env,
      name: input.slug,
      namespace: input.projectId,
      parent: { address: PLATFORM_PROJECT_CONTEXT_ADDRESS, ref: DEFAULTS_DESCRIBE_FROM },
      path: "/",
    });
    const stream = await this.projectStream(input.projectId);
    await stream.append({
      type: "events.iterate.com/project/create-requested",
      idempotencyKey: `project-create-requested:${input.projectId}`,
      payload: { projectId: input.projectId, slug: input.slug },
    });

    // That's it — no waiting. The creation steps (D1 projection, repo,
    // example secret, agents root, created/create-completed events) run in
    // ProjectProcessor and leave a trail on the root stream; callers redirect
    // to the project immediately and watch `processor.snapshot()`
    // (phase: creating → ready) if they care about progress.
    return toSummary(projectFacts({ config: this.getAppConfig(), ...input }));
  }

  async getSummary(): Promise<ProjectSummary> {
    return await this.requireSummary();
  }

  async describe(): Promise<ProjectSummary & { ingressUrl: string }> {
    return {
      ...(await this.requireSummary()),
      ingressUrl: await this.ingressUrl(),
    };
  }

  async ingressUrl(): Promise<string> {
    const summary = await this.requireSummary();
    const config = this.getAppConfig();
    const row = await this.env.DB.prepare(`SELECT custom_hostname FROM projects WHERE id = ?`)
      .bind(summary.id)
      .first<{ custom_hostname: string | null }>();
    const host = row?.custom_hostname?.trim().toLowerCase() || summary.defaultHost;
    // Local dev serves project hosts on the dev server's port
    // (<slug>.localhost:<port>), so carry the base URL's port, not just
    // its protocol.
    const base = config.baseUrl ? new URL(config.baseUrl) : null;
    const protocol = base?.protocol ?? "https:";
    const port = base?.port ? `:${base.port}` : "";
    return new URL(`${protocol}//${host}${port}`).origin;
  }

  /**
   * Checkpointed delivery to the worker's processEvent export, dialed by the
   * project-config-worker processor under blockProcessorWhile. The worker is
   * loaded EXACTLY (latestMaxAgeMs 0 probes the repo head): an event can be
   * the direct consequence of a config push — a new agent created right
   * after its config landed — and serving the previous worker would consume
   * the very trigger the new config exists to handle. USER failures (the
   * project's hook throwing) are swallowed — an author's bug must never
   * wedge root-stream delivery; a MISSING worker (no repo, no worker.js yet)
   * is a normal skip; PLATFORM failures (build/git errors) throw so the
   * checkpoint holds and the event is redelivered rather than dropped.
   */
  private async forwardEventToWorker(input: { event: StreamEvent; streamPath: string }) {
    const summary = await this.currentSummary();
    if (summary === null) return;
    let entrypoint;
    try {
      entrypoint = await loadProjectWorker({
        env: this.env as typeof this.env & Parameters<typeof loadProjectWorker>[0]["env"],
        exports: this.ctx.exports,
        latestMaxAgeMs: 0,
        projectId: summary.id,
      });
    } catch (error) {
      if (isMissingProjectWorkerError(error)) return;
      throw error;
    }
    try {
      await entrypoint.processEvent?.({
        event: input.event as unknown as Event,
        streamPath: input.streamPath,
      });
    } catch (error) {
      console.error("Project worker processEvent failed.", error);
    }
  }

  // ---- plumbing ------------------------------------------------------------

  private async requireSummary(): Promise<ProjectSummary> {
    const summary = await this.currentSummary();
    if (!summary) throw new Error("Project has not been created yet.");
    return summary;
  }

  private async currentSummary(): Promise<ProjectSummary | null> {
    const snapshot = await this.#projectProcessor.snapshot();
    if (snapshot.state.project) return toSummary(snapshot.state.project);

    // Cold path: the snapshot can lag the create-requested append by a beat.
    // The D1 projection is the first creation step and hosts derive purely
    // from (projectId, slug, config), so reconstruct from D1.
    const projectId = this.projectId;
    const row = await this.env.DB.prepare(`SELECT slug FROM projects WHERE id = ?`)
      .bind(projectId)
      .first<{ slug: string }>();
    if (!row) return null;
    return toSummary(projectFacts({ config: this.getAppConfig(), projectId, slug: row.slug }));
  }

  private async projectStream(projectId: string) {
    return await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: projectId,
      path: PROJECT_STREAM_PATH,
    });
  }

  private async ensureProjectSubscription(projectId: string) {
    const stream = await this.projectStream(projectId);
    await stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `project-subscription:${projectId}:project-processor`,
      payload: {
        subscriptionKey: `project:${projectId}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "PROJECT",
          durableObjectName: getProjectDurableObjectName(projectId),
          processorName: ProjectProcessorContract.slug,
        }),
      },
    });
    await stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `project-config-worker-subscription:${projectId}`,
      payload: {
        subscriptionKey: `project-config-worker:${projectId}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "PROJECT",
          durableObjectName: getProjectDurableObjectName(projectId),
          processorName: ProjectConfigWorkerProcessorContract.slug,
        }),
      },
    });
  }

  private getAppConfig() {
    return parseConfig(this.env);
  }
}

function toSummary(facts: ProjectFacts): ProjectSummary {
  return {
    id: facts.projectId,
    slug: facts.slug,
    defaultHost: facts.defaultHost,
    hosts: facts.hosts,
  };
}
