import { DurableObject, tracing } from "cloudflare:workers";
import type { Env } from "../env.ts";

const expectedVersionHeader = "x-iterate-do-expected-version";
const mismatchingVersionHeader = "x-iterate-do-mismatching-version";

type ObjectConstructor = new (ctx: DurableObjectState<{}>, env: Env) => DurableObject<Env>;
type VersionedCall = { ready: false; version: string } | { ready: true; value: unknown };

/** Check the receiving incarnation before invoking the method. A mismatch is
 * an inert response, not an exception or permission to replay failed work.
 * Constructors and Cloudflare lifecycle callbacks retain their normal behavior.
 * This internal RPC has exactly the authority of the DO binding itself. */
export function withDeploymentReadiness<T extends ObjectConstructor>(Base: T): T {
  // Preserve the original class's public methods/statics for Wrangler bindings.
  // The subclass only adds an internal RPC and wraps its environment bindings.
  const Parent: ObjectConstructor = Base;
  class VersionedObject extends Parent {
    constructor(ctx: DurableObjectState<{}>, env: Env) {
      super(ctx, deploymentReadyEnv(env));
    }

    async fetch(request: Request): Promise<Response> {
      const expected = request.headers.get(expectedVersionHeader);
      if (!super.fetch) throw new TypeError("Durable Object has no fetch handler");
      if (!expected) return await super.fetch(request);
      const actual = this.env.CF_VERSION_METADATA?.id || "unversioned";
      if (expected !== actual) {
        return new Response(null, { status: 503, headers: { [mismatchingVersionHeader]: actual } });
      }
      const forwarded = new Request(request);
      forwarded.headers.delete(expectedVersionHeader);
      const response = await super.fetch(forwarded);
      // A downstream response must never impersonate the inert guard reply:
      // that would authorize replay after the application already ran.
      if (!response.headers.has(mismatchingVersionHeader)) return response;
      const clean = new Response(response.body, response);
      clean.headers.delete(mismatchingVersionHeader);
      return clean;
    }

    async callAtVersion(
      version: string,
      method: string,
      args: unknown[] | null,
    ): Promise<VersionedCall> {
      const actual = this.env.CF_VERSION_METADATA?.id || "unversioned";
      if (version !== actual) return { ready: false, version: actual };
      // Mirror native RPC's prototype-method boundary; never expose instance
      // fields, Object.prototype, or this dispatch method through reflection.
      for (
        let prototype = Base.prototype;
        prototype !== DurableObject.prototype && prototype !== Object.prototype;
        prototype = Object.getPrototypeOf(prototype)
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (method === "constructor") break;
        if (!args && descriptor?.get) {
          return { ready: true, value: await descriptor.get.call(this) };
        }
        if (args && typeof descriptor?.value === "function") {
          return { ready: true, value: await descriptor.value.apply(this, args) };
        }
      }
      throw new TypeError(`No Durable Object RPC method ${method}`);
    }
  }
  Object.defineProperty(VersionedObject, "name", { value: Base.name });
  return VersionedObject as unknown as T;
}

// Adding a namespace to Env must also put it behind the preview version check.
// The conditional only classifies bindings; it does not erase their RPC types.
type ObjectBindingName = {
  [K in keyof Env]-?: Env[K] extends DurableObjectNamespace<DurableObject<unknown>> ? K : never;
}[keyof Env];
const objectBindings = {
  DEVICE: true,
  PROJECT: true,
  REPO: true,
  SCHEDULER: true,
  SECRET: true,
  STREAM: true,
  WORKER: true,
  WORKER_BUILD_COORDINATOR: true,
  WORKSPACE_V2: true,
  SANDBOX_LITE: true,
  SANDBOX_BASIC: true,
  SANDBOX_STANDARD_1: true,
  SANDBOX_STANDARD_2: true,
  SANDBOX_STANDARD_3: true,
  SANDBOX_STANDARD_4: true,
} satisfies Record<ObjectBindingName, true>;

/** Preview tests use one pinned, fully deployed version under an exclusive
 * lease. Production gradual deployments deliberately allow mixed versions and
 * retain their existing compatibility contract. Local tests use raw bindings.
 * Resolve lazily: imported Cloudflare env bindings are request-scoped. */
export function deploymentReadyEnv(env: Env): Env {
  return new Proxy(env, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (!env.DEPLOYMENT_ENV?.startsWith("preview_") || !Object.hasOwn(objectBindings, property))
        return value;
      const version = env.CF_VERSION_METADATA?.id;
      if (!version) throw new Error("Preview Durable Object calls require CF_VERSION_METADATA.id");
      return new Proxy(value, {
        get(namespace, key) {
          const member = Reflect.get(namespace, key);
          if (key !== "get" && key !== "getByName")
            return typeof member === "function" ? member.bind(namespace) : member;
          return (...args: unknown[]) => {
            const stub = member.apply(namespace, args);
            return deploymentReadyStub(stub, {
              version,
              object: `${String(property)}:${stub.name || stub.id.toString()}`,
              timeoutMs: 90_000,
              intervalMs: 250,
            });
          };
        },
      });
    },
  });
}

type VersionedStub = {
  deploymentVersion(): Promise<string> & Partial<Disposable>;
  callAtVersion(version: string, method: string, args: unknown[] | null): Promise<VersionedCall>;
};

