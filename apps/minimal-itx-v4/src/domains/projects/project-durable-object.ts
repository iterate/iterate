import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../streams/stream-processor.ts";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { ItxRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type {
  EgressHttpsProxy,
  CfExecutionContext,
  ProjectEgressHandle,
  ProjectEgressInterceptor,
} from "../../types.ts";
import { deepRetainRpcStubs } from "../itx/live-capability.ts";
import { secretErrorResponse, secretReferencePathsFromHeaders } from "../secrets/utils.ts";
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
        itx: new ItxRpcTarget({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          projectId: this.#name.projectId,
        }),
      }),
  );

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

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressHandle {
    if (typeof handler !== "function") {
      throw new Error("project egress interceptor must be a function");
    }
    return this.#installEgressMode({ kind: "interceptor", retained: deepRetainRpcStubs(handler) });
  }

  useEgressHttpsProxy(proxy: EgressHttpsProxy): ProjectEgressHandle {
    return this.#installEgressMode({ kind: "https-proxy", retained: deepRetainRpcStubs(proxy) });
  }

  /**
   * Install one live egress mode and return the handle that owns it. Last writer
   * wins — any previous mode's retained RPC stubs are disposed. The handle's
   * release clears this exact mode only if it is still current, so a stale
   * handle can never tear down a newer mode.
   */
  #installEgressMode(mode: ProjectEgressMode): ProjectEgressHandle {
    if (this.#egressMode !== undefined) {
      console.warn("project egress mode overwritten", {
        nextKind: mode.kind,
        previousKind: this.#egressMode.kind,
        projectId: this.#name.projectId,
      });
      this.#egressMode.retained[Symbol.dispose]();
    }
    this.#egressMode = mode;

    return new ProjectEgressHandleRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressMode !== mode) return;
        mode.retained[Symbol.dispose]();
        this.#egressMode = undefined;
      },
    });
  }
}

/**
 * Disposable handle returned by `intercept()` / `useEgressHttpsProxy()`. The
 * Project Durable Object owns the installed mode; `release()` is idempotent and
 * runs `#release` (which no-ops if a newer mode has since replaced this one).
 * Disposing schedules the same release on `ctx.waitUntil` so it can't be
 * dropped when the RPC session ends.
 */
class ProjectEgressHandleRpcTarget extends RpcTarget implements ProjectEgressHandle {
  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #release: () => void | Promise<void>;
  #releasePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    release: () => void | Promise<void>;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#release = args.release;
  }

  async release(): Promise<void> {
    await this.#startRelease();
  }

  [Symbol.dispose](): void {
    const work = this.#startRelease().catch((error: unknown) => {
      console.error("project egress intercept dispose failed", { error });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRelease(): Promise<void> {
    this.#releasePromise ??= Promise.resolve(this.#release());
    return this.#releasePromise;
  }
}
