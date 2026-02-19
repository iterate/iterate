import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { parseRouter } from "trpc-cli";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { propagation, context, type TextMapGetter } from "@opentelemetry/api";
import { getOtelConfig } from "./utils/otel-init.ts";
import { logEmitterStorage } from "./trpc/init.ts";
import { appRouter } from "./trpc/app-router.ts";
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

const trpcOnError = ({
  error,
  path,
}: {
  error: { message: string; stack?: string };
  path?: string;
}) => {
  const procedurePath = path ?? "unknown";
  const status = getHTTPStatusCodeFromError(
    error as Parameters<typeof getHTTPStatusCodeFromError>[0],
  );
  if (status >= 500) {
    console.error(`tRPC Error ${status} in ${procedurePath}: ${error.message}`);
  } else {
    console.warn(`tRPC Error ${status} in ${procedurePath}:\n${error.stack}`);
  }
};

app.all("/api/trpc/*", (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    allowMethodOverride: true,
    onError: trpcOnError,
  });
});

// Streaming variant: same as /api/trpc/* but wraps the response in SSE so that
// console.log calls inside execJs (or any procedure that emits to the log
// emitter) are streamed to the caller in real-time.
// Uses AsyncLocalStorage so concurrent requests each get their own emitter.
app.all("/api/trpc-stream/*", (c) => {
  const emitter = new EventTarget();

  // Rewrite the request URL so fetchRequestHandler sees /api/trpc/...
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/api/trpc-stream/", "/api/trpc/");
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

      // Run the tRPC handler inside the AsyncLocalStorage context so that
      // execJs (and any other procedure) can read the emitter via getStore().
      logEmitterStorage
        .run(emitter, () =>
          fetchRequestHandler({
            endpoint: "/api/trpc",
            req: rewrittenReq,
            router: appRouter,
            allowMethodOverride: true,
            onError: trpcOnError,
          }),
        )
        .then(async (res) => {
          const body = await res.text();
          send("response", body);
          controller.close();
        })
        .catch((err) => {
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
