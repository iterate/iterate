/** Erase all apps/os data while retaining the worker, routes and resource identities.
 * Run `pnpm erase-data --env prd --yes-i-mean-prd --dry-run` before the real erase.
 * The worker is parked and its Durable Objects retired first, stopping writers and alarms.
 * The control plane's D1 rows (users, organizations, projects, grants), both KV namespaces, R2
 * files and Artifacts repositories are then emptied and verified. The D1 keeps its schema and
 * migration history, so the next deploy's migrate is a no-op.
 * A failed or incomplete erase throws; rerunning is safe. Deploy again to restore service.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { fetchCloudflareWith429Retry } from "../../../scripts/lib/cloudflare-429-retry.ts";
import { getWorkerDoNamespaces, resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { CloudflareApiError, resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";

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
  const context = await services.resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const { env, cf } = context;
  console.log(
    `${options.dryRun ? "Inventory" : "Erase"}: ${context.name}, worker ${env.workerName}`,
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
      route: `/r2/buckets/${env.resourceNamePrefix}-files/objects?per_page=1000`,
      field: "key",
      bulk: `/r2/buckets/${env.resourceNamePrefix}-files/objects`,
      method: "DELETE",
    },
    {
      label: "Artifacts repositories",
      route: `/artifacts/namespaces/${encodeURIComponent(env.artifactsNamespace)}/repos?limit=200`,
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
      const response = await fetchCloudflareWith429Retry(`GET ${route}`, () =>
        fetch(`https://api.cloudflare.com/client/v4${route}`, {
          headers: { authorization: `Bearer ${context.secrets.CLOUDFLARE_API_TOKEN}` },
          signal: AbortSignal.timeout(60_000),
        }),
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
  /** One `/query` of the D1, a statement's results per `;`-separated statement. */
  const d1 = async (sql: string) =>
    z
      .array(z.object({ results: z.array(z.looseObject({})) }))
      .parse(
        await cf(`/d1/database/${env.resources.dbId}/query`, {
          method: "POST",
          body: JSON.stringify({ sql }),
        }),
      )
      .map((result) => result.results);
  /** The D1's tables, but SQLite's own (`sqlite_…`, `sqlite_sequence` among them), D1's (`_cf_…`)
   *  and wrangler's migration history (`d1_migrations`), which stays with the schema. Filtered here,
   *  not with LIKE, whose `_` matches any character. */
  const [schema = []] = await d1("select name from sqlite_master where type = 'table'");
  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(schema)
    .map((table) => table.name)
    .filter(
      (name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_") && name !== "d1_migrations",
    );
  const countRows = async () =>
    tables.length
      ? (await d1(tables.map((table) => `select count(*) as rows from "${table}"`).join("; "))).map(
          (rows) => z.object({ rows: z.number() }).parse(rows[0]).rows,
        )
      : [];
  for (const [index, rows] of (await countRows()).entries())
    console.log(`D1 before: ${tables[index]} — ${rows} rows`);
  for (const store of stores)
    console.log(`${store.label} before: ${(await listNames(store)).length}`);
  const resourceIds = new Set([
    ...Object.values(env.resources),
    `${env.resourceNamePrefix}-files`,
    env.artifactsNamespace,
  ]);
  const workers = z.array(z.object({ id: z.string() })).parse(await cf("/workers/scripts"));
  const others = workers.filter((worker) => worker.id !== env.workerName);
  const consumers: string[] = [];
  for (let offset = 0; offset < others.length; offset += 10)
    await Promise.all(
      others.slice(offset, offset + 10).map(async (worker) => {
        const settings = WorkerSettings.parse(
          await cf(`/workers/scripts/${encodeURIComponent(worker.id)}/settings`),
        );
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
    console.log(`Dry run: nothing changed in ${context.name}.`);
    return;
  }
  if (consumers.length)
    throw new Error(
      `Other workers still use these resources: ${consumers.join(", ")}. Retire their writers before erasing shared data.`,
    );

  if (new Set(namespaces.map((namespace) => namespace.className)).size !== namespaces.length)
    throw new Error(
      "Two of the worker's own Durable Object namespaces share a class name, and a retirement goes by class: refusing to guess which to erase. (Its Worker Previews' namespaces are not its own: getWorkerDoNamespaces leaves them out, and the erase leaves them alone.)",
    );
  const { compatibility_date: compatibilityDate } = z
    .object({ compatibility_date: z.string() })
    .parse(readWranglerBase());

  await services.resetWorkerDurableObjects({
    ctx: context,
    workerName: env.workerName,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    credentials: {
      CLOUDFLARE_API_TOKEN: context.secrets.CLOUDFLARE_API_TOKEN!,
      CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
    },
    compatibilityDate,
    containerClassNames: [],
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

  // D1 enforces foreign keys; deferred to the end of this one request's transaction, the tables
  // empty in any order (https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
  if (tables.length)
    await d1(
      ["pragma defer_foreign_keys = on", ...tables.map((table) => `delete from "${table}"`)].join(
        "; ",
      ),
    );
  if ((await countRows()).some((rows) => rows !== 0))
    throw new Error("D1 still holds rows after the erase; rerun to finish.");
  console.log("D1 after: every table is empty");

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
                `/artifacts/namespaces/${encodeURIComponent(env.artifactsNamespace)}/repos/${encodeURIComponent(name)}`,
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
    `✅ ${context.name}: all Durable Objects retired; D1, both KV namespaces, R2 and Artifacts verified empty. Deploy to restore service.`,
  );
}
export { eraseDataWith };

if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();
