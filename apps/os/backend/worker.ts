import jsonata from "@mmkal/jsonata/sync";
import { Hono, type Context } from "hono";
import { minimatch } from "minimatch";
import { parseRouter } from "trpc-cli";
import { contextStorage } from "hono/context-storage";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { RPCHandler } from "@orpc/server/fetch";
import { onError } from "@orpc/server";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import { createRouterClient } from "@orpc/server";
import { sql } from "drizzle-orm";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import {
  isProjectIngressHostname,
  parseProjectIngressHostname,
} from "@iterate-com/shared/project-ingress";
import dedent from "dedent";
import type { CloudflareEnv } from "../env.ts";
import { isNonProd } from "../env.ts";
import { getDb } from "./db/client.ts";
import { getAuth } from "./auth/auth.ts";
import { appRouter } from "./orpc/root.ts";
import { createContext } from "./orpc/context.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { githubApp } from "./integrations/github/github.ts";
import { googleApp } from "./integrations/google/google.ts";
import { resendApp } from "./integrations/resend/resend.ts";
import { webchatApp } from "./integrations/webchat/webchat.ts";
import { machineProxyApp } from "./routes/machine-proxy.ts";
import { stripeWebhookApp } from "./integrations/stripe/webhook.ts";
import { posthogProxyApp } from "./integrations/posthog/proxy.ts";
import { egressProxyApp } from "./egress-proxy/egress-proxy.ts";
import { egressApprovalsApp } from "./routes/egress-approvals.ts";
import { workerRouter, type ORPCContext } from "./orpc/router.ts";
import { appendDevLogFile, logger, recordBufferedLog } from "./logging/index.ts";
import { sendLogExceptionToPostHog, type PostHogUserContext } from "./lib/posthog.ts";
import { registerConsumers } from "./outbox/consumers.ts";
import { queuer } from "./outbox/outbox-queuer.ts";
import * as workerConfig from "./worker-config.ts";
import { RealtimePusher } from "./durable-objects/realtime-pusher.ts";
import { ApprovalCoordinator } from "./durable-objects/approval-coordinator.ts";
import type { Variables } from "./types.ts";
import { getOtelConfig, initializeOtel, withExtractedTraceContext } from "./utils/otel-init.ts";
import {
  buildCanonicalProjectIngressProxyHostname,
  buildControlPlaneProjectIngressProxyLoginUrl,
  getProjectIngressRequestHostname,
  handleProjectIngressRequest,
  normalizeProjectIngressProxyRedirectPath,
  PROJECT_INGRESS_PROXY_AUTH_BRIDGE_START_PATH,
  PROJECT_INGRESS_PROXY_AUTH_EXCHANGE_PATH,
  shouldHandleProjectIngressHostname,
} from "./services/project-ingress-proxy.ts";
import { getIngressSchemeFromPublicUrl } from "./utils/project-ingress-url.ts";

export type { Variables };

const HOST_MATCHER_OPTIONS = {
  nocase: true,
  dot: true,
  noext: false,
  noglobstar: false,
} as const;

function isAllowedDomain(domain: string, rawAllowedDomains: string): boolean {
  const allowedDomains = rawAllowedDomains
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return allowedDomains.some(
    (allowedDomain) =>
      domain === allowedDomain || minimatch(domain, allowedDomain, HOST_MATCHER_OPTIONS),
  );
}

// Register outbox consumers at module load time
registerConsumers();

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

const getLogKeepExpression = () => {
  if (process.env.EVLOG_KEEP) {
    throw new Error("EVLOG_KEEP is no longer supported. Use LOG_KEEP instead.");
  }
  const expr =
    process.env.LOG_KEEP ||
    dedent`
      $contains(request.path, '/api/integrations/posthog/proxy') = false /* posthog proxy is slow but frequent */
      and (
        (request.status ?? 999) > 299
        or (meta.durationMs ?? 999) >= 500
        or $count(errors) > 0
        or $contains(request.url, 'logmepls')
      )
    `;
  return jsonata(expr);
};
const logKeepExpression = getLogKeepExpression();

logger.globalExitHandlers = [];
logger.globalExitHandlers.push(recordBufferedLog);
logger.globalExitHandlers.push(async (log, helpers) => {
  const keep = Boolean(logKeepExpression.evaluate(log));
  if (import.meta.env.DEV) {
    if (keep) process.stdout.write(helpers.formatPrettyLogEvent(log) + "\n");
    await appendDevLogFile(log);
    return;
  }

  if (keep) process.stdout.write(helpers.formatJsonLogEvent(log) + "\n");
});

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
app.use(contextStorage());

