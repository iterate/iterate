import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDaemonClient, type DaemonClient } from "@iterate-com/daemon-v2-contract";
import { createIngressProxyClient } from "@iterate-com/ingress-proxy-contract";
import pRetry from "p-retry";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import { createSlug } from "../create-slug.ts";
import {
  composeAbortSignal,
  createAbortScope,
  createHostRoutedFetch,
  createTimeoutSignal,
  isAbortError,
  throwIfAborted,
} from "./deployment-utils.ts";
import type {
  DeploymentExecResult,
  DeploymentLogEntry,
  DeploymentOpts,
  DeploymentProvider,
} from "./deployment-provider-manifest.ts";

/**
 * Stateful live deployment object.
 *
 * Public construction and connection are intentionally static-only for now:
 * callers should use `Deployment.create(...)` / `Deployment.connect(...)` and
 * then treat the returned object as a ready runtime handle.
 */
export class Deployment {
  private state: "new" | "connecting" | "connected" | "destroying" | "destroyed" | "disconnected" =
    "new";
  private _slug: string | null = null;
  private _locator: unknown | null = null;
  private _opts: DeploymentOpts | null = null;
  private _providerStatus: Awaited<ReturnType<DeploymentProvider["status"]>> | null = null;
  private _provider: DeploymentProvider | null = null;

  private _pidnap: PidnapClient | null = null;
  private _registryService: DaemonClient | null = null;

