/**
 * Destroy-all for a worker's Durable Objects: the teardown half of
 * erase-data, run on every preview-slot handover.
 *
 * The only way to delete DO instances (storage, alarms and all) is a deploy
 * that retires their classes, so the reset deploys the checked-in parked
 * worker (parked-worker/worker.js — 503 + queue ack) with a `state:
 * "deleted"` tombstone for every class that exists on the worker — except
 * container-bearing classes still declared by the incoming branch, which
 * are kept alive (see the inline comment for the upstream Cloudflare gap
 * that forces this). Retired container applications are deleted first so
 * their classes can be tombstoned too. Plain `wrangler deploy`; the tombstone
 * map is generated from live reality plus the incoming branch's current
 * container classes — no checked-in tombstone can know what a previous
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

type WorkerBinding = Record<string, unknown> & {
  name?: unknown;
  namespace_id?: unknown;
  script_name?: unknown;
  type?: unknown;
};

type WorkerSettings = {
  annotations?: Record<string, unknown>;
  bindings?: WorkerBinding[];
};

const SETTINGS_SCAN_CONCURRENCY = 10;
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

function isBindingToWorker(
  binding: WorkerBinding,
  workerName: string,
  namespaceIds: ReadonlySet<string>,
) {
  return (
    binding.type === "durable_object_namespace" &&
    (binding.script_name === workerName ||
      (typeof binding.namespace_id === "string" && namespaceIds.has(binding.namespace_id)))
  );
}

function writableAnnotations(annotations: WorkerSettings["annotations"]) {
  return Object.fromEntries(
    ["workers/message", "workers/tag"].flatMap((key) =>
      typeof annotations?.[key] === "string" ? [[key, annotations[key]]] : [],
    ),
  );
}

function bindingNames(bindings: readonly WorkerBinding[], workerName: string) {
  const names = bindings.map((binding) => binding.name);
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error(
      `DO reset: ${workerName} has a binding without a usable name; refusing to rewrite its settings`,
    );
  }
  return names as string[];
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  visit: (item: T) => Promise<void>,
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await visit(item);
    }),
  );
}

/**
 * Remove bindings in other Workers that keep this Worker's Durable Object
 * namespaces alive. Workers themselves and every unrelated binding remain:
 * the settings API's `inherit` binding copies each survivor from the latest
 * version, including redacted secrets that cannot safely be reconstructed
 * from a settings GET.
 *
 * Readback is part of the operation, not a diagnostic. A tombstone deploy
 * must never start while Cloudflare still reports a reference to a namespace
 * it is about to retire.
 */
