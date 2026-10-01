/** Erase all core/os data while retaining the worker, routes and resource identities.
 * Run `pnpm os:erase-data --env prd --yes-i-mean-prd --dry-run` before the real erase.
 * The worker is parked and its Durable Objects retired first, stopping writers and alarms.
 * The control plane's D1 tables (users, organizations, projects, grants), both KV namespaces, R2
 * files and Artifacts repositories are then emptied and verified. The D1's schema and migration
 * history are dropped, so the next deploy migrates it from nothing; its id is unchanged.
 * A failed or incomplete erase throws; rerunning is safe. Deploy again to restore service.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createCli } from "trpc-cli";
import { CLOUDFLARE_API, fetchRetryingPlatformFailures } from "iterate/platform-retry";
import { OS_DOPPLER_PROJECT, getEnv, osEnvs } from "../../envs.ts";
import { getWorkerDoNamespaces, resetWorkerDurableObjects } from "../lib/do-reset.ts";
import { CloudflareApiError, resolveEnvContext, type EnvContext } from "../lib/env-context.ts";
import { readWranglerBase } from "../../core/os/scripts/generate-wrangler-config.ts";
import { osResourceNames, type OsDeployableEnv } from "../../core/os/scripts/os-env.ts";
import { isCloudflareError } from "./preview-artifacts.ts";

const Listing = z.object({
  success: z.boolean(),
  errors: z.unknown().optional(),
  result: z.unknown(),
  result_info: z.object({ cursor: z.string().nullish() }).optional(),
});
const WorkerSettings = z.object({
  bindings: z.array(z.looseObject({ name: z.string(), type: z.string() })),
});
const dataBindings = new Set([
  "d1",
  "kv_namespace",
  "r2_bucket",
  "artifacts",
  "durable_object_namespace",
]);

export default async function eraseData(options: {
  /** Explicit environment; never inferred from ambient Doppler configuration. */
  env: string;
  /** Required for production, including its dry run. */
  yesIMeanPrd?: boolean;
  /** Inventory only: no data, objects, bindings or worker code are changed. */
  dryRun?: boolean;
}) {
  await eraseDataWith(options, {
    resolveEnvContext,
    getWorkerDoNamespaces,
    resetWorkerDurableObjects,
  });
}

/** The services an erase resolves its environment and retires Durable Objects through: the real
 *  ones from the CLI, controllable fakes in erase-data.test.ts. */
type EraseDataServices = {
  resolveEnvContext: typeof resolveEnvContext;
  getWorkerDoNamespaces: typeof getWorkerDoNamespaces;
  resetWorkerDurableObjects: typeof resetWorkerDurableObjects;
};

/** The erase itself, over `services`. Exported in a list, not as a declaration, so the CLI (which
 *  derives its commands from exported declarations) offers only `eraseData`. */
