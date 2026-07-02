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
  BlindEgressRelay,
  CfExecutionContext,
  ProjectEgressIntercept,
  ProjectEgressInterceptor,
} from "../../types.ts";
import { deepRetainRpcStubs } from "../itx/live-capability.ts";
import { secretErrorResponse, secretReferencePathsFromHeaders } from "../secrets/utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

type ProjectEgressMode =
  | {
      kind: "blind-relay";
      retained: ReturnType<typeof deepRetainRpcStubs<BlindEgressRelay>>;
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

  async fetch(request: Request): Promise<Response> {
    if (this.#egressMode?.kind === "interceptor") {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressMode.retained.value(request);
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

    const secret = this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: secretPaths[0]!,
      }),
    );
    if (this.#egressMode?.kind === "blind-relay") {
      return secret.fetchWithBlindRelay(request, this.#egressMode.retained.value);
    }
    return secret.fetch(request);
  }

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressIntercept {
    if (typeof handler !== "function")
      throw new Error("project egress interceptor must be a function");
    const mode: ProjectEgressMode = {
      kind: "interceptor",
      retained: deepRetainRpcStubs(handler),
    };
    this.#setEgressMode(mode);

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressMode !== mode) return;
        mode.retained[Symbol.dispose]();
        this.#egressMode = undefined;
      },
    });
  }

  useBlindRelay(relay: BlindEgressRelay): ProjectEgressIntercept {
    const mode: ProjectEgressMode = {
      kind: "blind-relay",
      retained: deepRetainRpcStubs(relay),
    };
    this.#setEgressMode(mode);

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressMode !== mode) return;
        mode.retained[Symbol.dispose]();
        this.#egressMode = undefined;
      },
    });
  }

  #setEgressMode(mode: ProjectEgressMode) {
    if (this.#egressMode !== undefined) {
      console.warn("project egress mode overwritten", {
        nextKind: mode.kind,
        previousKind: this.#egressMode.kind,
        projectId: this.#name.projectId,
      });
      this.#egressMode.retained[Symbol.dispose]();
    }
    this.#egressMode = mode;
  }
}

/**
 * Disposable ownership handle returned by `project.egress.intercept(...)`.
 *
 * The Project Durable Object owns the retained live callback. This handle only
 * releases that exact retained callback if it is still the current interceptor.
 */
class ProjectEgressInterceptRpcTarget extends RpcTarget implements ProjectEgressIntercept {
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
