/**
 * Destroy-all for a worker's Durable Objects: the teardown half of
 * erase-data, run on every preview-slot handover.
 *
 * The only way to delete DO instances (storage, alarms and all) is a deploy
 * that retires their classes, so the reset deploys the checked-in parked
 * worker (parked-worker/worker.js — 503 + queue ack) with a `state:
 * "deleted"` tombstone for every class that exists on the worker — except
 * container-bearing classes, which are kept alive (see the inline comment
 * for the upstream Cloudflare gap that forces this). Plain `wrangler
 * deploy`; the tombstone map is the only generated content, and it is a
 * readback of live reality — no checked-in file can know what a previous
 * branch left on a shared slot.
 *
 * The worker script and its routes stay (deleting a script cascades its
 * routes — the historical zombie-route/522 class); the worker serves the
 * parked 503 until the next real deploy, which recreates every class its
 * config declares in `exports` (fresh, empty) in the same upload as code and
 * secrets.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./deploy-helpers.ts";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

/** The slice of EnvContext the reset needs: the account-scoped CF API fetch. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

const PARKED_WORKER_MODULE = new URL("./parked-worker/worker.js", import.meta.url);

/** The Durable Object namespaces (class + namespace id) live on one worker script. */
export async function getWorkerDoNamespaces(
  ctx: CfContext,
  workerName: string,
): Promise<{ className: string; namespaceId: string }[]> {
  const namespaces: { className: string; namespaceId: string }[] = [];
  for (let page = 1; ; page++) {
    const batch = await ctx.cf<{ id: string; script: string | null; class: string }[]>(
      `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    for (const namespace of batch) {
      if (namespace.script === workerName) {
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
 * deploy/erase script's own app); `credentials` are the CLOUDFLARE_API_TOKEN
 * / CLOUDFLARE_ACCOUNT_ID env for the wrangler process.
 */
export async function resetWorkerDurableObjects(input: {
  ctx: CfContext;
  workerName: string;
  cwd: string;
  credentials: Record<string, string>;
  /** The worker's compatibility date — reuse the app's own so the parked module never trails it. */
  compatibilityDate: string;
}): Promise<
  | { action: "skipped"; reason: string }
  | { action: "reset"; deletedClasses: string[]; keptContainerClasses: string[] }
> {
  const scripts = await input.ctx.cf<{ id: string }[]>(`/workers/scripts`);
  if (!scripts.some((script) => script.id === input.workerName)) {
    console.log(`DO reset: worker ${input.workerName} does not exist — nothing to destroy`);
    return { action: "skipped", reason: "script does not exist" };
  }
  const namespaces = await getWorkerDoNamespaces(input.ctx, input.workerName);
  if (namespaces.length === 0) {
    console.log(`DO reset: worker ${input.workerName} has no Durable Object classes — clean`);
    return { action: "skipped", reason: "no Durable Object classes" };
  }

  // Container-bearing classes are KEPT, not destroyed. Cloudflare's exports
  // reconciliation cannot container-enable a namespace it creates (upstream
  // gap, verified live 2026-07-08: recreating a container class under
  // `exports` fails its container application with
  // DURABLE_OBJECT_NOT_CONTAINER_ENABLED, and exports is one-way — error
  // 100403 forbids ever going back to `migrations`), so a tombstoned
  // container class could never come back. Kept instances become
  // unreachable orphans like every pre-teardown DO did (D1/KV are wiped;
  // running containers are reaped by the sandbox destroy-on-idle sweeper),
  // and their container applications stay attached to the live namespaces.
  const applications =
    await input.ctx.cf<{ id: string; name: string; durable_objects?: { namespace_id?: string } }[]>(
      `/containers/applications`,
    );
  const containerNamespaceIds = new Set(
    applications
      .map((application) => application.durable_objects?.namespace_id)
      .filter((id): id is string => Boolean(id)),
  );
  const kept = namespaces
    .filter((namespace) => containerNamespaceIds.has(namespace.namespaceId))
    .map((namespace) => namespace.className)
    .sort();
  const deletedClasses = namespaces
    .filter((namespace) => !containerNamespaceIds.has(namespace.namespaceId))
    .map((namespace) => namespace.className)
    .sort();
  if (deletedClasses.length === 0) {
    console.log(
      `DO reset: worker ${input.workerName} has only container-bearing classes (${kept.join(", ")}) — kept`,
    );
    return { action: "skipped", reason: "only container-bearing classes" };
  }

  // Deploy the parked worker: a `deleted` tombstone for every class being
  // destroyed, plus a live entry for every kept container class (with a stub
  // code export — a live entry must exist in code). From a temp dir so the
  // generated config never dirties the repo tree.
  const parkedDir = mkdtempSync(join(tmpdir(), "do-reset-"));
  try {
    const stubExports = kept
      .map((className) => `export class ${className} { constructor() {} }`)
      .join("\n");
    writeFileSync(
      join(parkedDir, "worker.js"),
      `${readFileSync(PARKED_WORKER_MODULE, "utf8")}\n${stubExports}\n`,
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
        exports: {
          ...Object.fromEntries(
            deletedClasses.map((className) => [
              className,
              { type: "durable-object", state: "deleted" },
            ]),
          ),
          ...Object.fromEntries(
            kept.map((className) => [className, { type: "durable-object", storage: "sqlite" }]),
          ),
        },
      }),
    );
    run("pnpm", ["exec", "wrangler", "deploy", "--config", join(parkedDir, "wrangler.json")], {
      cwd: input.cwd,
      env: input.credentials,
    });
  } finally {
    rmSync(parkedDir, { recursive: true, force: true });
  }
  console.log(
    `DO reset: ${input.workerName} destroyed ${deletedClasses.length} classes ` +
      `(${deletedClasses.join(", ")})` +
      (kept.length > 0 ? `; kept container classes ${kept.join(", ")}` : "") +
      `; parked at 503 until the next deploy`,
  );
  return { action: "reset", deletedClasses, keptContainerClasses: kept };
}
