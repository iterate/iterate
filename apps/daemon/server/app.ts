import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { parseRouter } from "trpc-cli";
import { RPCHandler } from "@orpc/server/fetch";
import { onError, ORPCError } from "@orpc/server";
import { propagation, context, type TextMapGetter } from "@opentelemetry/api";
import { getOtelConfig } from "./utils/otel-init.ts";
import { logEmitterStorage } from "./orpc/init.ts";
import { appRouter } from "./orpc/app-router.ts";
import { baseApp } from "./utils/hono.ts";
import { ptyRouter } from "./routers/pty.ts";
import { slackRouter } from "./routers/slack.ts";
import { emailRouter } from "./routers/email.ts";
import { agentsRouter } from "./routers/agents.ts";
import { opencodeRouter } from "./routers/opencode.ts";
import { piRouter } from "./routers/pi.ts";
import { claudeRouter } from "./routers/claude.ts";
import { codexRouter } from "./routers/codex.ts";
import { webchatRouter } from "./routers/webchat.ts";
import { filesRouter } from "./routers/files.ts";

const app = baseApp.use(
  logger(),
  cors({
    origin: (origin) => {
      if (process.env.NODE_ENV === "development") return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Type"],
    maxAge: 600,
  }),
  secureHeaders(),
);

const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    const keys: string[] = [];
    carrier.forEach((_value, key) => keys.push(key));
    return keys;
  },
};

app.use("*", async (c, next) => {
  const extracted = propagation.extract(context.active(), c.req.raw.headers, headersGetter);
  return context.with(extracted, next);
});

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/trpc-cli-procedures", (c) => {
  return c.json({
    procedures: parseRouter({ router: appRouter }),
  });
});

app.route("/api/agents", agentsRouter);
app.route("/api/opencode", opencodeRouter);
app.route("/api/pi", piRouter);
app.route("/api/claude", claudeRouter);
app.route("/api/codex", codexRouter);
app.get("/api/observability", (c) => {
  return c.json({
    otel: getOtelConfig(),
    traceViewer: {
      name: "jaeger",
      port: 16686,
      path: "/",
      note: "Open the machine proxy on port 16686 to view traces",
    },
  });
});

const orpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      const maybeStatus =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : undefined;
      const errorDetails =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack ?? "stack unavailable" }
          : { name: "NonErrorThrowable", message: String(error), stack: "unavailable" };
      const message = `oRPC Error ${maybeStatus ?? "unknown"}: ${errorDetails.message}`;
      if (!maybeStatus || maybeStatus >= 500) {
        console.error(message, errorDetails);
      } else {
        console.warn(message, errorDetails);
      }
    }),
  ],
  // The daemon is a local-only service, so expose full error details to callers.
  // clientInterceptors run around procedure execution, BEFORE oRPC wraps errors
  // into redacted INTERNAL_SERVER_ERROR. Re-throwing as a defined ORPCError here
  // means the outer handler's toORPCError() pass-through keeps our message intact.
  clientInterceptors: [
    onError((error) => {
      if (error instanceof ORPCError) {
        throw new ORPCError(error.code, {
          status: error.status,
          message: String(error.cause || error),
          cause: error.cause,
        });
      } else {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: String(error),
          cause: error,
        });
      }
    }),
  ],
});

app.all("/api/orpc/*", async (c) => {
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {},
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  return c.json({ error: "Not found" }, 404);
});

// Streaming variant: same as /api/orpc/* but wraps the response in SSE so that
// console.log calls inside execJs (or any procedure that emits to the log
// emitter) are streamed to the caller in real-time.
// Uses AsyncLocalStorage so concurrent requests each get their own emitter.
app.all("/api/orpc-stream/*", async (c) => {
  const emitter = new EventTarget();

  // Rewrite the request URL so oRPC handler sees /api/orpc/...
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/api/orpc-stream/", "/api/orpc/");
  const rewrittenReq = new Request(url.toString(), c.req.raw);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      emitter.addEventListener("log", ((e: CustomEvent) => {
        send("log", JSON.stringify(e.detail));
      }) as EventListener);

      // Run the oRPC handler inside the AsyncLocalStorage context so that
      // execJs (and any other procedure) can read the emitter via getStore().
      logEmitterStorage
        .run(emitter, async () => {
          const { response } = await orpcHandler.handle(rewrittenReq, {
            prefix: "/api/orpc",
            context: {},
          });
          return response ?? new Response("Not found", { status: 404 });
        })
        .then(async (res: Response) => {
          const body = await res.text();
          send("response", body);
          controller.close();
        })
        .catch((err: unknown) => {
          send("response", JSON.stringify({ error: String(err) }));
          controller.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

app.route("/api/pty", ptyRouter);
app.route("/api/integrations/slack", slackRouter);
app.route("/api/integrations/email", emailRouter);
app.route("/api/integrations/webchat", webchatRouter);
app.route("/api/files", filesRouter);

export default app;
