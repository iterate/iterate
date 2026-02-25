import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  eventBusContract,
  EventStreamEvent as eventStreamEventSchema,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import {
  REGISTRY_ROUTE_CHANGED_EVENT_TYPE,
  REGISTRY_ROUTE_CHANGED_STREAM_PATH,
  registryRouteChangedPayloadSchema,
} from "@iterate-com/registry-contract";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { createOrpcRpcServiceClient } from "@iterate-com/shared/jonasland";

interface CaddySyncEnv {
  host: string;
  port: number;
  eventsServiceOrpcUrl: string;
  registryServiceOrpcUrl: string;
  streamPath: string;
  subscriptionSlug: string;
  callbackPath: string;
  callbackBaseUrl: string;
  reconcileIntervalMs: number;
  registerRetryMs: number;
  caddyAdminUrl?: string;
  caddyListenAddress?: string;
}

interface RuntimeState {
  subscriptionRegistered: boolean;
  lastEventType?: string;
  lastEventAt?: string;
  lastReconcileAt?: string;
  lastError?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number, key: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key}: ${raw}`);
  }
  return parsed;
}

function parseHost(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value && value.length > 0 ? value : fallback;
}

function parseUrl(raw: string | undefined, fallback: string, key: string): string {
  const value = raw?.trim() || fallback;
  return new URL(value).toString();
}

function parsePath(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

function getEnv(): CaddySyncEnv {
  const port = parsePositiveInt(process.env.CADDY_SYNC_PORT, 19060, "CADDY_SYNC_PORT");
  const callbackBaseDefault = `http://127.0.0.1:${String(port)}`;

  return {
    host: parseHost(process.env.CADDY_SYNC_HOST, "0.0.0.0"),
    port,
    eventsServiceOrpcUrl: parseUrl(
      process.env.CADDY_SYNC_EVENTS_SERVICE_ORPC_URL,
      "http://127.0.0.1:19010/orpc",
      "CADDY_SYNC_EVENTS_SERVICE_ORPC_URL",
    ),
    registryServiceOrpcUrl: parseUrl(
      process.env.CADDY_SYNC_REGISTRY_SERVICE_ORPC_URL,
      "http://127.0.0.1:8777/orpc",
      "CADDY_SYNC_REGISTRY_SERVICE_ORPC_URL",
    ),
    streamPath:
      process.env.CADDY_SYNC_EVENT_STREAM_PATH?.trim() || REGISTRY_ROUTE_CHANGED_STREAM_PATH,
    subscriptionSlug:
      process.env.CADDY_SYNC_SUBSCRIPTION_SLUG?.trim() || "registry-route-caddy-sync",
    callbackPath: parsePath(
      process.env.CADDY_SYNC_CALLBACK_PATH,
      "/callbacks/registry-route-changed",
    ),
    callbackBaseUrl: parseUrl(
      process.env.CADDY_SYNC_CALLBACK_BASE_URL,
      callbackBaseDefault,
      "CADDY_SYNC_CALLBACK_BASE_URL",
    ),
    reconcileIntervalMs: parsePositiveInt(
      process.env.CADDY_SYNC_RECONCILE_INTERVAL_MS,
      30_000,
      "CADDY_SYNC_RECONCILE_INTERVAL_MS",
    ),
    registerRetryMs: parsePositiveInt(
      process.env.CADDY_SYNC_REGISTER_RETRY_MS,
      1_000,
      "CADDY_SYNC_REGISTER_RETRY_MS",
    ),
    ...(process.env.CADDY_SYNC_CADDY_ADMIN_URL?.trim()
      ? { caddyAdminUrl: process.env.CADDY_SYNC_CADDY_ADMIN_URL.trim() }
      : {}),
    ...(process.env.CADDY_SYNC_CADDY_LISTEN_ADDRESS?.trim()
      ? { caddyListenAddress: process.env.CADDY_SYNC_CADDY_LISTEN_ADDRESS.trim() }
      : {}),
  };
}

function normalizeStreamPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const env = getEnv();
  const callbackUrl = new URL(env.callbackPath, env.callbackBaseUrl).toString();

  const eventsClient = createOrpcRpcServiceClient<typeof eventBusContract>({
    env: {},
    manifest: eventsServiceManifest,
    url: env.eventsServiceOrpcUrl,
  });
  const registryClient = createRegistryClient({ url: env.registryServiceOrpcUrl });

  const state: RuntimeState = {
    subscriptionRegistered: false,
  };

  let shuttingDown = false;
  let reconcileRunning = false;
  let reconcileQueued = false;
  let reconcileQueueReason = "startup";

  const reconcile = async (reason: string): Promise<void> => {
    const result = await registryClient.routes.caddyLoadInvocation({
      ...(env.caddyAdminUrl ? { adminUrl: env.caddyAdminUrl } : {}),
      ...(env.caddyListenAddress ? { listenAddress: env.caddyListenAddress } : {}),
      apply: true,
    });
    state.lastReconcileAt = new Date().toISOString();
    process.stdout.write(
      `caddy-sync reconciled reason=${reason} route_count=${String(result.routeCount)} applied=${String(result.applied)}\n`,
    );
  };

  const enqueueReconcile = (reason: string): void => {
    reconcileQueued = true;
    reconcileQueueReason = reason;
    if (reconcileRunning) return;

    reconcileRunning = true;
    void (async () => {
      while (reconcileQueued && !shuttingDown) {
        reconcileQueued = false;
        const activeReason = reconcileQueueReason;
        try {
          await reconcile(activeReason);
          state.lastError = undefined;
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          process.stdout.write(`caddy-sync reconcile failed: ${state.lastError}\n`);
        }
      }
      reconcileRunning = false;
    })();
  };

  const handleIncomingEvent = (input: unknown): void => {
    const parsedEvent = eventStreamEventSchema.safeParse(input);
    if (!parsedEvent.success) return;

    const event = parsedEvent.data;
    const streamPathMatches =
      normalizeStreamPath(event.path) === normalizeStreamPath(env.streamPath);
    if (!streamPathMatches) return;
    if (event.type !== REGISTRY_ROUTE_CHANGED_EVENT_TYPE) return;
    if (!registryRouteChangedPayloadSchema.safeParse(event.payload).success) return;

    state.lastEventType = event.type;
    state.lastEventAt = new Date().toISOString();
    enqueueReconcile("event");
  };

  const registerSubscription = async (): Promise<void> => {
    while (!shuttingDown) {
      try {
        await eventsClient.registerSubscription({
          path: env.streamPath,
          subscription: {
            type: "webhook",
            URL: callbackUrl,
            subscriptionSlug: env.subscriptionSlug,
          },
        });
        state.subscriptionRegistered = true;
        state.lastError = undefined;
        process.stdout.write(
          `caddy-sync subscription registered stream=${env.streamPath} slug=${env.subscriptionSlug} callback=${callbackUrl}\n`,
        );
        return;
      } catch (error) {
        state.subscriptionRegistered = false;
        state.lastError = error instanceof Error ? error.message : String(error);
        process.stdout.write(`caddy-sync subscription register failed: ${state.lastError}\n`);
        await delay(env.registerRetryMs);
      }
    }
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (method === "GET" && requestUrl.pathname === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        streamPath: env.streamPath,
        callbackPath: env.callbackPath,
        subscriptionRegistered: state.subscriptionRegistered,
        lastEventType: state.lastEventType,
        lastEventAt: state.lastEventAt,
        lastReconcileAt: state.lastReconcileAt,
        lastError: state.lastError,
      });
      return;
    }

    if (method === "POST" && requestUrl.pathname === env.callbackPath) {
      try {
        const body = await readJsonBody(req);
        handleIncomingEvent(body);
        writeJson(res, 200, { ok: true });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.port, env.host, () => resolve());
  });

  process.stdout.write(
    `caddy-sync listening on http://${env.host}:${String(env.port)} callback=${env.callbackPath}\n`,
  );

  enqueueReconcile("startup");
  void registerSubscription();
  const interval = setInterval(() => enqueueReconcile("interval"), env.reconcileIntervalMs);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  process.stderr.write(
    `caddy-sync fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
