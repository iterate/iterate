import { setTimeout as sleep } from "node:timers/promises";
import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry/client";
import { createORPCClient } from "@orpc/client";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import Emittery from "emittery";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import { createSlug } from "../create-slug.ts";
import { localHostForService } from "../index.ts";
import { createHostRoutedFetch, shQuote, throwIfAborted } from "./deployment-utils.ts";
import type {
  DeploymentOpts,
  DeploymentProvider,
  DeploymentProviderState,
  DeploymentProviderStatus,
} from "./deployment-provider-manifest.ts";
export type {
  DeploymentExecResult,
  DeploymentOpts,
  DeploymentProvider,
  DeploymentProviderLogEvent,
  DeploymentProviderManifest,
  DeploymentProviderOpts,
  DeploymentProviderState,
  DeploymentProviderStatus,
} from "./deployment-provider-manifest.ts";

export const DEPLOYMENT_SLUG_MAX_LENGTH = 43;

export function isValidDeploymentSlug(slug: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= DEPLOYMENT_SLUG_MAX_LENGTH;
}

function normalizeDeploymentSlugCandidate(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDeploymentSlugDatePrefix(date: Date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDeploymentSlugTimePrefix(date: Date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

export function createDeploymentSlug(params: {
  input: string;
  includeDate?: boolean;
  includeTime?: boolean;
  now?: Date;
}) {
  const includeDate = params.includeDate ?? false;
  const includeTime = params.includeTime ?? false;
  const now = params.now ?? new Date();
  if (!includeDate) {
    return normalizeDeploymentSlugCandidate(
      createSlug({
        input: params.input,
        maxLength: DEPLOYMENT_SLUG_MAX_LENGTH,
      }),
    );
  }

  const prefix = includeTime
    ? `${formatDeploymentSlugDatePrefix(now)}-${formatDeploymentSlugTimePrefix(now)}-`
    : `${formatDeploymentSlugDatePrefix(now)}-`;
  const remaining = Math.max(1, DEPLOYMENT_SLUG_MAX_LENGTH - prefix.length);
  const normalizedBody = normalizeDeploymentSlugCandidate(
    createSlug({
      input: params.input,
      maxLength: remaining,
    }),
  );
  return `${prefix}${normalizedBody}`.replace(/-+$/g, "");
}

export type DeploymentRuntimeState =
  | "new"
  | "connecting"
  | "connected"
  | "destroying"
  | "destroyed"
  | "disconnected";

export interface DeploymentSnapshot {
  slug: string | null;
  state: DeploymentRuntimeState;
  baseUrl: string | null;
  locator: unknown | null;
  providerStatus: {
    state: DeploymentProviderState;
    detail: string;
  } | null;
  opts: DeploymentOpts | null;
}

export type DeploymentEvent =
  | {
      type: "https://events.iterate.com/deployment/created";
      payload: {
        baseUrl: string;
        locator: unknown;
      };
    }
  | {
      type: "https://events.iterate.com/deployment/started";
      payload: {
        detail: string;
      };
    }
  | {
      type: "https://events.iterate.com/deployment/stopped";
      payload: {
        detail: string;
      };
    }
  | {
      type: "https://events.iterate.com/deployment/logged";
      payload: {
        line: string;
        providerData?: Record<string, unknown>;
      };
    }
  | {
      type: "https://events.iterate.com/deployment/errored";
      payload: {
        message: string;
      };
    }
  | {
      type: "https://events.iterate.com/deployment/destroyed";
      payload: {};
    };

type DeploymentEmitterEvents = {
  [K in DeploymentEvent["type"]]: Extract<DeploymentEvent, { type: K }>;
};

function assertValidEnvVarKey(key: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable key: ${key}`);
  }
}

export function assertValidDeploymentSlug(slug: string) {
  if (isValidDeploymentSlug(slug)) return;
  throw new Error(
    `Invalid deployment slug: ${JSON.stringify(slug)}. Deployment slugs must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and be <= ${String(DEPLOYMENT_SLUG_MAX_LENGTH)} characters.`,
  );
}

/**
 * Stateful live deployment object.
 *
 * Public construction and connection are intentionally static-only for now:
 * callers should use `Deployment.create(...)` / `Deployment.connect(...)` and
 * then treat the returned object as a ready runtime handle.
 */
export class Deployment {
  private state: DeploymentRuntimeState = "new";
  private _slug: string | null = null;
  private _locator: unknown | null = null;
  private _opts: DeploymentOpts | null = null;
  private _providerStatus: Awaited<ReturnType<DeploymentProvider["status"]>> | null = null;
  private _provider: DeploymentProvider | null = null;

  public baseUrl = "";
  private _pidnap: PidnapClient | null = null;
  private _registryService: RegistryClient | null = null;
  private _eventsService: ContractRouterClient<EventBusContract> | null = null;
  private readonly emitter = new Emittery<DeploymentEmitterEvents>();

  static async create<TOpts extends DeploymentOpts = DeploymentOpts, TLocator = unknown>(params: {
    provider: DeploymentProvider<TOpts, TLocator>;
    opts: TOpts;
    signal?: AbortSignal;
  }) {
    const deployment = new Deployment();
    deployment.assertState("new");
    deployment._provider = params.provider;

    const opts = params.provider.optsSchema.parse(params.opts);
    assertValidDeploymentSlug(opts.slug);
    deployment._opts = opts;
    deployment.transition("connecting");
    throwIfAborted(params.signal);

    try {
      const provisioned = await params.provider.create({
        signal: params.signal,
        opts,
      });
      const recoveredOpts = await params.provider.recoverOpts({
        locator: provisioned.locator,
        signal: params.signal,
      });
      assertValidDeploymentSlug(recoveredOpts.slug);
      deployment.baseUrl = provisioned.baseUrl;
      deployment._slug = recoveredOpts.slug;
      deployment._locator = provisioned.locator;
      deployment._opts = recoveredOpts;
      deployment._providerStatus = null;
      deployment.transition("connected");
      deployment.publish({
        type: "https://events.iterate.com/deployment/created",
        payload: {
          baseUrl: provisioned.baseUrl,
          locator: provisioned.locator,
        },
      });
    } catch (error) {
      deployment.publishError(error);
      throw error;
    }

    return deployment;
  }

  static async connect<TOpts extends DeploymentOpts = DeploymentOpts, TLocator = unknown>(params: {
    provider: DeploymentProvider<TOpts, TLocator>;
    locator: TLocator;
    signal?: AbortSignal;
  }) {
    const deployment = new Deployment();
    deployment.assertState("new");
    deployment._provider = params.provider;

    const locator = params.provider.locatorSchema.parse(params.locator);
    deployment._locator = locator;
    deployment.transition("connecting");
    throwIfAborted(params.signal);

    try {
      const attached = await params.provider.connect({
        signal: params.signal,
        locator,
      });
      const recoveredOpts = await params.provider.recoverOpts({
        locator: attached.locator,
        signal: params.signal,
      });
      assertValidDeploymentSlug(recoveredOpts.slug);
      deployment.baseUrl = attached.baseUrl;
      deployment._slug = recoveredOpts.slug;
      deployment._locator = attached.locator;
      deployment._opts = recoveredOpts;
      deployment._providerStatus = null;
      deployment.transition("connected");
    } catch (error) {
      deployment.publishError(error);
      throw error;
    }

    return deployment;
  }

  async *events(params: { signal?: AbortSignal; logTail?: number } = {}) {
    await using iterator = this.emitter.anyEvent({ signal: params.signal });
    const logAbortController = params.signal ? null : new AbortController();
    const logSignal = params.signal ?? logAbortController!.signal;
    const backgroundTasks =
      this.state === "connected"
        ? [
            this.runEventTask(() =>
              this.streamProviderLogs({
                signal: logSignal,
                tail: params.logTail ?? 200,
              }),
            ),
            this.runEventTask(() => this.pollProviderStatus({ signal: logSignal })),
          ]
        : [];

    try {
      for await (const { data } of iterator) {
        yield data;
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      logAbortController?.abort();
      await Promise.allSettled(backgroundTasks);
    }
  }

  snapshot() {
    return {
      slug: this._slug,
      state: this.state,
      baseUrl: this.baseUrl || null,
      locator: this._locator,
      providerStatus: this._providerStatus,
      opts: this._opts,
    };
  }

  get slug() {
    if (!this._slug) {
      throw new Error(`${this.constructor.name} has no slug`);
    }
    return this._slug;
  }

  get locator() {
    if (!this._locator) {
      throw new Error(`${this.constructor.name} has no locator`);
    }
    return this._locator;
  }

  get provider() {
    if (!this._provider) {
      throw new Error(`${this.constructor.name} has no provider`);
    }
    return this._provider;
  }

  get opts() {
    this.assertConnected();
    if (!this._opts) {
      throw new Error(`${this.constructor.name} has no opts`);
    }
    return this._opts;
  }

  get pidnap() {
    this.assertConnected();
    if (this._pidnap) return this._pidnap;
    this._pidnap = createPidnapClient({
      url: `${this.baseUrl}/rpc`,
      fetch: this.routedFetch("pidnap.iterate.localhost"),
    });
    return this._pidnap;
  }

  get registryService() {
    this.assertConnected();
    if (this._registryService) return this._registryService;
    this._registryService = createRegistryClient({
      url: `${this.baseUrl}/api`,
      fetch: this.routedFetch("registry.iterate.localhost"),
    });
    return this._registryService;
  }

  get eventsService() {
    this.assertConnected();
    if (this._eventsService) return this._eventsService;
    this._eventsService = this.createServiceClient({
      slug: eventsServiceManifest.slug,
      orpcContract: eventsServiceManifest.orpcContract,
    });
    return this._eventsService;
  }

  async waitUntilAlive(params?: { signal?: AbortSignal }) {
    this.assertConnected();
    const signal = params?.signal;
    const startedAt = Date.now();

    console.log(`[deployment] waiting for caddy at ${this.baseUrl}/__iterate/caddy-health...`);
    await pWaitFor(
      async () => {
        const resp = await fetch(`${this.baseUrl}/__iterate/caddy-health`, { signal }).catch(
          () => null,
        );
        return resp?.ok ?? false;
      },
      { interval: 500, signal },
    );
    console.log(`[deployment] caddy alive, waiting for core processes + routes...`);

    await pWaitFor(
      async () => {
        try {
          const result = await this.pidnap.processes.waitFor({
            processes: { caddy: "running", registry: "running", events: "running" },
            timeoutMs: 5_000,
          });
          return result.allMet;
        } catch {
          return false;
        }
      },
      { interval: 1_000, signal },
    );

    const routeChecks = [
      {
        hostCandidates: ["registry.iterate.localhost"],
        path: "/api/__iterate/health",
      },
      {
        hostCandidates: [localHostForService({ slug: eventsServiceManifest.slug })],
        path: "/api/__iterate/health",
      },
    ];

    for (const check of routeChecks) {
      await pWaitFor(
        async () => {
          for (const host of check.hostCandidates) {
            const resp = await this.fetch(host, check.path).catch(() => null);
            if (resp?.ok) return true;
          }
          return false;
        },
        { interval: 1_000, signal },
      );
    }

    console.log(`[deployment] alive in ${String(Date.now() - startedAt)}ms`);
  }

  async fetch(host: string, path: string, init?: RequestInit) {
    this.assertConnected();
    const req = new Request(new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl), init);
    return await this.routedFetch(host)(req);
  }

  createServiceClient<TContract extends AnyContractRouter>(params: {
    slug: string;
    orpcContract: TContract;
  }) {
    const normalized = params.slug.trim().toLowerCase();
    const host = normalized.endsWith("-service")
      ? `${normalized.slice(0, -"-service".length)}.iterate.localhost`
      : `${normalized}.iterate.localhost`;
    const link = new OpenAPILink(params.orpcContract, {
      url: `${this.baseUrl}/api`,
      fetch: this.routedFetch(host),
    });
    return createORPCClient(link) as ContractRouterClient<TContract>;
  }

  async exec(cmd: string[]) {
    this.assertConnected();
    return await this.provider.exec({
      locator: this.locator,
      cmd,
    });
  }

  async shell(params: { cmd: string; signal?: AbortSignal }) {
    this.assertConnected();
    return await this.provider.exec({
      locator: this.locator,
      signal: params.signal,
      cmd: ["sh", "-ec", params.cmd],
    });
  }

  async start() {
    this.assertConnected();
    await this.provider.start({
      locator: this.locator,
    });
  }

  async stop() {
    this.assertConnected();
    await this.provider.stop({
      locator: this.locator,
    });
  }

  async setEnvVars(env: Record<string, string>) {
    this.assertConnected();
    const entries = Object.entries(env);
    if (entries.length === 0) return;

    for (const [key] of entries) {
      assertValidEnvVarKey(key);
    }

    const lines = entries.map(
      ([key, value]) => `echo ${shQuote(`${key}=${value}`)} >> ~/.iterate/.env`,
    );

    const result = await this.shell({
      cmd: ["mkdir -p ~/.iterate", ...lines].join("\n"),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed writing env vars to ~/.iterate/.env: ${result.output}`);
    }
  }

  async status() {
    this.assertConnected();
    const status = await this.provider.status({
      locator: this.locator,
    });
    this._providerStatus = status;
    return status;
  }

  async destroy() {
    if (this.state === "destroyed") return;

    const locator = this._locator;
    const provider = this._provider;
    this.transition("destroying");

    if (locator && provider) {
      await provider.destroy({ locator });
    }

    this._pidnap = null;
    this._registryService = null;
    this._eventsService = null;
    this._locator = null;
    this._provider = null;
    this.baseUrl = "";
    this._providerStatus = null;
    this._opts = null;
    this.transition("destroyed");
    this.publish({
      type: "https://events.iterate.com/deployment/destroyed",
      payload: {},
    });
  }

  private publish(event: DeploymentEvent) {
    void this.emitter.emit(event.type, event);
  }

  private assertConnected() {
    this.assertState("connected");
  }

  private routedFetch(host: string) {
    if (!this.baseUrl) {
      throw new Error(`${this.constructor.name} has no baseUrl`);
    }
    return createHostRoutedFetch({ baseUrl: this.baseUrl, host });
  }

  private transition(next: DeploymentRuntimeState) {
    if (this.state === next) return;
    this.state = next;
  }

  private publishError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.publish({
      type: "https://events.iterate.com/deployment/errored",
      payload: { message },
    });
  }

  private async runEventTask(task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      if (!isAbortError(error)) {
        this.publishError(error);
      }
    }
  }

  private async streamProviderLogs(params: { signal: AbortSignal; tail: number }) {
    const provider = this.provider;
    const locator = this.locator;
    for await (const logEvent of provider.logs({
      locator,
      signal: params.signal,
      tail: params.tail,
    })) {
      this.publish({
        type: "https://events.iterate.com/deployment/logged",
        payload: {
          line: logEvent.line,
          ...(logEvent.providerData ? { providerData: logEvent.providerData } : {}),
        },
      });
    }
  }

  private async pollProviderStatus(params: { signal: AbortSignal }) {
    const provider = this.provider;
    const locator = this.locator;
    let previousLifecycle: "started" | "stopped" | "error" | null = null;

    // Keep translating provider-specific status into the normalized event stream
    // until the caller aborts the subscription.
    while (!params.signal.aborted) {
      const status = await provider.status({ locator });
      this._providerStatus = status;

      const lifecycle =
        status.state === "running" || status.state === "starting"
          ? "started"
          : status.state === "stopped" || status.state === "destroyed"
            ? "stopped"
            : status.state === "error"
              ? "error"
              : null;

      if (lifecycle && lifecycle !== previousLifecycle) {
        previousLifecycle = lifecycle;
        if (lifecycle === "started") {
          this.publish({
            type: "https://events.iterate.com/deployment/started",
            payload: { detail: status.detail },
          });
        } else if (lifecycle === "stopped") {
          this.publish({
            type: "https://events.iterate.com/deployment/stopped",
            payload: { detail: status.detail },
          });
        } else {
          this.publish({
            type: "https://events.iterate.com/deployment/errored",
            payload: { message: status.detail },
          });
        }
      }

      await sleep(2_000, undefined, { signal: params.signal });
    }
  }

  private assertState(expected: DeploymentRuntimeState) {
    if (this.state !== expected) {
      throw new Error(
        `${this.constructor.name} is in state "${this.state}", expected "${expected}"`,
      );
    }
  }

  toJSON() {
    return this.snapshot();
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.message.includes("aborted");
}