async function eraseDataWith(
  options: Parameters<typeof eraseData>[0],
  services: EraseDataServices,
) {
  if (options.env === "prd" && !options.yesIMeanPrd)
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  const context = await services.resolveEnvContext(getEnv(options.env, osEnvs), {
    dopplerProject: OS_DOPPLER_PROJECT,
  });
  const { env, cf } = context;
  if (!env.resources)
    throw new Error(`${env.name} records no resource ids in envs.ts: nothing to erase them by`);
  const resourceNames = osResourceNames(env.resourceNamePrefix);
  console.log(
    `${options.dryRun ? "Inventory" : "Erase"}: ${env.name}, worker ${env.workerName}, D1 ${resourceNames.db}, R2 ${resourceNames.files}, Artifacts ${resourceNames.repos}`,
  );
  const namespaces = await services.getWorkerDoNamespaces(context, env.workerName);
  console.log(
    `Durable Objects: ${namespaces.length} namespaces (${namespaces.map((n) => n.className).join(", ")})`,
  );

  const stores = [
    {
      label: "OAuth KV",
      route: `/storage/kv/namespaces/${env.resources.oauthKvId}/keys?limit=1000`,
      field: "name",
      bulk: `/storage/kv/namespaces/${env.resources.oauthKvId}/bulk/delete`,
      method: "POST",
    },
    {
      label: "ITX KV",
      route: `/storage/kv/namespaces/${env.resources.itxKvId}/keys?limit=1000`,
      field: "name",
      bulk: `/storage/kv/namespaces/${env.resources.itxKvId}/bulk/delete`,
      method: "POST",
    },
    {
      label: "R2 files",
      route: `/r2/buckets/${resourceNames.files}/objects?per_page=1000`,
      field: "key",
      bulk: `/r2/buckets/${resourceNames.files}/objects`,
      method: "DELETE",
    },
    {
      label: "Artifacts repositories",
      route: `/artifacts/namespaces/${encodeURIComponent(resourceNames.repos)}/repos?limit=200`,
      field: "name",
      bulk: "",
      method: "DELETE",
    },
  ] as const;
  // Read the full envelope: cf() intentionally returns only result and drops pagination cursors.
  const listNames = async (store: (typeof stores)[number]) => {
    const names: string[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    do {
      const route = `/accounts/${env.cloudflareAccountId}${store.route}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetchRetryingPlatformFailures(
        `GET ${route}`,
        (signal) =>
          fetch(`https://api.cloudflare.com/client/v4${route}`, {
            headers: { authorization: `Bearer ${context.secrets.CLOUDFLARE_API_TOKEN}` },
            signal,
          }),
        { area: "cloudflare-api", schedule: CLOUDFLARE_API, idempotent: true, timeoutMs: 60_000 },
      );
      const body = Listing.parse(await response.json());
      if (!response.ok || !body.success)
        throw new CloudflareApiError("GET", route, response.status, body.errors);
      const items =
        store.field === "key"
          ? z
              .array(z.object({ key: z.string().min(1) }))
              .parse(body.result)
              .map((item) => item.key)
          : z
              .array(z.object({ name: z.string().min(1) }))
              .parse(body.result)
              .map((item) => item.name);
      names.push(...items);
      cursor = body.result_info?.cursor || "";
      if (cursor && cursors.has(cursor))
        throw new Error(`${store.label}: listing repeated its cursor`);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return names;
  };
  const d1 = d1Query(cf, env.resources.dbId);
  const tables = await d1Tables(d1);
  const rowCounts = tables.length
    ? (await d1(tables.map((table) => `select count(*) as rows from "${table}"`).join("; "))).map(
        (rows) => z.object({ rows: z.number() }).parse(rows[0]).rows,
      )
    : [];
  for (const [index, rows] of rowCounts.entries())
    console.log(`D1 table to drop: ${tables[index]} — ${rows} rows`);
  for (const store of stores)
    console.log(`${store.label} before: ${(await listNames(store)).length}`);
  const resourceIds = new Set([
    ...Object.values(env.resources),
    resourceNames.files,
    resourceNames.repos,
  ]);
  const workers = z.array(z.object({ id: z.string() })).parse(await cf("/workers/scripts"));
  const others = workers.filter((worker) => worker.id !== env.workerName);
  const consumers: string[] = [];
  for (let offset = 0; offset < others.length; offset += 10)
    await Promise.all(
      others.slice(offset, offset + 10).map(async (worker) => {
        // A Worker deleted since the listing (the dev account's per-commit deployments come and
        // go) binds nothing.
        const settings = await cf(`/workers/scripts/${encodeURIComponent(worker.id)}/settings`)
          .then((body) => WorkerSettings.parse(body))
          .catch((error: unknown) => {
            if (!isCloudflareError(error, 404, 10007)) throw error;
            return { bindings: [] };
          });
        if (
          settings.bindings.some(
            (binding) =>
              dataBindings.has(binding.type) &&
              Object.values(binding).some(
                (value) => typeof value === "string" && resourceIds.has(value),
              ),
          )
        )
          consumers.push(worker.id);
      }),
    );
  console.log(`Other workers sharing data: ${consumers.sort().join(", ") || "none"}`);
  if (options.dryRun) {
    console.log(`Dry run: nothing changed in ${env.name}.`);
    return;
  }
  if (consumers.length)
    throw new Error(
      `Other workers still use these resources: ${consumers.join(", ")}. Retire their writers before erasing shared data.`,
    );

  if (new Set(namespaces.map((namespace) => namespace.className)).size !== namespaces.length)
    throw new Error(
      "Two of the worker's own Durable Object namespaces share a class name, and a retirement goes by class: refusing to guess which to erase.",
    );
  const { compatibility_date: compatibilityDate } = z
    .object({ compatibility_date: z.string() })
    .parse(readWranglerBase());

  await services.resetWorkerDurableObjects({
    ctx: context,
    workerName: env.workerName,
    cwd: fileURLToPath(new URL("../../core/os/", import.meta.url)),
    credentials: {
      CLOUDFLARE_API_TOKEN: context.secrets.CLOUDFLARE_API_TOKEN!,
      CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
    },
    compatibilityDate,
  });
  if ((await services.getWorkerDoNamespaces(context, env.workerName)).length)
    throw new Error(
      "Durable Object namespaces remain after retirement; refusing to erase while writers may survive.",
    );
  const parked = WorkerSettings.parse(
    await cf(`/workers/scripts/${encodeURIComponent(env.workerName)}/settings`),
  );
  if (parked.bindings.some((binding) => dataBindings.has(binding.type)))
    throw new Error(
      "Worker still has data bindings; refusing to erase data while requests may still write.",
    );

  await dropD1Schema(d1);
  console.log("D1 after: no schema and no migration history");

  for (const store of stores) {
    const deadline = Date.now() + 30 * 60_000;
    let deleted = 0;
    for (;;) {
      const names = await listNames(store);
      if (!names.length) break;
      if (Date.now() >= deadline)
        throw new Error(
          `${store.label}: erase deadline exceeded with ${names.length} items remaining; rerun to finish.`,
        );
      const size = store.bulk ? 1000 : 10;
      for (let offset = 0; offset < names.length; offset += size) {
        if (Date.now() >= deadline)
          throw new Error(`${store.label}: erase deadline exceeded; rerun to finish.`);
        const batch = names.slice(offset, offset + size);
        if (store.bulk) {
          await cf(store.bulk, {
            method: store.method,
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(60_000),
          });
        } else {
          await Promise.all(
            batch.map((name) =>
              cf(
                `/artifacts/namespaces/${encodeURIComponent(resourceNames.repos)}/repos/${encodeURIComponent(name)}`,
                {
                  method: "DELETE",
                  signal: AbortSignal.timeout(60_000),
                },
              ).catch((error) => {
                // Artifacts deletions are asynchronous; a preceding accepted delete may have completed.
                if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
              }),
            ),
          );
        }
        deleted += batch.length;
        if (store.bulk || deleted % 200 === 0)
          console.log(`${store.label}: ${deleted} deletions submitted`);
      }
      // KV lists and accepted Artifacts deletes can lag; verify again with a bounded deadline.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    console.log(`${store.label} after: empty`);
  }
  console.log(
    `✅ ${env.name}: all Durable Objects retired; the D1's schema and migration history dropped; both KV namespaces, R2 and Artifacts verified empty. Deploy to migrate the D1 from nothing and restore service.`,
  );
}

