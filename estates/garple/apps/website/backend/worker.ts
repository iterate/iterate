import { Hono } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { CloudflareEnv } from "../env.ts";
import { appRouter } from "./trpc/index.ts";
import { handleStripeWebhook } from "./stripe-webhook.ts";
import { createContext } from "./trpc/trpc.ts";

const app = new Hono<{ Bindings: CloudflareEnv }>();

// Stripe webhook
app.post("/api/stripe/webhooks", async (c) => {
  return await handleStripeWebhook(c);
});

// tRPC endpoint
app.all("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    req: c.req.raw,
    router: appRouter,
    createContext: () => createContext(c),
    endpoint: "/api/trpc",
  });
});

export default {
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