/** Keep readiness separate from operation recovery. Only a reported version
 * mismatch is polled; once work starts, any error propagates unchanged.
 * The version read supports upgrading from code predating callAtVersion(). */
export function deploymentReadyStub<T extends object>(
  stub: T,
  options: {
    version: string;
    object: string;
    timeoutMs: number;
    intervalMs: number;
  },
): T {
  // All bound OS classes expose deploymentVersion; the expected new version
  // also exports callAtVersion through withDeploymentReadiness in worker.ts.
  const versioned = stub as unknown as VersionedStub;
  let protocolReady = false;
  return new Proxy(stub, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (
        typeof key !== "string" ||
        typeof member !== "function" ||
        key === "deploymentVersion" ||
        key === "callAtVersion"
      ) {
        return typeof member === "function" ? member.bind(target) : member;
      }
      const invoke = (args: unknown[] | null) => {
        // Fetch has different semantics from RPC: the native path normalizes
        // RequestInfo/init and carries WebSocket upgrade responses intact.
        // Retain a request body only until the version check admits it.
        const request =
          key === "fetch" && args ? (Reflect.construct(Request, args) as Request) : undefined;
        request?.headers.set(expectedVersionHeader, options.version);
        const abort = new AbortController();
        let pending: (Promise<unknown> & Partial<Disposable>) | undefined;
        const operation = async () => {
          const startedAt = Date.now();
          let actual = "unknown";
          const timeoutError = () =>
            new Error(
              `Deployment readiness timed out for ${options.object}: expected ${options.version}, got ${actual} after ${Date.now() - startedAt}ms`,
            );
          const readVersion = async () => {
            const remaining = options.timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) throw timeoutError();
            const probe = versioned.deploymentVersion();
            pending = probe;
            let timer: ReturnType<typeof setTimeout>;
            let onAbort: () => void;
            const waiting = new Promise<string>((resolve, reject) => {
              const fail = (error: unknown) => {
                reject(error);
                try {
                  probe[Symbol.dispose]?.();
                } catch (disposeError) {
                  console.warn("deployment probe disposal failed", disposeError);
                }
              };
              timer = setTimeout(() => fail(timeoutError()), remaining);
              onAbort = () => fail(abort.signal.reason);
              abort.signal.addEventListener("abort", onAbort, { once: true });
              probe.then(resolve, reject);
              if (abort.signal.aborted) fail(abort.signal.reason);
            });
            return await waiting.finally(() => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", onAbort);
            });
          };
          while (true) {
            abort.signal.throwIfAborted();
            if (!protocolReady) {
              actual = await readVersion();
              if (actual !== options.version) {
                await tracing.enterSpan("durable_object.wait_for_version", async (span) => {
                  const waitStartedAt = Date.now();
                  span.setAttribute("iterate.object", options.object);
                  span.setAttribute("iterate.expectedVersion", options.version);
                  span.setAttribute("iterate.actualVersion", actual);
                  console.log("deployment_wait", {
                    object: options.object,
                    expectedVersion: options.version,
                    actualVersion: actual,
                  });
                  do {
                    // Poll the reported version, not elapsed deployment age.
                    await new Promise<void>((resolve, reject) => {
                      const onAbort = () => {
                        clearTimeout(timer);
                        reject(abort.signal.reason);
                      };
                      const timer = setTimeout(
                        () => {
                          abort.signal.removeEventListener("abort", onAbort);
                          resolve();
                        },
                        Math.min(
                          options.intervalMs,
                          Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
                        ),
                      );
                      abort.signal.addEventListener("abort", onAbort, { once: true });
                      if (abort.signal.aborted) onAbort();
                    });
                    actual = await readVersion();
                  } while (actual !== options.version);
                  console.log("deployment_ready", {
                    object: options.object,
                    version: actual,
                    waitMs: Date.now() - waitStartedAt,
                  });
                });
              }
              protocolReady = true;
            }
            abort.signal.throwIfAborted();
            // No await between checking the version and invoking the method
            // on the RECEIVER. Only its inert mismatch response can loop.
            let mismatch: string;
            if (request) {
              const response: Response = await member.call(target, request.clone());
              const version = response.headers.get(mismatchingVersionHeader);
              if (response.status !== 503 || !version) return response;
              mismatch = version;
            } else {
              const call = versioned.callAtVersion(options.version, key, args);
              pending = call;
              const result = await call;
              if (result.ready) return result.value;
              mismatch = result.version;
            }
            protocolReady = false;
            actual = mismatch;
            if (Date.now() - startedAt >= options.timeoutMs) throw timeoutError();
          }
        };
        return Object.assign(
          operation().finally(() => {
            // Do not await tee cancellation: the admitted fetch can still be
            // consuming its other branch while returning a streamed response.
            if (request?.body)
              void request.body
                .cancel()
                .catch((error) => console.warn("deployment request body cleanup failed", error));
          }),
          {
            [Symbol.dispose]() {
              abort.abort(new Error("Durable Object call disposed"));
              pending?.[Symbol.dispose]?.();
            },
          },
        );
      };
      // Native RPC properties are both callable and awaitable. In particular,
      // `await stub.processor` reads a getter that returns a live RpcTarget.
      // Preserve that distinction instead of turning the getter into a plain
      // JavaScript function (which `await` would return without invoking).
      return Object.assign((...args: unknown[]) => invoke(args), {
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return invoke(null).then(resolve, reject);
        },
      });
    },
  });
}