function getPostHogUserContext(
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
): PostHogUserContext {
  return {
    id: c.var.session?.user?.id ?? "anonymous",
    email: c.var.session?.user?.email ?? "unknown",
  };
}

const requestInfoForWideLog = (
  requestId: string,
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) => {
  const url = new URL(c.req.raw.url);
  return {
    path: c.req.path,
    status: -1,
    method: c.req.method,
    id: requestId,
    url: c.req.raw.url,
    hostname: url.hostname,
    traceparent: c.req.raw.headers.get("traceparent"),
    cfRay: c.req.raw.headers.get("cf-ray"),
    timezone: c.req.raw.cf?.timezone,
  };
};
export type RequestInfoForWideLog = ReturnType<typeof requestInfoForWideLog>;

app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray")?.trim() || crypto.randomUUID();

  return logger.run(async ({ store }) => {
    logger.set({
      service: "os",
      environment: appStage,
      request: requestInfoForWideLog(requestId, c),
      user: { id: "anonymous", email: "unknown" },
    });
    if (import.meta.env.DEV) {
      const posthogEgressOverride = c.req.header("x-replace-posthog-egress");
      if (posthogEgressOverride) {
        logger.set({ egress: { ["https://eu.i.posthog.com"]: posthogEgressOverride } });
      }
    }
    store.exitHandlers.push((log) => {
      if (!log.errors?.length) return;
      c.executionCtx.waitUntil(sendLogExceptionToPostHog({ log, env: c.env }));
    });

    try {
      const result = await next();
      logger.set({ request: { status: c.res.status } });
      return result;
    } finally {
      logger.set({ user: getPostHogUserContext(c) });
    }
  });
});

app.use("*", async (c, next) => {
  initializeOtel(c.env as Record<string, unknown>);
  return withExtractedTraceContext(c.req.raw.headers, next);
});

app.get("/api/observability", (c) => {
  return c.json({
    otel: getOtelConfig(c.env as Record<string, unknown>),
    traceViewer: {
      name: "jaeger",
      port: 16686,
      path: "/",
      note: "Viewer runs inside the sandbox",
    },
  });
});

app.post("/api/debug/trigger-error", (c) => {
  const serviceAuthToken = c.env.SERVICE_AUTH_TOKEN?.trim();

  if (!serviceAuthToken) {
    return c.json({ error: "Not found" }, 404);
  }

  const authorization = c.req.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  const providedToken = bearerToken ?? c.req.header("x-iterate-debug-token")?.trim();

  if (!providedToken || providedToken !== serviceAuthToken) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rawReason = c.req.query("reason") ?? "manual-test";
  const reason = rawReason.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "manual-test";
  throw new Error(`Intentional debug error for telemetry testing (${reason})`);
});

