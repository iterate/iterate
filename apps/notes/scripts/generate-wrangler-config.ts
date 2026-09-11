import { notesEnvs } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

export function writeWranglerConfig() {
  const bindings = {
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object", storage: "sqlite" } },
    vars: { ITERATE_ORIGIN: "https://os.iterate2.com" },
    observability: OBSERVABILITY,
    assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: true },
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/notes",
    config: {
      $schema: "node_modules/wrangler/config-schema.json",
      name: "notes",
      main: "src/worker.ts",
      compatibility_date: "2026-09-01",
      ...bindings,
      env: Object.fromEntries(
        Object.entries(notesEnvs).map(([name, env]) => [
          name,
          {
            name: env.workerName,
            account_id: env.cloudflareAccountId,
            workers_dev: true,
            ...bindings,
            // A workers.dev baseUrl is served by workers_dev itself — no custom route. A custom
            // domain (a real zone) gets a route bound to that zone.
            ...(new URL(env.baseUrl).hostname.endsWith(".workers.dev")
              ? {}
              : {
                  routes: [
                    {
                      pattern: `${new URL(env.baseUrl).hostname}/*`,
                      zone_name: new URL(env.baseUrl).hostname.split(".").slice(-2).join("."),
                    },
                  ],
                }),
          },
        ]),
      ),
    },
  });
}
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) console.log(writeWranglerConfig());