  static async create<TOpts extends DeploymentOpts = DeploymentOpts, TLocator = unknown>(params: {
    provider: DeploymentProvider<TOpts, TLocator>;
    opts: TOpts;
    signal?: AbortSignal;
    onLogEntry?: (entry: DeploymentLogEntry) => void | Promise<void>;
  }) {
    const deployment = new Deployment();
    deployment.assertState("new");
    deployment._provider = params.provider;

    const opts = params.provider.optsSchema.parse(params.opts);
    assertValidDeploymentSlug(opts.slug);
    deployment._opts = opts;
    deployment.transition("connecting");
    throwIfAborted(params.signal);

    const provisioned = await params.provider.create({
      signal: params.signal,
      opts,
    });
    const createLogScope = params.onLogEntry
      ? createAbortScope({
          signal: params.signal,
        })
      : null;
    const createLogTask =
      createLogScope && params.onLogEntry
        ? deployment.runBackgroundTask(async () => {
            for await (const entry of params.provider.logs({
              locator: provisioned.locator,
              signal: createLogScope.signal,
              tail: 0,
            })) {
              await params.onLogEntry?.(normalizeDeploymentLogEntry(entry));
            }
          })
        : null;

    try {
      const recoveredOpts = await params.provider.recoverOpts({
        locator: provisioned.locator,
        signal: params.signal,
      });
      assertValidDeploymentSlug(recoveredOpts.slug);
      await deployment.attachRuntime({
        locator: provisioned.locator,
        recoveredOpts,
        bootstrapEnv: recoveredOpts.env ?? {},
      });
    } finally {
      createLogScope?.abort();
      await Promise.allSettled([createLogTask]);
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

    const attached = await params.provider.connect({
      signal: params.signal,
      locator,
    });
    const recoveredOpts = await params.provider.recoverOpts({
      locator: attached.locator,
      signal: params.signal,
    });
    assertValidDeploymentSlug(recoveredOpts.slug);
    await deployment.attachRuntime({
      locator: attached.locator,
      recoveredOpts,
    });
    return deployment;
  }

  async *logs(params: { signal?: AbortSignal; tail?: number } = {}) {
    this.assertConnected();
    // `timeoutMs` stays a caller-facing convenience in this module, but the
    // runtime itself runs on `AbortSignal`. `logs()` owns an extra abort scope
    // because it spawns status polling that must stop both on caller abort and
    // when the async iterator is closed early by the consumer.
    const logScope = createAbortScope({ signal: params.signal });
    const backgroundTasks = [
      this.runBackgroundTask(() => this.pollProviderStatus({ signal: logScope.signal })),
    ];

    try {
      for await (const entry of this.provider.logs({
        locator: this.locator,
        signal: logScope.signal,
        tail: params.tail ?? 200,
      })) {
        yield normalizeDeploymentLogEntry(entry);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      logScope.abort();
      await Promise.allSettled(backgroundTasks);
    }
  }

  snapshot() {
    return {
      slug: this._slug,
      state: this.state,
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

  get env() {
    return this.opts.env ?? {};
  }

  /**
   * Reload the canonical runtime env snapshot from `~/.iterate/.env`.
   *
   * `deployment.env` is intentionally just the last known in-memory view. This
   * method does the explicit runtime I/O to re-read the deployment's shared env
   * file, updates the cached snapshot, and returns the fresh env record.
   *
   * That makes it the "trust live runtime state over recovered provider
   * metadata" escape hatch after reconnect or after out-of-band changes inside
   * the sandbox.
   */
  async reloadEnv() {
    const liveEnv = await this.readRuntimeEnvFile();
    this.updateRuntimeEnvSnapshot(liveEnv ?? {});
    return this.env;
  }

  get pidnap() {
    this.assertConnected();
    if (this._pidnap) return this._pidnap;
    this._pidnap = createPidnapClient({
      url: `${this.ingressUrl()}/rpc`,
      fetch: this.routedFetch("pidnap.iterate.localhost"),
    });
    return this._pidnap;
  }

  get registryService() {
    this.assertConnected();
    if (this._registryService) return this._registryService;
    this._registryService = createDaemonClient({
      url: `${this.ingressUrl()}/api`,
      fetch: this.routedFetch("registry.iterate.localhost"),
    });
    return this._registryService;
  }

  async waitUntilHealthy(params?: { signal?: AbortSignal; timeoutMs?: number }) {
    this.assertConnected();
    const signal = composeAbortSignal(params ?? {});
    const startedAt = Date.now();
    const ingressUrl = this.ingressUrl();

    console.log(`[deployment] waiting for caddy at ${ingressUrl}/__iterate/caddy-health...`);
    await pWaitFor(
      async () => {
        const resp = await fetch(`${ingressUrl}/__iterate/caddy-health`, { signal }).catch(
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

  async waitUntilAlive(params?: { signal?: AbortSignal; timeoutMs?: number }) {
    await this.waitUntilHealthy(params);
  }

  async fetch(host: string, path: string, init?: RequestInit) {
    this.assertConnected();
    const req = new Request(
      new URL(path.startsWith("/") ? path : `/${path}`, this.ingressUrl()),
      init,
    );
    return await this.routedFetch(host)(req);
  }

  async resolvePublicURL(params: { internalURL: string }) {
    this.assertConnected();
    return await this.registryService.getPublicURL({
      internalURL: params.internalURL,
    });
  }

  async exec(cmd: string[]) {
    this.assertConnected();
    return await this.provider.exec({
      locator: this.locator,
      cmd,
    });
  }

  async shell(params: { cmd: string; signal?: AbortSignal; timeoutMs?: number }) {
    this.assertConnected();
    const signal = composeAbortSignal(params);
    return await this.provider.exec({
      locator: this.locator,
      signal,
      cmd: ["sh", "-ec", params.cmd],
    });
  }

  async shellWithRetry(params: {
    cmd: string;
    timeoutMs: number;
    retryIf: (result: DeploymentExecResult) => boolean;
    signal?: AbortSignal;
    intervalMs?: number;
  }) {
    this.assertConnected();
    const signal = composeAbortSignal(params);
    const intervalMs = params.intervalMs ?? 500;
    const retries = Math.max(0, Math.ceil(params.timeoutMs / intervalMs));
    let lastResult: DeploymentExecResult | null = null;

    try {
      return await pRetry(
        async () => {
          const result = await this.shell({
            cmd: params.cmd,
            signal,
          });
          lastResult = result;
          if (!params.retryIf(result)) return result;
          throw new Error(result.output || `shell command exited ${String(result.exitCode)}`);
        },
        {
          retries,
          signal,
          minTimeout: intervalMs,
          maxTimeout: intervalMs,
          factor: 1,
        },
      );
    } catch (error) {
      if (lastResult != null) {
        const last: DeploymentExecResult = lastResult;
        throw new Error(
          `Timed out waiting for shell command to satisfy retry predicate: ${last.output || String(last.exitCode)}`,
          { cause: error },
        );
      }
      throw error;
    }
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

  /**
   * Merge env vars into the deployment's canonical `~/.iterate/.env` file.
   *
   * This is intentionally patch-style rather than replace-style: callers pass
   * only the keys they want to change, and the existing runtime env snapshot is
   * preserved for all other keys.
   *
   * The file is rendered in TypeScript and then written as a whole so pidnap
   * and shell startup see one consistent format. Because that same file is both
   * sourced by shell startup and parsed by pidnap, keys must remain
   * shell-compatible variable names.
   *
   * By default this waits for the deployment to become healthy again after the
   * write. Callers can opt out when they are doing lower-level bootstrap or
   * when a different readiness sequence is more appropriate.
   */
  async setEnvVars(
    env: Record<string, string>,
    options: {
      waitForHealthy?: boolean;
    } = {},
  ) {
    const entries = Object.entries(env);
    if (entries.length === 0) return;
    const nextEnv = {
      ...this.env,
      ...normalizeRuntimeEnvRecord(Object.fromEntries(entries)),
    };
    await this.writeRuntimeEnvFile(nextEnv);
    if (options.waitForHealthy ?? true) {
      await this.waitUntilHealthy({
        // [[ feels bad to have this constant here?! ]]
        timeoutMs: 30_000,
      });
      // TODO this can probably deleted / is crap
      // await this.waitForConfiguredNetworkTargets({
      //   env: nextEnv,
      //   timeoutMs: 30_000,
      // });
    }
  }

  async getCloudflareTunnelUrl(params: { timeoutMs: number }) {
    const result = await this.shellWithRetry({
      cmd: 'url=$(cat ~/.iterate/cloudflare-tunnel.url 2>/dev/null || true); if [ -n "$url" ]; then printf \'%s\' "$url"; fi',
      timeoutMs: params.timeoutMs,
      retryIf: (shellResult) =>
        shellResult.exitCode !== 0 || !shellResult.stdout.trim().startsWith("https://"),
    });
    return result.stdout.trim();
  }

  async useIngressProxyRoutes(params: {
    ingressProxyApiKey: string;
    ingressProxyBaseUrl: string;
    targetURL: string;
    publicBaseHost?: string;
    routingType?: "subdomain-host" | "dunder-prefix";
    ingressDefaultApp?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }) {
    this.assertConnected();
    const ingressProxyClient = createIngressProxyClient({
      baseURL: normalizeIngressProxyBaseUrl(params.ingressProxyBaseUrl),
      apiToken: params.ingressProxyApiKey.trim(),
    });
    const publicBaseHost =
      params.publicBaseHost ??
      createPublicBaseHost({
        slug: this.slug,
        domain: resolveIngressProxyDomainFromBaseUrl(params.ingressProxyBaseUrl),
      });
    const routingType = params.routingType ?? "dunder-prefix";
    const route = await ingressProxyClient.routes.upsert({
      rootHost: publicBaseHost,
      targetUrl: params.targetURL,
      metadata: {
        source: "deployment.useIngressProxyRoutes",
        publicBaseHost,
        deployment: this.snapshot(),
        ...(params.metadata ?? {}),
      },
    });
    let deleted = false;
    const deleteAll = async () => {
      if (deleted) return;
      deleted = true;
      await ingressProxyClient.routes.remove({ rootHost: publicBaseHost });
    };

    try {
      await this.setEnvVars(
        {
          ITERATE_INGRESS_HOST: publicBaseHost,
          ITERATE_INGRESS_ROUTING_TYPE: routingType,
          ...(params.ingressDefaultApp
            ? { ITERATE_INGRESS_DEFAULT_APP: params.ingressDefaultApp }
            : {}),
        },
        { waitForHealthy: true },
      );
      await waitForPublicText({
        url: `https://${publicBaseHost}/__iterate/caddy-health`,
        timeoutMs: params.timeoutMs ?? 60_000,
        matches: (body) => body.includes("ok"),
      });
    } catch (error) {
      await deleteAll().catch(() => {});
      throw error;
    }

    return {
      publicBaseHost,
      publicBaseUrl: `https://${publicBaseHost}`,
      route,
      deleteAll,
      async [Symbol.asyncDispose]() {
        if (process.env.E2E_NO_DISPOSE) return;
        await deleteAll();
      },
    };
  }

  async status(params: { signal?: AbortSignal } = {}) {
    this.assertConnected();
    const status = await this.provider.status({
      signal: params.signal,
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
    this._locator = null;
    this._provider = null;
    this._providerStatus = null;
    this._opts = null;
    this.transition("destroyed");
  }

  /**
   * Provider metadata is the source of truth for provider-owned runtime shape
   * such as image, entrypoint, cmd, and machine/container details.
   *
   * Runtime env vars are different: once the deployment is attached, the live env
   * should come from `~/.iterate/.env`, because that is what pidnap and shell
   * consumers actually read. `create()` bootstraps that file from recovered env
   * once, and `connect()` rehydrates from the existing file when present.
   */
  /**
   * Finalize a provider create/connect result into a live `Deployment`.
   *
   * Provider metadata is still the source of truth for provider-owned runtime
   * shape such as image, entrypoint, cmd, and machine/container details.
   * Runtime env is different: once the deployment is attached, the live env
   * should come from `~/.iterate/.env`, because that is what pidnap and shell
   * consumers actually read.
   *
   * `create()` bootstraps that file from recovered env once, and `connect()`
   * rehydrates from the existing file when present.
   */
  private async attachRuntime(params: {
    locator: unknown;
    recoveredOpts: DeploymentOpts;
    bootstrapEnv?: Record<string, string>;
  }) {
    this._slug = params.recoveredOpts.slug;
    this._locator = params.locator;
    this._opts = params.recoveredOpts;
    this._providerStatus = null;
    this.transition("connected");

    if (params.bootstrapEnv) {
      await this.writeRuntimeEnvFile(params.bootstrapEnv);
      return;
    }

    const liveEnv = await this.readRuntimeEnvFile();
    this.updateRuntimeEnvSnapshot(liveEnv ?? params.recoveredOpts.env ?? {});
  }

  private assertConnected() {
    this.assertState("connected");
  }

  /**
   * Read the shared runtime env file if it exists.
   *
   * The env file is shared by pidnap and shell startup, so we keep the format
   * intentionally small: shell-compatible keys plus a conservative dotenv
   * quoting style that this file knows how to round-trip.
   */
  private async readRuntimeEnvFile() {
    const result = await this.shell({
      cmd: [
        'env_path="$HOME/.iterate/.env"',
        'if [ -f "$env_path" ]; then',
        `  printf '%s\\n' '${DEPLOYMENT_ENV_FILE_PRESENT_MARKER}'`,
        '  sed -n "p" "$env_path"',
        "else",
        `  printf '%s' '${DEPLOYMENT_ENV_FILE_MISSING_MARKER}'`,
        "fi",
      ].join("\n"),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed reading runtime env file: ${result.output}`);
    }
    if (result.stdout.startsWith(DEPLOYMENT_ENV_FILE_MISSING_MARKER)) {
      return null;
    }
    if (!result.stdout.startsWith(`${DEPLOYMENT_ENV_FILE_PRESENT_MARKER}\n`)) {
      throw new Error(`Unexpected runtime env file read response: ${result.stdout}`);
    }
    return parseRuntimeEnvFile(
      result.stdout.slice(`${DEPLOYMENT_ENV_FILE_PRESENT_MARKER}\n`.length),
    );
  }

  /**
   * Rewrite the shared runtime env file and immediately update the in-memory
   * `deployment.env` snapshot to match what was written.
   */
  private async writeRuntimeEnvFile(env: Record<string, string>) {
    const normalizedEnv = this.resolveCanonicalRuntimeEnv(env);
    const envFileContent = serializeRuntimeEnvFile(normalizedEnv);
    const result = await this.shell({
      cmd: [
        "mkdir -p ~/.iterate",
        'env_path="$HOME/.iterate/.env"',
        `tee "$env_path" >/dev/null <<'${DEPLOYMENT_ENV_FILE_HEREDOC_MARKER}'`,
        envFileContent,
        DEPLOYMENT_ENV_FILE_HEREDOC_MARKER,
        'chmod 600 "$env_path"',
      ].join("\n"),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed writing env vars to ~/.iterate/.env: ${result.output}`);
    }
    this.updateRuntimeEnvSnapshot(normalizedEnv);
  }

  private updateRuntimeEnvSnapshot(env: Record<string, string>) {
    if (!this._opts) return;
    const nextEnv = this.resolveCanonicalRuntimeEnv(env);
    this._opts = {
      ...this._opts,
      env: toOptionalRuntimeEnv(nextEnv),
    };
  }

  /**
   * Build the fetch base URL directly from the canonical ingress host.
   *
   * This is intentionally just `http://${ITERATE_INGRESS_HOST}` so the host
   * remains the real source of truth and the URL stays an explicit derived
   * convenience, not a separate runtime concept.
   */
  ingressUrl() {
    return `http://${this.runtimeIngressHost()}`;
  }

  private runtimeIngressHost() {
    const ingressHost = this.env.ITERATE_INGRESS_HOST?.trim();
    if (!ingressHost) {
      throw new Error(`${this.constructor.name} has no ITERATE_INGRESS_HOST`);
    }
    return normalizeCanonicalIngressHost(ingressHost);
  }

  private resolveCanonicalRuntimeEnv(env: Record<string, string>) {
    const ingressHost =
      env.ITERATE_INGRESS_HOST?.trim() ||
      this.provider.getDefaultIngressHost({ locator: this.locator });
    return normalizeRuntimeEnvRecord({
      ...env,
      ITERATE_INGRESS_HOST: normalizeCanonicalIngressHost(ingressHost),
    });
  }

  private routedFetch(host: string) {
    return createHostRoutedFetch({ baseUrl: this.ingressUrl(), host });
  }

  private transition(
    next: "new" | "connecting" | "connected" | "destroying" | "destroyed" | "disconnected",
  ) {
    if (this.state === next) return;
    this.state = next;
  }

  private async runBackgroundTask(task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      if (!isAbortError(error)) {
        console.warn(
          `[deployment] background task failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async pollProviderStatus(params: { signal: AbortSignal }) {
    const provider = this.provider;
    const locator = this.locator;
    while (!params.signal.aborted) {
      const status = await provider.status({ locator, signal: params.signal });
      this._providerStatus = status;

      await sleep(2_000, undefined, { signal: params.signal });
    }
  }

  private assertState(
    expected: "new" | "connecting" | "connected" | "destroying" | "destroyed" | "disconnected",
  ) {
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

export const DEPLOYMENT_SLUG_MAX_LENGTH = 43;

export function isValidDeploymentSlug(slug: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= DEPLOYMENT_SLUG_MAX_LENGTH;
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

export function assertValidDeploymentSlug(slug: string) {
  if (isValidDeploymentSlug(slug)) return;
  throw new Error(
    `Invalid deployment slug: ${JSON.stringify(slug)}. Deployment slugs must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and be <= ${String(DEPLOYMENT_SLUG_MAX_LENGTH)} characters.`,
  );
}

function normalizeIngressProxyBaseUrl(value: string | undefined) {
  return (value ?? DEFAULT_INGRESS_PROXY_BASE_URL).trim().replace(/\/+$/, "");
}

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";
const DEPLOYMENT_ENV_FILE_PRESENT_MARKER = "__DEPLOYMENT_ENV_PRESENT__";
const DEPLOYMENT_ENV_FILE_MISSING_MARKER = "__DEPLOYMENT_ENV_MISSING__";
const DEPLOYMENT_ENV_FILE_HEREDOC_MARKER = "__DEPLOYMENT_ENV_FILE__";

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

function assertShellCompatibleEnvVarKey(key: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable key: ${key}`);
  }
}

function normalizeRuntimeEnvRecord(env: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    assertShellCompatibleEnvVarKey(key);
    normalized[key] = value;
  }
  return normalized;
}

function toOptionalRuntimeEnv(env: Record<string, string>) {
  return Object.keys(env).length > 0 ? env : undefined;
}

function serializeRuntimeEnvFile(env: Record<string, string>) {
  return Object.entries(normalizeRuntimeEnvRecord(env))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteRuntimeEnvValue(value)}`)
    .join("\n");
}

function quoteRuntimeEnvValue(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseRuntimeEnvFile(content: string) {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const rawValue = line.slice(separatorIndex + 1);
    env[key] = parseRuntimeEnvValue(rawValue);
  }
  return env;
}

function parseRuntimeEnvValue(rawValue: string) {
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    let decoded = "";
    for (let index = 1; index < rawValue.length - 1; index += 1) {
      const current = rawValue[index];
      if (current === "\\" && index + 1 < rawValue.length - 1) {
        decoded += rawValue[index + 1];
        index += 1;
        continue;
      }
      decoded += current;
    }
    return decoded;
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function normalizeCanonicalIngressHost(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("ITERATE_INGRESS_HOST is required");
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(normalized) || normalized.includes("/")) {
    throw new Error(`ITERATE_INGRESS_HOST must be a host, received ${JSON.stringify(value)}`);
  }
  return normalized;
}

function resolveIngressProxyDomainFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(normalizeIngressProxyBaseUrl(baseUrl)).hostname;
  } catch {
    return DEFAULT_INGRESS_PROXY_DOMAIN;
  }
}

function sanitizeIngressSlug(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function createPublicBaseHost(params: { slug: string; domain: string }) {
  return `${sanitizeIngressSlug(params.slug)}-${randomUUID().slice(0, 6)}.${params.domain}`;
}

async function waitForPublicText(params: {
  url: string;
  timeoutMs: number;
  matches: (body: string) => boolean;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        signal: createTimeoutSignal(10_000),
      });
      lastBody = await response.text();
      if (response.ok && params.matches(lastBody)) return lastBody;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for public response ${params.url}; last body=${lastBody}`);
}

function normalizeDeploymentLogEntry(entry: DeploymentLogEntry): DeploymentLogEntry {
  return {
    ...entry,
    observedAt: entry.observedAt ?? new Date().toISOString(),
  };
}