app.use(
  cors({
    origin: (origin, c: Context<{ Bindings: CloudflareEnv }>) => {
      if (import.meta.env.DEV) return origin;
      if (!origin || !URL.canParse(origin)) return null;
      const domain = new URL(origin).hostname;
      return isAllowedDomain(domain, c.env.ALLOWED_DOMAINS) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
  secureHeaders(),
);

app.use("*", async (c, next) => {
  const db = await getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  const orpcCaller = createRouterClient(appRouter, {
    context: createContext(c),
  });
  c.set("orpcCaller", orpcCaller);
  return next();
});

app.get("/api/testing/db-connection-probe", async (c) => {
  if (!isNonProd) {
    return c.json({ error: "Not found" }, 404);
  }

  const rawHoldMs = Number(c.req.query("holdMs") ?? "0");
  const holdMs = Number.isFinite(rawHoldMs) ? Math.min(Math.max(rawHoldMs, 0), 5_000) : 0;

  if (holdMs > 0) {
    await c.var.db.execute(sql`select pg_sleep(${holdMs / 1000})`);
  }

  await c.var.db.execute(sql`select 1`);

  return c.json({ ok: true, holdMs });
});

app.get("/api/trpc-cli-procedures", (c) => {
  return c.json({
    procedures: parseRouter({ router: appRouter }),
  });
});

app.use("*", async (c, next) => {
  const requestDomain = getProjectIngressRequestHostname(c.req.raw);
  const ingressCheck = await shouldHandleProjectIngressHostname(requestDomain, c.env);
  if (ingressCheck) {
    // If ingressCheck is a project object (custom domain), pass it to avoid a duplicate DB query
    const cachedProject = typeof ingressCheck === "object" ? ingressCheck : undefined;
    const ingressResponse = await handleProjectIngressRequest(
      c.req.raw,
      c.env,
      c.var.session,
      cachedProject,
    );
    if (ingressResponse) return ingressResponse;
  }
  return next();
});

app.get(PROJECT_INGRESS_PROXY_AUTH_BRIDGE_START_PATH, async (c) => {
  const requestedProjectIngressProxyHost = c.req.query("projectIngressProxyHost");
  const requestedProjectIngressProxySubdomain = c.req.query("subdomain");
  const requestedProjectIngressProxyPath = c.req.query("path") ?? c.req.query("redirectPath");
  const projectIngressDomain = c.env.PROJECT_INGRESS_DOMAIN;

  let normalizedHost = requestedProjectIngressProxyHost?.trim().toLowerCase();

  // Legacy: support ?subdomain= param (standard ingress only)
  if (!normalizedHost && requestedProjectIngressProxySubdomain) {
    const normalizedSubdomain = requestedProjectIngressProxySubdomain.trim().toLowerCase();
    if (!normalizedSubdomain || normalizedSubdomain.includes(".")) {
      return c.json({ error: "Invalid subdomain" }, 400);
    }
    normalizedHost = `${normalizedSubdomain}.${projectIngressDomain}`;
  }

  if (!normalizedHost) {
    return c.json({ error: "Missing projectIngressProxyHost or subdomain" }, 400);
  }

  // Determine if this is a standard ingress host or a custom domain
  const isStandardIngress = isProjectIngressHostname(normalizedHost, projectIngressDomain);
  let canonicalHost: string;

  if (isStandardIngress) {
    const parsedIngressHost = parseProjectIngressHostname(normalizedHost);
    if (!parsedIngressHost.ok) {
      return c.json({ error: "Invalid projectIngressProxyHost" }, 400);
    }
    canonicalHost = buildCanonicalProjectIngressProxyHostname({
      target: parsedIngressHost.target,
      projectIngressDomain,
    });
  } else {
    // Custom domain — validate it exists by checking shouldHandleProjectIngressHostname
    if (!(await shouldHandleProjectIngressHostname(normalizedHost, c.env))) {
      return c.json({ error: "Invalid projectIngressProxyHost" }, 400);
    }
    canonicalHost = normalizedHost;
  }

  const redirectPath = normalizeProjectIngressProxyRedirectPath(requestedProjectIngressProxyPath);

  if (!c.var.session) {
    const controlPlaneLoginUrl = buildControlPlaneProjectIngressProxyLoginUrl({
      controlPlanePublicUrl: c.env.VITE_PUBLIC_URL,
      projectIngressProxyHost: canonicalHost,
      redirectPath,
    });
    return c.redirect(controlPlaneLoginUrl.toString(), 302);
  }

  const oneTimeToken = await c.var.auth.api.generateOneTimeToken({
    headers: c.req.raw.headers,
  });
  const projectIngressProxyScheme = getIngressSchemeFromPublicUrl(c.env.VITE_PUBLIC_URL);
  const exchangeUrl = new URL(
    `${projectIngressProxyScheme}://${canonicalHost}${PROJECT_INGRESS_PROXY_AUTH_EXCHANGE_PATH}`,
  );
  exchangeUrl.searchParams.set("token", oneTimeToken.token);
  exchangeUrl.searchParams.set("redirectPath", redirectPath);
  return c.redirect(exchangeUrl.toString(), 302);
});

app.get(PROJECT_INGRESS_PROXY_AUTH_EXCHANGE_PATH, async (c) => {
  const requestHost = getProjectIngressRequestHostname(c.req.raw);
  const projectIngressDomain = c.env.PROJECT_INGRESS_DOMAIN;
  const isStandardIngress = isProjectIngressHostname(requestHost, projectIngressDomain);

  if (isStandardIngress) {
    // Standard ingress: validate and canonicalize
    const parsedIngressHost = parseProjectIngressHostname(requestHost);
    if (!parsedIngressHost.ok) {
      return c.json({ error: "Invalid ingress host" }, 400);
    }

    const canonicalProjectIngressProxyHost = buildCanonicalProjectIngressProxyHostname({
      target: parsedIngressHost.target,
      projectIngressDomain,
    });
    if (requestHost !== canonicalProjectIngressProxyHost) {
      return c.json({ error: "Non-canonical ingress host" }, 400);
    }
  } else {
    // Custom domain: validate it's a known custom domain
    if (!(await shouldHandleProjectIngressHostname(requestHost, c.env))) {
      return c.json({ error: "Invalid ingress host" }, 400);
    }
  }

  const exchangePath = new URL(
    "/api/auth/project-ingress-proxy/one-time-token/exchange",
    c.req.url,
  );
  const token = c.req.query("token");
  if (token) exchangePath.searchParams.set("token", token);
  const redirectPath = c.req.query("redirectPath");
  if (redirectPath) exchangePath.searchParams.set("redirectPath", redirectPath);

  return c.var.auth.handler(
    new Request(exchangePath.toString(), {
      method: "GET",
      headers: c.req.raw.headers,
    }),
  );
});

app.onError((_err, c) => {
  return c.json({ error: "Internal Server Error" }, 500);
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// oRPC endpoint for client-facing API (app router)
const appOrpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error, params) => {
      const maybeStatus =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : undefined;
      const errorDetails =
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack ?? "stack unavailable",
            }
          : {
              name: "NonErrorThrowable",
              message: String(error),
              stack: new Error(String(error)).stack ?? "stack unavailable",
            };
      const message = `oRPC Error ${maybeStatus ?? "unknown"} ${params.request.url}: ${String(
        (error as { message?: unknown })?.message ?? error,
      )}`;
      if (!maybeStatus || maybeStatus >= 500) {
        logger.error(message, errorDetails);
      } else {
        logger.set({
          request: {
            status: maybeStatus,
          },
        });
        logger.warn(message);
      }
    }),
  ],
});
app.all("/api/orpc/*", async (c, next) => {
  // Skip if this is the daemon-facing endpoint (handled below)
  if (c.req.path.startsWith("/api/orpc-daemon/")) return next();

  const { matched, response } = await appOrpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: createContext(c),
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  return next();
});