/** A D1's `/query`: a statement's results per `;`-separated statement. */
type D1Query = (sql: string) => Promise<Record<string, unknown>[][]>;
function d1Query(cf: EnvContext<OsDeployableEnv>["cf"], databaseId: string): D1Query {
  return async (sql) =>
    z
      .array(z.object({ results: z.array(z.looseObject({})) }))
      .parse(
        await cf(`/d1/database/${databaseId}/query`, {
          method: "POST",
          body: JSON.stringify({ sql }),
        }),
      )
      .map((result) => result.results);
}

/** A name of SQLite's own (`sqlite_…`, `sqlite_sequence` among them) or D1's (`_cf_…`), which the
 *  erase never touches. Tested here, not with LIKE, whose `_` matches any character. */
const isSystemName = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_");

/** The D1's own tables, wrangler's migration history (`d1_migrations`) among them. */
async function d1Tables(d1: D1Query) {
  const [schema = []] = await d1("select name from sqlite_master where type = 'table'");
  return z
    .array(z.object({ name: z.string() }))
    .parse(schema)
    .map((table) => table.name)
    .filter((name) => !isSystemName(name));
}

/** Drops every table of the D1 but SQLite's and D1's, `d1_migrations` included, so the next deploy
 *  migrates it from nothing; each table's indexes and triggers go with it. One request is one
 *  transaction, with foreign keys deferred to its end
 *  (https://developers.cloudflare.com/d1/sql-api/foreign-keys/). A table drops before the tables it
 *  references: D1 refuses to drop one whose parent is already gone ("no such table: main.users",
 *  measured 2026-09-28). Throws unless only SQLite's and D1's own schema remains. */
async function dropD1Schema(d1: D1Query) {
  const tables = await d1Tables(d1);
  // `pragma foreign_key_list` as a statement: D1 refuses the `pragma_…` table-valued function
  // (SQLITE_AUTH, measured 2026-09-28)
  const references = tables.length
    ? await d1(tables.map((table) => `pragma foreign_key_list("${table}")`).join("; "))
    : [];
  const parents = references
    .flatMap((keys, index) =>
      z
        .array(z.looseObject({ table: z.string() }))
        .parse(keys)
        .map((key) => ({ child: tables[index]!, parent: key.table })),
    )
    .filter(({ child, parent }) => child !== parent);
  // children first: a table drops once no table still standing references it
  const order: string[] = [];
  const standing = new Set(tables);
  while (standing.size) {
    const unreferenced = [...standing].filter(
      (table) => !parents.some(({ child, parent }) => parent === table && standing.has(child)),
    );
    if (!unreferenced.length)
      throw new Error(`D1 tables reference each other in a cycle: ${[...standing].join(", ")}`);
    for (const table of unreferenced) standing.delete(table);
    order.push(...unreferenced);
  }
  if (order.length)
    await d1(
      ["pragma defer_foreign_keys = on", ...order.map((table) => `drop table "${table}"`)].join(
        "; ",
      ),
    );
  const [schema = []] = await d1("select type, name, tbl_name from sqlite_master");
  const remaining = z
    .array(z.object({ type: z.string(), name: z.string(), tbl_name: z.string() }))
    .parse(schema)
    .filter((entry) => !isSystemName(entry.tbl_name))
    .map((entry) => `${entry.type} ${entry.name}`);
  if (remaining.length)
    throw new Error(`D1 still holds ${remaining.join(", ")} after the drop; rerun to finish.`);
}

export { eraseDataWith, d1Query, dropD1Schema };

void createCli({ ...import.meta, name: "erase-data" }).run();
