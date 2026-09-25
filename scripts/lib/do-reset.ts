/**
 * Destroy-all for a worker's Durable Objects: the teardown half of
 * erase-data.
 *
 * The only way to delete DO instances (storage, alarms and all) is a deploy
 * that retires their classes, so the reset deploys the checked-in parked
 * worker (parked-worker/worker.js — 503 + queue ack) with a `state:
 * "deleted"` exports tombstone for every class the worker owns. Plain
 * `wrangler deploy`; the tombstone map is generated from live reality — no
 * checked-in tombstone can know what a previous deployment left on the
 * worker. A rejected deploy throws, and erase-data stops before any data.
 *
 * The worker script and its routes stay (deleting a script cascades its
 * routes — the historical zombie-route/522 class); the worker serves the
 * parked 503 until the next real deploy, which recreates every class its
 * config declares in `exports` (fresh, empty) in the same upload as code and
 * secrets.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync } from "./deploy-helpers.ts";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

/** The slice of EnvContext the reset needs: the account-scoped CF API fetch. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

/** The Durable Object namespaces (class + namespace id) live on one worker script. */
export async function getWorkerDoNamespaces(
  ctx: CfContext,
  workerName: string,
): Promise<{ className: string; namespaceId: string }[]> {
  const namespaces: { className: string; namespaceId: string }[] = [];
  for (let page = 1; ; page++) {
    const batch = await ctx.cf<
      { id: string; script: string | null; class: string; preview?: { name: string } }[]
    >(`/workers/durable_objects/namespaces?per_page=100&page=${page}`);
    for (const namespace of batch) {
      // A Worker Preview's namespaces are listed under its parent's script, marked `preview`
      // (`os_pr7_ProjectDurableObject`). They are the preview's: a tombstone on the parent leaves
      // them and their data alone, and deleting the preview deletes them (measured 2026-09-24 on a
      // throwaway worker).
      if (namespace.script === workerName && !namespace.preview) {
        namespaces.push({ className: namespace.class, namespaceId: namespace.id });
      }
    }
    if (batch.length < 100) break;
  }
  return namespaces;
}

/**
 * Destroy every Durable Object on a worker and leave it parked at 503 until
 * the next deploy. No-op when the worker doesn't exist or has no DO classes.
 *
 * `cwd` is an app root whose node_modules can resolve wrangler (the calling
 * erase script's own app); `credentials` are the CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_ACCOUNT_ID env for the wrangler process.
 */
export async function resetWorkerDurableObjects(input: {
  ctx: CfContext;
  workerName: string;
  cwd: string;
  credentials: Record<string, string>;
  /** The worker's compatibility date — reuse the app's own so the parked module never trails it. */
  compatibilityDate: string;
}) {
  const scripts = await input.ctx.cf<{ id: string }[]>(`/workers/scripts`);
  if (!scripts.some((script) => script.id === input.workerName)) {
    console.log(`DO reset: worker ${input.workerName} does not exist — nothing to destroy`);
    return;
  }
  const deletedClasses = (await getWorkerDoNamespaces(input.ctx, input.workerName))
    .map((namespace) => namespace.className)
    .sort();
  if (deletedClasses.length === 0) {
    console.log(`DO reset: worker ${input.workerName} has no Durable Object classes — clean`);
    return;
  }

  const parkedDir = mkdtempSync(join(tmpdir(), "do-reset-"));
  try {
    copyFileSync(
      new URL("./parked-worker/worker.js", import.meta.url),
      join(parkedDir, "worker.js"),
    );
    writeFileSync(
      join(parkedDir, "wrangler.json"),
      JSON.stringify({
        name: input.workerName,
        main: "worker.js",
        compatibility_date: input.compatibilityDate,
        // Existing zone routes stay untouched (wrangler only manages routes
        // listed in config); don't let a route-less config enable workers.dev.
        workers_dev: false,
        // A parent's Worker Previews keep serving while it is parked: an unset
        // `preview_urls` follows `workers_dev` and takes every preview offline
        // (404, 1042) until the next deploy (measured 2026-09-24 on a throwaway
        // worker). Our workers run with preview URLs on anyway.
        preview_urls: true,
        exports: Object.fromEntries(
          deletedClasses.map((className) => [
            className,
            { type: "durable-object", state: "deleted" },
          ]),
        ),
      }),
    );
    await runAsync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--config", join(parkedDir, "wrangler.json")],
      { cwd: input.cwd, env: input.credentials },
    );
  } finally {
    rmSync(parkedDir, { recursive: true, force: true });
  }
  console.log(
    `DO reset: ${input.workerName} destroyed ${deletedClasses.length} classes ` +
      `(${deletedClasses.join(", ")}); parked at 503 until the next deploy`,
  );
}