// Mount integration apps
app.route("/api/integrations/slack", slackApp);
app.route("/api/integrations/github", githubApp);
app.route("/api/integrations/google", googleApp);
app.route("/api/integrations/resend", resendApp);
app.route("/api/integrations/webchat", webchatApp);
app.route("/api/integrations/stripe/webhook", stripeWebhookApp);
app.route("", posthogProxyApp); // PostHog reverse proxy (for ad-blocker bypass)
app.route("/api", egressApprovalsApp);

// Mount egress proxy (for sandbox outbound traffic)
app.route("", egressProxyApp);

// oRPC handler for daemon→worker communication (API key auth, separate context)
const daemonOrpcHandler = new RPCHandler(workerRouter, {
  interceptors: [
    onError((error, params) => {
      const maybeStatus =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : undefined;
      const errorDetails =
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack ?? "stack unavailable",
            }
          : {
              name: "NonErrorThrowable",
              message: String(error),
              stack: new Error(String(error)).stack ?? "stack unavailable",
            };
      const message = `oRPC Error ${maybeStatus ?? "unknown"} ${params.request.url}: ${String(
        (error as { message?: unknown })?.message ?? error,
      )}`;
      if (!maybeStatus || maybeStatus >= 500) {
        logger.error(message, errorDetails, error);
      } else {
        logger.set({
          status: maybeStatus,
          url: params.request.url,
        });
        logger.warn(message);
      }
    }),
  ],
  plugins: [new RequestHeadersPlugin()],
});
app.all("/api/orpc-daemon/*", async (c) => {
  const { matched, response } = await daemonOrpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc-daemon",
    context: {
      db: c.var.db,
      env: c.env,
      executionCtx: c.executionCtx as ExecutionContext,
    } satisfies ORPCContext,
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  return c.json({ error: "Not found" }, 404);
});

// WebSocket endpoint for realtime push (query invalidation)
app.get("/api/ws/realtime", (c) => {
  const id = c.env.REALTIME_PUSHER.idFromName("global");
  const stub = c.env.REALTIME_PUSHER.get(id);
  return stub.fetch(c.req.raw);
});

// Mount machine proxy (Daytona, Docker, etc.)
app.route("", machineProxyApp);

export type RequestContext = {
  cloudflare: {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  };
  variables: Variables;
};

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}

app.all("*", (c) => {
  return tanstackStartServerEntry.fetch(c.req.raw, {
    context: {
      cloudflare: {
        env: c.env,
        ctx: c.executionCtx as ExecutionContext<unknown>,
      },
      variables: c.var,
    },
  });
});

export default class extends WorkerEntrypoint {
  declare env: CloudflareEnv;

  fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  async scheduled(controller: ScheduledController) {
    const db = await getDb();
    const cron = controller.cron as workerConfig.WorkerCronExpression;
    switch (cron) {
      case workerConfig.workerCrons.processOutboxQueue: {
        try {
          const result = await queuer.processQueue(db);
          if (result !== "0 messages processed") {
            logger.info("Scheduled outbox queue processing completed");
          }
        } catch (error) {
          logger.error("Scheduled outbox queue processing failed:", error);
        }
        break;
      }
      default: {
        cron satisfies never;
        logger.error("Unknown cron pattern:", controller);
      }
    }
  }
}

export { RealtimePusher, ApprovalCoordinator };
