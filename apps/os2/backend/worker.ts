import { Hono } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { typeid } from "typeid-js";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import type { CloudflareEnv } from "../env.ts";
import { getDb, type DB } from "./db/client.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { OrganizationWebSocket } from "./durable-objects/organization-websocket.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { logger } from "./tag-logger.ts";

type TrpcCaller = ReturnType<typeof appRouter.createCaller>;
export type Variables = {
  auth: Auth;
  session: AuthSession;
  db: DB;
  trpcCaller: TrpcCaller;
};

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
app.use(contextStorage());

app.use(
  cors({
    origin: (origin, c) => {
      if (import.meta.env.DEV) return origin;
      if (!origin || !URL.canParse(origin)) return null;
      const domain = new URL(origin).hostname;
      return c.env.ALLOWED_DOMAINS.split(",").includes(domain) ? origin : null;
    },
    credentials: true,
    allowMethods: ["*"],
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

app.use("*", async (c, next) => {
  const requestTags = {
    userId: c.var.session?.user?.id || undefined,
    path: c.req.path,
    httpMethod: c.req.method,
    url: c.req.url,
    traceId: typeid("req").toString(),
  };
  return logger.run(requestTags, () => next());
});

app.onError((err, c) => {
  logger.error(`${err instanceof Error ? err.message : String(err)} (hono unhandled error)`, err);
  return c.json({ error: "Internal Server Error" }, 500);
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

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
        logger.error(
          new Error(`TRPC Error ${status} in ${procedurePath}: ${error.message}`, { cause: error }),
        );
      } else {
        logger.warn(`TRPC Error ${status} in ${procedurePath}:\n${error.stack}`);
      }
    },
  });
});

app.route("/api/integrations/slack", slackApp);

app.get("/api/ws/:organizationId", async (c) => {
  const organizationId = c.req.param("organizationId");
  const id = c.env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = c.env.ORGANIZATION_WEBSOCKET.get(id);

  const url = new URL(c.req.url);
  url.searchParams.set("organizationId", organizationId);

  return stub.fetch(
    new Request(url.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
  );
});

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
}

export { OrganizationWebSocket };
