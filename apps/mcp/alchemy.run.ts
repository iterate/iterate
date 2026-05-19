import { Worker } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { BaseAppConfig } from "@iterate-com/shared/apps/config";
import type { AppManifest } from "@iterate-com/shared/apps/types";
import { z } from "zod";
import packageJson from "./package.json" with { type: "json" };

const WorkerEnv = z.object({
  AUTH_ISSUER: z.string().trim().min(1).optional(),
  AUTH_JWKS_URL: z.string().trim().min(1).optional(),
  WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .min(1)
          .refine(
            (hostname) => !hostname.includes("/") && !hostname.includes("://"),
            "WORKER_ROUTES entries must be hostnames without scheme or path",
          ),
      ),
    ),
});

const manifest = {
  packageName: packageJson.name,
  version: packageJson.version,
  slug: "mcp",
  description: "Dummy MCP server for testing Iterate Auth OAuth project scopes.",
} as const satisfies AppManifest;

const ctx = await initAlchemy(manifest, BaseAppConfig, process.env);
const env = WorkerEnv.parse(process.env);
const primaryUrl = env.WORKER_ROUTES[0] ? `https://${env.WORKER_ROUTES[0]}` : undefined;

export const worker = await Worker(manifest.slug, {
  name: ctx.workerName,
  adopt: true,
  entrypoint: "./src/worker.ts",
  compatibilityDate: "2026-05-01",
  bindings: {
    ...(env.AUTH_ISSUER == null ? {} : { AUTH_ISSUER: env.AUTH_ISSUER }),
    ...(env.AUTH_JWKS_URL == null ? {} : { AUTH_JWKS_URL: env.AUTH_JWKS_URL }),
  },
  routes: env.WORKER_ROUTES.map((hostname) => ({
    pattern: `${hostname}/*`,
    adopt: true,
  })),
});

console.dir(
  {
    url: primaryUrl ?? worker.url,
    workersDevUrl: worker.url,
  },
  { depth: null },
);

await ctx.app.finalize();
