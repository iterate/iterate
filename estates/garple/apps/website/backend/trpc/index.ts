import { domainsRouter } from "./routes/domains.ts";
import { webhooksRouter } from "./routes/webhooks.ts";
import { createRouter } from "./trpc.ts";

export const appRouter = createRouter({
  domains: domainsRouter,
  webhooks: webhooksRouter,
});

export type AppRouter = typeof appRouter;
