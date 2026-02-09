import { Hono, type Context } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import type { CloudflareEnv } from "../env.ts";
import { getDb } from "./db/client.ts";
import { getAuth } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
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
import { logger } from "./tag-logger.ts";
import { captureServerException } from "./lib/posthog.ts";
import { RealtimePusher } from "./durable-objects/realtime-pusher.ts";
import { ApprovalCoordinator } from "./durable-objects/approval-coordinator.ts";
import type { Variables } from "./types.ts";
import { getOtelConfig, initializeOtel, withExtractedTraceContext } from "./utils/otel-init.ts";

export type { Variables };

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
app.use(contextStorage());

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

app.use(
  cors({
    origin: (origin, c: Context<{ Bindings: CloudflareEnv }>) => {
      if (import.meta.env.DEV) return origin;
      if (!origin || !URL.canParse(origin)) return null;
      const domain = new URL(origin).hostname;
      return c.env.ALLOWED_DOMAINS.split(",").includes(domain) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
  secureHeaders(),
);

app.use("*", async (c, next) => {
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  const trpcCaller = appRouter.createCaller(createContext(c));
  c.set("trpcCaller", trpcCaller);
  return next();
});

app.onError((err, c) => {
  logger.error(`${err instanceof Error ? err.message : String(err)} (hono unhandled error)`, err);

  // Capture exception to PostHog with user context
  const error = err instanceof Error ? err : new Error(String(err));
  const distinctId = c.var.session?.user?.id ?? "anonymous";
  c.executionCtx?.waitUntil(
    captureServerException(c.env, {
      distinctId,
      error,
      properties: {
        path: c.req.path,
        method: c.req.method,
        userId: c.var.session?.user?.id,
      },
    }),
  );

  return c.json({ error: "Internal Server Error" }, 500);
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// tRPC endpoint
app.all("/api/trpc/*", (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    allowMethodOverride: true,
    createContext: () => createContext(c),
    onError: ({ error, path }) => {
      const procedurePath = path ?? "unknown";
      const status = getHTTPStatusCodeFromError(error);
      if (status >= 500) {
        logger.error(`TRPC Error ${status} in ${procedurePath}: ${error.message}`, error);

        // Capture 5xx errors to PostHog
        const distinctId = c.var.session?.user?.id ?? "anonymous";
        c.executionCtx?.waitUntil(
          captureServerException(c.env, {
            distinctId,
            error,
            properties: {
              path: procedurePath,
              trpcProcedure: procedurePath,
              userId: c.var.session?.user?.id,
            },
          }),
        );
      } else {
        logger.warn(`TRPC Error ${status} in ${procedurePath}:\n${error.stack}`);
      }
    },
  });
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

// oRPC handler for machine status (called by daemon to report ready)
const orpcHandler = new RPCHandler(workerRouter, {
  plugins: [new RequestHeadersPlugin()],
});
app.all("/api/orpc/*", async (c) => {
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
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

// Mount machine proxy (Daytona, local-docker, etc.)
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
    const url = new URL(request.url);
    const requestDomain = url.hostname;

    // on root domain, redirect to the first allowed domain, which will be the os domain
    if (requestDomain === this.env.PROXY_ROOT_DOMAIN)
      return Response.redirect(`https://${this.env.ALLOWED_DOMAINS.split(",")[0]}${url.pathname}`);

    // Check if the request is for the proxy worker
    const [_, ...rest] = requestDomain.split(".");
    if (rest.join(".") === this.env.PROXY_ROOT_DOMAIN) return this.env.PROXY_WORKER.fetch(request);

    // Otherwise, handle the request as normal
    return app.fetch(request, this.env, this.ctx);
  }
}

export { RealtimePusher, ApprovalCoordinator };
