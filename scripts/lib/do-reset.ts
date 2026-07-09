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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

/** The slice of EnvContext the reset needs: the account-scoped CF API fetch. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

const PARKED_WORKER_MODULE = new URL("./parked-worker/worker.js", import.meta.url);

/** Deterministic 8-hex-char suffix so the same input always names the same tag. */
function tagHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
}

/**
 * `wrangler deploy` with captured output (echoed either way), returning
 * instead of throwing — the reset needs to inspect the failure to pick its
 * fallback (the run() helper inherits stdio, so its output can't be read).
 */
function runWranglerDeploy(input: {
  configPath: string;
  cwd: string;
  credentials: Record<string, string>;
}): { ok: boolean; output: string } {
  const command = ["exec", "wrangler", "deploy", "--config", input.configPath];
  console.log(`$ pnpm ${command.join(" ")}`);
  const result = spawnSync("pnpm", command, {
    cwd: input.cwd,
    encoding: "utf8",
    env: { ...process.env, ...input.credentials },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(output);
  return { ok: result.status === 0, output };
}

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
  const scripts =
    await input.ctx.cf<{ id: string; migration_tag?: string | null }[]>(`/workers/scripts`);
  const script = scripts.find((candidate) => candidate.id === input.workerName);
  if (!script) {
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

  // Deploy the parked worker, retiring every non-container class. LEGACY
  // migrations first: on a worker that has never deployed with `exports`
  // this keeps the one-way exports door open, so the next deploy's
  // container-class bootstrap (ensureContainerClasses) can still legacy-
  // create missing container classes container-enabled.
  //
  // The legacy park is a RAW script upload, not a wrangler deploy, because
  // the kept container classes force two metadata requirements wrangler
  // cannot satisfy together: the module must keep exporting them (the API
  // rejects an upload that drops a class whose objects still exist, error
  // 10064 — and kept classes hold live objects on any slot whose sandboxes
  // were used), and every exported container class must be NAMED in the
  // upload's `containers` metadata. An upload that exports a container
  // class without naming it there container-DISABLES its namespace, and no
  // later upload can re-enable it (verified live 2026-07-09: parking
  // preview-3/preview-5 with stub exports but no `containers` field
  // permanently broke their sandbox classes — "Containers have not been
  // enabled for this Durable Object class" from then on, through real
  // deploys that do declare containers). Wrangler only emits `containers`
  // metadata from a full containers config with a buildable image, which a
  // parked stub doesn't have; the raw form upload names the classes
  // directly, exactly like ensureContainerClasses' bootstrap upload.
  const parkedModule = readFileSync(PARKED_WORKER_MODULE, "utf8");
  const stubExports = kept
    .map((className) => `export class ${className} { constructor() {} }`)
    .join("\n");
  const parkedModuleWithKeptClasses = `${parkedModule}\n${stubExports}\n`;

  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "parked.mjs",
      compatibility_date: input.compatibilityDate,
      bindings: [],
      // The load-bearing line (see block comment above): kept container
      // classes stay container-enabled only while every upload that exports
      // them also names them here.
      containers: kept.map((className) => ({ class_name: className })),
      migrations: {
        ...(script.migration_tag ? { old_tag: script.migration_tag } : {}),
        new_tag: `do-reset-${tagHash([script.migration_tag ?? null, deletedClasses])}`,
        steps: [{ deleted_classes: deletedClasses }],
      },
    }),
  );
  form.append(
    "parked.mjs",
    new File([parkedModuleWithKeptClasses], "parked.mjs", {
      type: "application/javascript+module",
    }),
    "parked.mjs",
  );
  try {
    await input.ctx.cf(`/workers/scripts/${input.workerName}`, { method: "PUT", body: form });
  } catch (error) {
    if (!String(error).includes("100403")) throw error;
    console.log(
      `DO reset: ${input.workerName} is on the declarative exports flow (API 100403) — parking via exports tombstones instead`,
    );
    // CAUTION: this fallback cannot name the kept classes in `containers`
    // metadata (wrangler-only path, no containers config without an image),
    // so on an exports-flow worker it may strip their container-enablement
    // — the same failure mode the raw upload above exists to avoid. No
    // preview worker is on the exports flow today (they all carry legacy
    // migration tags), so this stays theoretical; if it ever fires on a
    // worker with container classes, expect to need the worker-delete
    // repair afterwards.
    const parkedDir = mkdtempSync(join(tmpdir(), "do-reset-"));
    try {
      writeFileSync(join(parkedDir, "worker.js"), parkedModuleWithKeptClasses);
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
      const viaExports = runWranglerDeploy({
        configPath: join(parkedDir, "wrangler.json"),
        cwd: input.cwd,
        credentials: input.credentials,
      });
      if (!viaExports.ok) {
        throw new Error(
          `DO reset: parked deploy failed for ${input.workerName} (see output above).`,
        );
      }
    } finally {
      rmSync(parkedDir, { recursive: true, force: true });
    }
  }
  console.log(
    `DO reset: ${input.workerName} destroyed ${deletedClasses.length} classes ` +
      `(${deletedClasses.join(", ")})` +
      (kept.length > 0 ? `; kept container classes ${kept.join(", ")}` : "") +
      `; parked at 503 until the next deploy`,
  );
  return { action: "reset", deletedClasses, keptContainerClasses: kept };
}

