import { DurableObject } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import {
  ItxRpcTarget,
  ProjectEgressInterceptRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import type {
  EgressHttpsProxy,
  ProjectEgressIntercept,
  ProjectEgressInterceptor,
} from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { deepRetainRpcStubs } from "../itx/live-capability.ts";
import { readOpenAiApiKeyFromAppConfig } from "../agents/utils.ts";
import { secretErrorResponse, secretReferencePathsFromHeaders } from "../secrets/utils.ts";
import { SlackProcessorContract } from "../integrations/slack-processor-contract.ts";
import { SlackProcessor } from "../integrations/slack-processor-implementation.ts";
import { eyesReactionTargetFromWebhookPayload } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { runHttpsThroughProxy } from "./egress-https-proxy.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

// The one live egress mode the client installed. `retained` holds the client's
// RPC stubs alive across turns (a bare stub would be collected after the
// installing call returns); it is disposed when the mode is replaced or released.
type ProjectEgressMode =
  | {
      kind: "https-proxy";
      retained: ReturnType<typeof deepRetainRpcStubs<EgressHttpsProxy>>;
    }
  | {
      kind: "interceptor";
      retained: ReturnType<typeof deepRetainRpcStubs<ProjectEgressInterceptor>>;
    };

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  #egressMode?: ProjectEgressMode;
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #projectProcessor = this.#processorHost.add(
    ProjectProcessorContract.slug,
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
  // instance addressed at `/integrations/slack` (the host stream is this DO's
  // own path stream), where the OAuth connect / project bootstrap configured
  // its subscription; registering it on every instance is harmless.
  readonly #slackProcessor = this.#processorHost.add(SlackProcessorContract.slug, (deps) => {
    return new SlackProcessor({
      ...deps,
      acknowledgeRoutedWebhook: async ({ payload }) => {
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        try {
          await callProjectSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
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

  get slackProcessor() {
    return new StreamProcessorRpcTarget(this.#slackProcessor);
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#projectProcessor);
  }

  /**
   * The single decision point for all project egress. Routing, once an
   * interceptor has been ruled out:
   *
   *                      no proxy installed      proxy installed
   *   no secret header   direct fetch()          proxy (already materialized)
   *   one secret header  Secret DO substitutes   Secret DO substitutes, then proxy
   *
   * An interceptor short-circuits the whole table: it runs first, before any
   * secret substitution (so it only sees getSecret(...) placeholders), and owns
   * the response.
   */
  async fetch(request: Request): Promise<Response> {
    if (this.#egressMode?.kind === "interceptor") {
      return await this.#egressMode.retained.value(request);
    }

    let secretPaths: string[];
    try {
      secretPaths = secretReferencePathsFromHeaders(request.headers);
    } catch {
      return secretErrorResponse("secret_reference_required", 400);
    }
    if (secretPaths.length > 1) {
      return secretErrorResponse("multiple_secret_paths_not_supported", 400);
    }

    // An installed proxy carries *every* outbound request (secret or not), so a
    // listener sees all egress as encrypted bytes — symmetric with an
    // interceptor seeing every request.
    const proxy: EgressHttpsProxy | undefined =
      this.#egressMode?.kind === "https-proxy" ? this.#egressMode.retained.value : undefined;

    // No secret to substitute: the request is already fully materialized.
    if (secretPaths.length === 0) {
      if (proxy !== undefined) return runHttpsThroughProxy(request, proxy);
      return fetch(request);
    }

    // One secret: the Secret DO substitutes the real material, then dispatches —
    // directly, or through the proxy (which only ever sees the resulting TLS).
    const secret = this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: secretPaths[0]!,
      }),
    );
    if (proxy !== undefined) return secret.fetchThroughProxy(request, proxy);
    return secret.fetch(request);
  }

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressIntercept {
    if (typeof handler !== "function") {
      throw new Error("project egress interceptor must be a function");
    }
    return this.#installEgressMode({ kind: "interceptor", retained: deepRetainRpcStubs(handler) });
  }

  useEgressHttpsProxy(proxy: EgressHttpsProxy): ProjectEgressIntercept {
    return this.#installEgressMode({ kind: "https-proxy", retained: deepRetainRpcStubs(proxy) });
  }

  /**
   * Install one live egress mode and return the handle that owns it. Last writer
   * wins — any previous mode's retained RPC stubs are disposed. The handle's
   * release clears this exact mode only if it is still current, so a stale
   * handle can never tear down a newer mode.
   */
  #installEgressMode(mode: ProjectEgressMode): ProjectEgressIntercept {
    if (this.#egressMode !== undefined) {
      console.warn("project egress mode overwritten", {
        nextKind: mode.kind,
        previousKind: this.#egressMode.kind,
        projectId: this.#name.projectId,
      });
      this.#egressMode.retained[Symbol.dispose]();
    }
    this.#egressMode = mode;

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressMode !== mode) return;
        mode.retained[Symbol.dispose]();
        this.#egressMode = undefined;
      },
    });
  }
}
