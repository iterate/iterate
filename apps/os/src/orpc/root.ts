import { ORPCError } from "@orpc/server";
import { getPublicConfig } from "@iterate-com/shared/config";
import { parseRouter, type AnyRouter } from "trpc-cli";
import packageJson from "../../package.json" with { type: "json" };
import { AppConfig } from "~/config.ts";
import { authenticatedUserMiddleware, os } from "~/orpc/orpc.ts";
import { projectsRouter } from "~/orpc/routers/projects.ts";
import { testRouter } from "~/orpc/routers/test.ts";

/**
 * The `__internal.*` subtree (served at `/api/__internal/*`) is the operator
 * namespace the `iterate` CLI relies on: `pnpm cli rpc` discovers procedures
 * through `trpcCliProcedures`, and deploy tooling probes `health`.
 */
const internalRouter = os.__internal.router({
  health: os.__internal.health.handler(() => ({
    ok: true as const,
    app: "os",
    version: packageJson.version,
  })),
  // Strips `redacted(...)` fields and exposes only `publicValue(...)` ones —
  // this is what the browser boots from in routes/__root.tsx.
  publicConfig: os.__internal.publicConfig.handler(({ context }) =>
    getPublicConfig(context.config, AppConfig),
  ),
  // This whole subtree is UNAUTHENTICATED. Never return secrets here. The
  // previous shared implementation dumped `process.env` (which under
  // nodejs_compat contains the raw APP_CONFIG secret blob) on this public
  // route — keep it to a static runtime marker.
  debug: os.__internal.debug.handler(() => ({ runtime: "workerd" })),
  trpcCliProcedures: os.__internal.trpcCliProcedures.handler(() => ({
    procedures: listCliProcedures(),
  })),
  refreshRegistry: os.__internal.refreshRegistry.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "__internal.refreshRegistry is not implemented for os",
    });
  }),
});

export const appRouter = os.router({
  ...testRouter,
  ...projectsRouter,
  __internal: internalRouter,
  ping: os.ping.use(authenticatedUserMiddleware).handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
});

// Hoisted and cast so the handler above can list the finished router without
// creating a circular type inference on `appRouter`.
function listCliProcedures(): unknown[] {
  return parseRouter({ router: appRouter as AnyRouter }).filter(
    (entry) => entry[0] !== "__internal.trpcCliProcedures",
  );
}