/**
 * Make sure a worker's container-bearing DO classes exist CONTAINER-ENABLED
 * before its first `exports` deploy — the workaround that keeps
 * new-environment creation possible.
 *
 * Why this exists (upstream Cloudflare gap, verified live 2026-07-08, not
 * fixed as of wrangler 4.108): the exports reconciliation creates classes
 * WITHOUT container-enablement and there is no API to enable an existing
 * namespace, so a container class created under `exports` fails its
 * container application with DURABLE_OBJECT_NOT_CONTAINER_ENABLED forever
 * (exports is one-way, API 100403 — no going back to migrations). The ONLY
 * thing that container-enables a namespace is a legacy-migrations script
 * upload whose metadata `containers` list names the class at creation time.
 * So: while the worker is fresh or still on migrations, upload the parked
 * module with a legacy migration creating exactly the missing container
 * classes, flagged as containers. The real deploy then declares them as
 * live `exports` entries and attaches the container applications — both
 * proven to work over migrations-created classes.
 *
 * No-op when every container class already exists. Throws with the repair
 * recipe when classes are missing on a worker that is already
 * exports-locked (only reachable by bypassing this bootstrap; the repair is
 * queue-consumer remove → `wrangler delete` → redeploy). Delete this whole
 * function when Cloudflare fixes exports reconciliation for containers.
 */
export async function ensureContainerClasses(input: {
  ctx: CfContext;
  workerName: string;
  /** The container-bearing DO class names the app's config declares. */
  containerClassNames: string[];
  compatibilityDate: string;
}): Promise<{ action: "skipped" | "bootstrapped"; missing: string[] }> {
  if (input.containerClassNames.length === 0) return { action: "skipped", missing: [] };

  const scripts =
    await input.ctx.cf<{ id: string; migration_tag?: string | null }[]>(`/workers/scripts`);
  const script = scripts.find((candidate) => candidate.id === input.workerName);
  const live = script ? await getWorkerDoNamespaces(input.ctx, input.workerName) : [];
  const liveNames = new Set(live.map((namespace) => namespace.className));
  const missing = input.containerClassNames.filter((className) => !liveNames.has(className)).sort();

  // A worker recreated after `wrangler delete` leaves container applications
  // pinned to its DELETED namespaces (wrangler never deletes applications),
  // and an application name collision with a dead namespace fails the
  // containers phase of the coming deploy. Sweep dangling applications
  // unconditionally: an application whose namespace no longer exists in the
  // account is garbage by definition.
  const allNamespaceIds = new Set<string>();
  for (let page = 1; ; page++) {
    const batch = await input.ctx.cf<{ id: string }[]>(
      `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    for (const namespace of batch) allNamespaceIds.add(namespace.id);
    if (batch.length < 100) break;
  }
  const applications =
    await input.ctx.cf<{ id: string; name: string; durable_objects?: { namespace_id?: string } }[]>(
      `/containers/applications`,
    );
  for (const application of applications) {
    const namespaceId = application.durable_objects?.namespace_id;
    if (namespaceId && !allNamespaceIds.has(namespaceId)) {
      await input.ctx.cf(`/containers/applications/${application.id}`, { method: "DELETE" });
      console.log(
        `container-class bootstrap: deleted dangling container application ${application.name} ` +
          `(its namespace ${namespaceId} no longer exists)`,
      );
    }
  }

  if (missing.length === 0) return { action: "skipped", missing: [] };

  console.log(
    `container-class bootstrap: ${input.workerName} is missing ${missing.join(", ")} — ` +
      `legacy-creating them container-enabled before the exports deploy`,
  );
  // The upload replaces the whole worker script, so it must keep exporting
  // every class existing Durable Objects depend on — the API rejects a
  // script that drops one (error 10064). Stub the live classes alongside
  // the missing ones (a live worker gaining new container classes is the
  // normal case, e.g. a preview slot first deploying a branch that adds
  // one); the next real deploy restores the real implementations.
  const stubExports = [...missing, ...live.map((namespace) => namespace.className)]
    .sort()
    .map((className) => `export class ${className} { constructor() {} }`)
    .join("\n");
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "bootstrap.mjs",
      compatibility_date: input.compatibilityDate,
      bindings: [],
      // The load-bearing line: naming the classes here at creation time is
      // what container-enables their namespaces.
      containers: missing.map((className) => ({ class_name: className })),
      migrations: {
        ...(script?.migration_tag ? { old_tag: script.migration_tag } : {}),
        new_tag: `container-bootstrap-${tagHash([script?.migration_tag ?? null, missing])}`,
        steps: [{ new_sqlite_classes: missing }],
      },
    }),
  );
  form.append(
    "bootstrap.mjs",
    new File([`${readFileSync(PARKED_WORKER_MODULE, "utf8")}\n${stubExports}\n`], "bootstrap.mjs", {
      type: "application/javascript+module",
    }),
    "bootstrap.mjs",
  );
  try {
    await input.ctx.cf(`/workers/scripts/${input.workerName}`, { method: "PUT", body: form });
  } catch (error) {
    if (String(error).includes("100403")) {
      throw new Error(
        `container-class bootstrap: ${input.workerName} is already on the exports flow but is ` +
          `missing container classes (${missing.join(", ")}) — its namespaces can never be ` +
          `container-enabled (upstream Cloudflare gap). Repair: remove the worker's queue ` +
          `consumer, \`wrangler delete\` it, and redeploy — the bootstrap then recreates ` +
          `everything enabled.`,
      );
    }
    throw error;
  }
  console.log(
    `container-class bootstrap: created ${missing.join(", ")} on ${input.workerName} (container-enabled)`,
  );
  return { action: "bootstrapped", missing };
}
