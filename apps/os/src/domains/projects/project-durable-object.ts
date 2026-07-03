import { DurableObject } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import {
  ItxRpcTarget,
  ProjectEgressInterceptRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import type { ProjectEgressIntercept, ProjectEgressInterceptor } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { deepRetainRpcStubs } from "../itx/live-capability.ts";
import { readOpenAiApiKeyFromAppConfig } from "../agents/utils.ts";
import { secretErrorResponse, secretReferencePathsFromHeaders } from "../secrets/utils.ts";
import { SlackProcessor } from "../integrations/slack-processor-implementation.ts";
import { eyesReactionTargetFromWebhookPayload } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { connectionFromIntegrationStreamPath } from "../integrations/utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  #egressInterceptor?: ReturnType<typeof deepRetainRpcStubs<ProjectEgressInterceptor>>;
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #projectProcessor = this.#processorHost.add(
    (deps) =>
      new ProjectProcessor({
        ...deps,
        // New agents default to openai-ws when the deployment has an OpenAI
        // key configured; otherwise they fall back to Workers AI.
        defaultLlmProvider:
          readOpenAiApiKeyFromAppConfig(this.env) === null ? "cloudflare-ai" : "openai-ws",
        itx: new ItxRpcTarget({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          projectId: this.#name.projectId,
        }),
      }),
  );

  // The Slack webhook router. It only ever WAKES on the Durable Object
  // instances addressed at `/integrations/slack/{connection}` (the host stream
  // is this DO's own path stream), where the OAuth connect flow configured
  // its subscription; registering it on every instance is harmless.
  // Registration is the point: the host wakes the router by slug; nothing
  // dials the facet handle directly anymore (status is a journal fold).
  protected readonly slackRouterRegistration = this.#processorHost.add((deps) => {
    // This DO instance hosts one connection's router stream
    // (/integrations/slack/{connection}): the name IS the connection, for both
    // routing and the bot-token secret path. Null (a non-connection path) is
    // passed through — the processor errors loudly if a mis-armed subscription
    // ever wakes it there.
    const connection = connectionFromIntegrationStreamPath(this.#name.path);
    return new SlackProcessor({
      ...deps,
      connection,
      acknowledgeRoutedWebhook: async ({ payload }) => {
        if (connection === null) return;
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        try {
          await callProjectSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
            connection,
            method: "reactions.add",
            projectId: this.#name.projectId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The slack-agent processor adds the same reaction once the routed
          // stream catches up; whichever lands second dedups here.
          if (message.includes("already_reacted") || message.includes("not_reactable")) return;
          console.error("[slack] routed-webhook acknowledgement failed", {
            error,
            projectId: this.#name.projectId,
          });
        }
      },
    });
  });

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#projectProcessor, {
      // Lists served from this snapshot (child streams, secrets) must reflect
      // a child stream created moments ago even when the root stream's push
      // delivery is lagging or a wake was dropped.
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(ProjectProcessorContract.slug),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#egressInterceptor !== undefined) {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressInterceptor.value(request);
    }

    let secretPaths: string[];
    try {
      secretPaths = secretReferencePathsFromHeaders(request.headers);
    } catch {
      return secretErrorResponse("secret_reference_required", 400);
    }
    if (secretPaths.length === 0) return fetch(request);
    if (secretPaths.length > 1) {
      return secretErrorResponse("multiple_secret_paths_not_supported", 400);
    }

    return this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: secretPaths[0]!,
      }),
    ).fetch(request);
  }

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressIntercept {
    if (typeof handler !== "function")
      throw new Error("project egress interceptor must be a function");
    const retained = deepRetainRpcStubs(handler);
    if (this.#egressInterceptor !== undefined) {
      console.warn("project egress interceptor overwritten", { projectId: this.#name.projectId });
      this.#egressInterceptor[Symbol.dispose]();
    }
    this.#egressInterceptor = retained;

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressInterceptor !== retained) return;
        retained[Symbol.dispose]();
        this.#egressInterceptor = undefined;
      },
    });
  }
}