export async function detachExternalDurableObjectBindings(input: {
  ctx: CfContext;
  targetWorkerName: string;
  targetNamespaceIds: readonly string[];
  workerNames: readonly string[];
}): Promise<{ workerName: string; removedBindingNames: string[] }[]> {
  const namespaceIds = new Set(input.targetNamespaceIds);
  const detached: { workerName: string; removedBindingNames: string[] }[] = [];
  const candidates = input.workerNames.filter(
    (workerName) => workerName !== input.targetWorkerName,
  );

  await forEachWithConcurrency(candidates, SETTINGS_SCAN_CONCURRENCY, async (workerName) => {
    const path = `/workers/scripts/${encodeURIComponent(workerName)}/settings`;
    const before = await input.ctx.cf<WorkerSettings>(path);
    const bindings = before.bindings ?? [];
    const removed = bindings.filter((binding) =>
      isBindingToWorker(binding, input.targetWorkerName, namespaceIds),
    );
    if (removed.length === 0) return;

    const remaining = bindings.filter(
      (binding) => !isBindingToWorker(binding, input.targetWorkerName, namespaceIds),
    );
    const remainingNames = bindingNames(remaining, workerName);
    const removedBindingNames = bindingNames(removed, workerName).sort();
    const annotations = writableAnnotations(before.annotations);
    const settings = {
      annotations,
      bindings: remainingNames.map((name) => ({ name, type: "inherit" })),
    };
    const form = new FormData();
    form.append(
      "settings",
      new Blob([JSON.stringify(settings)], { type: "application/json" }),
      "settings.json",
    );
    await input.ctx.cf(path, { method: "PATCH", body: form });

    const after = await input.ctx.cf<WorkerSettings>(path);
    const afterBindings = after.bindings ?? [];
    const afterNames = bindingNames(afterBindings, workerName).sort();
    const expectedNames = [...remainingNames].sort();
    if (
      afterBindings.some((binding) =>
        isBindingToWorker(binding, input.targetWorkerName, namespaceIds),
      ) ||
      JSON.stringify(afterNames) !== JSON.stringify(expectedNames) ||
      JSON.stringify(writableAnnotations(after.annotations)) !== JSON.stringify(annotations)
    ) {
      throw new Error(
        `DO reset: ${workerName} settings readback did not preserve the expected bindings and annotations`,
      );
    }
    detached.push({ workerName, removedBindingNames });
    console.log(
      `DO reset: detached ${workerName} bindings ${removedBindingNames.join(", ")} from ${input.targetWorkerName}`,
    );
  });

  return detached.sort((a, b) => a.workerName.localeCompare(b.workerName));
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
  /** Container-bearing classes declared by the branch that will deploy next. */
  containerClassNames: readonly string[];
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
  await detachExternalDurableObjectBindings({
    ctx: input.ctx,
    targetWorkerName: input.workerName,
    targetNamespaceIds: namespaces.map((namespace) => namespace.namespaceId),
    workerNames: scripts.map((candidate) => candidate.id),
  });
  if (namespaces.length === 0) {
    console.log(`DO reset: worker ${input.workerName} has no Durable Object classes — clean`);
    return { action: "skipped", reason: "no Durable Object classes" };
  }

  // CURRENT container-bearing classes are KEPT, not destroyed. Cloudflare's
  // exports reconciliation cannot container-enable a namespace it creates (upstream
  // gap, verified live 2026-07-08: recreating a container class under
  // `exports` fails its container application with
  // DURABLE_OBJECT_NOT_CONTAINER_ENABLED, and exports is one-way — error
  // 100403 forbids ever going back to `migrations`), so a tombstoned
  // container class could never come back. Kept instances become
  // unreachable orphans like every pre-teardown DO did (D1/KV are wiped;
  // running containers are reaped by the sandbox destroy-on-idle sweeper),
  // and their container applications stay attached to the live namespaces.
  let applications =
    await input.ctx.cf<{ id: string; name: string; durable_objects?: { namespace_id?: string } }[]>(
      `/containers/applications`,
    );
  const namespaceById = new Map<string, (typeof namespaces)[number]>();
  for (const namespace of namespaces) namespaceById.set(namespace.namespaceId, namespace);
  const currentContainerClasses = new Set(input.containerClassNames);
  const retiredApplications = applications.filter((application) => {
    const namespaceId = application.durable_objects?.namespace_id;
    const namespace = namespaceId ? namespaceById.get(namespaceId) : undefined;
    return namespace !== undefined && !currentContainerClasses.has(namespace.className);
  });
  for (const application of retiredApplications) {
    const namespaceId = application.durable_objects?.namespace_id;
    const namespace = namespaceId ? namespaceById.get(namespaceId) : undefined;
    await input.ctx.cf(`/containers/applications/${encodeURIComponent(application.id)}`, {
      method: "DELETE",
    });
    console.log(
      `DO reset: deleted retired container application ${application.name} ` +
        `(class ${namespace?.className ?? "unknown"})`,
    );
  }
  if (retiredApplications.length > 0) {
    applications =
      await input.ctx.cf<
        { id: string; name: string; durable_objects?: { namespace_id?: string } }[]
      >(`/containers/applications`);
    const retiredNamespaceIds = new Set(
      retiredApplications.flatMap((application) => {
        const namespaceId = application.durable_objects?.namespace_id;
        return namespaceId ? [namespaceId] : [];
      }),
    );
    const lingering = applications.filter((application) => {
      const namespaceId = application.durable_objects?.namespace_id;
      return namespaceId !== undefined && retiredNamespaceIds.has(namespaceId);
    });
    if (lingering.length > 0) {
      throw new Error(
        `DO reset: Cloudflare kept retired container applications ` +
          `${lingering.map((application) => application.name).join(", ")}; refusing to park ${input.workerName}`,
      );
    }
  }
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
    // This fallback cannot name the kept classes in `containers` metadata
    // (wrangler-only path, no containers config without an image). That is
    // OK here: exports-mode uploads leave enablement alone (verified live
    // 2026-07-09 — exports-parking preview-3 with stub exports and no
    // containers field, then redeploying, kept its sandbox classes
    // container-enabled and sandbox-exec e2e green). Only legacy-migrations
    // uploads strip it, and those go through the raw upload above.
    const parkedDir = mkdtempSync(join(tmpdir(), "do-reset-"));
    try {
      // Classes the namespaces listing missed but the API knows have live
      // objects. Observed live 2026-07-09 (preview-3/5/8, class
      // SandboxStandard3DurableObject): the namespaces API attributed no
      // namespace for the class to this script, yet the deploy failed with
      // 10064 "does not export class X which is depended on by existing
      // Durable Objects" — deterministically, wedging every slot handover
      // for the full acquire budget (~15 min per CI run). The API error
      // names the class, so resurrect it as a kept stub (the sandbox-class
      // policy: orphaned instances are harmless once D1/KV are wiped; the
      // next real deploy re-declares whatever its config exports) and
      // retry. Bounded: each round can only ADD a class the API itself
      // demanded, and a worker has finitely many classes.
      const resurrected: string[] = [];
      for (;;) {
        const stubbed = [...kept, ...resurrected];
        writeFileSync(
          join(parkedDir, "worker.js"),
          `${parkedModule}\n${stubbed.map((className) => `export class ${className} { constructor() {} }`).join("\n")}\n`,
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
                stubbed.map((className) => [
                  className,
                  { type: "durable-object", storage: "sqlite" },
                ]),
              ),
            },
          }),
        );
        const viaExports = runWranglerDeploy({
          configPath: join(parkedDir, "wrangler.json"),
          cwd: input.cwd,
          credentials: input.credentials,
        });
        if (viaExports.ok) break;
        const missingClass = viaExports.output.match(
          /does not export class '([A-Za-z0-9_$]+)'/,
        )?.[1];
        if (!missingClass || resurrected.includes(missingClass)) {
          throw new Error(
            `DO reset: parked deploy failed for ${input.workerName} (see output above).`,
          );
        }
        console.log(
          `DO reset: ${input.workerName} has live Durable Objects of class ${missingClass} ` +
            `that the namespaces listing did not attribute to it — keeping it as a stub and retrying`,
        );
        resurrected.push(missingClass);
      }
      if (resurrected.length > 0) {
        console.log(
          `DO reset: kept unlisted classes ${resurrected.join(", ")} as stubs (instances survive as orphans)`,
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
 * No-op when every container class already exists. Throws when classes are
 * missing on a worker that is already exports-locked; callers must host a new
 * class on a dedicated script still eligible for legacy bootstrap because
 * Workers are never deleted. Delete this whole function when Cloudflare fixes
 * exports reconciliation for containers.
 */
export async function ensureContainerClasses(input: {
  ctx: CfContext;
  workerName: string;
  /** The container-bearing DO class names the app's config declares. */
  containerClassNames: string[];
  /** Exact Wrangler-generated application names this worker will deploy.
   * Cleanup is restricted to these names so parallel preview slots cannot
   * delete one another's control-plane state. */
  containerApplicationNames: string[];
  compatibilityDate: string;
}): Promise<{ action: "skipped" | "bootstrapped"; missing: string[] }> {
  if (input.containerClassNames.length === 0) return { action: "skipped", missing: [] };

  const scripts =
    await input.ctx.cf<{ id: string; migration_tag?: string | null }[]>(`/workers/scripts`);
  const script = scripts.find((candidate) => candidate.id === input.workerName);
  const live = script ? await getWorkerDoNamespaces(input.ctx, input.workerName) : [];
  const liveNames = new Set(live.map((namespace) => namespace.className));
  const missing = input.containerClassNames.filter((className) => !liveNames.has(className)).sort();

  // Historical worker recreation could leave an application pinned to a dead
  // namespace, and an exact name collision then blocks the coming deploy.
  // Restrict cleanup to this worker's declared application names: account-wide
  // sweeping is unsafe while independent preview slots deploy in parallel.
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
  const ownedApplicationNames = new Set(input.containerApplicationNames);
  for (const application of applications) {
    const namespaceId = application.durable_objects?.namespace_id;
    if (
      ownedApplicationNames.has(application.name) &&
      namespaceId &&
      !allNamespaceIds.has(namespaceId)
    ) {
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
          `container-enabled (upstream Cloudflare gap). Host the new class on a dedicated ` +
          `script still eligible for legacy bootstrap and bind it externally; workers are ` +
          `never deleted.`,
      );
    }
    throw error;
  }
  console.log(
    `container-class bootstrap: created ${missing.join(", ")} on ${input.workerName} (container-enabled)`,
  );
  return { action: "bootstrapped", missing };
}
