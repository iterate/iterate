/** Erase all OS-Next data while retaining the worker, routes and resource identities.
 * Run `pnpm erase-data --env prd --yes-i-mean-prd --dry-run` before the real erase.
 * The worker is parked and its Durable Objects retired first, stopping writers and alarms.
 * D1, both KV namespaces, R2 files and Artifacts repositories are then emptied and verified.
 * A failed or incomplete erase throws; rerunning is safe. Deploy again to restore service.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import JSON5 from "json5";
import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { fetchCloudflareWith429Retry } from "../../../scripts/lib/cloudflare-429-retry.ts";
import { getWorkerDoNamespaces, resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { CloudflareApiError, resolveEnvContext } from "../../../scripts/lib/env-context.ts";

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
  if (options.env === "prd" && !options.yesIMeanPrd)
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  const context = await resolveEnvContext({
    envs: osNextEnvs,
    dopplerProject: "project-worker",
    env: options.env,
  });
  const { env, cf } = context;
  console.log(
    `${options.dryRun ? "Inventory" : "Erase"}: ${context.name}, worker ${env.workerName}`,
  );
  const namespaces = await getWorkerDoNamespaces(context, env.workerName);
  console.log(
    `Durable Objects: ${namespaces.length} namespaces (${namespaces.map((n) => n.className).join(", ")})`,
  );

  const schema = readFileSync(new URL("../src/control-plane.sql", import.meta.url), "utf8");
  const tables = [...schema.matchAll(/create table if not exists (\w+)/g)].map(
    (match) => match[1]!,
  );
  if (!tables.length)
    throw new Error("The directory schema contains no tables; refusing an incomplete erase.");
  const catalog = await cf<{ results: { name: string }[] }[]>(
    `/d1/database/${env.resources.directoryDbId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'" }),
    },
  );
  const unknownTables = catalog.flatMap((result) =>
    result.results
      .map((row) => row.name)
      .filter(
        (name) =>
          !tables.includes(name) &&
          !name.startsWith("sqlite_") &&
          !name.startsWith("_cf_") &&
          name !== "d1_migrations",
      ),
  );
  if (unknownTables.length)
    throw new Error(
      `Unrecognized directory tables: ${unknownTables.join(", ")}. Account for their data before erasing.`,
    );
  const countRows = () =>
    cf<{ results: { row_count: number }[] }[]>(
      `/d1/database/${env.resources.directoryDbId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          sql: tables.map((table) => `SELECT count(*) AS row_count FROM "${table}"`).join("; "),
        }),
      },
    );
  const counts = await countRows();
  for (const [index, table] of tables.entries())
    console.log(`D1 before: ${table} — ${counts[index]!.results[0]!.row_count} rows`);

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
      "Multiple namespaces share a class name: this worker may host branch previews. Use the preview reset command for a single preview instead.",
    );
  const { compatibility_date: compatibilityDate } = z
    .object({ compatibility_date: z.string() })
    .parse(JSON5.parse(readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8")));

  await resetWorkerDurableObjects({
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
  if ((await getWorkerDoNamespaces(context, env.workerName)).length)
    throw new Error(
      "Durable Object namespaces remain after retirement; refusing to clear the directory while writers may survive.",
    );
  const parked = WorkerSettings.parse(
    await cf(`/workers/scripts/${encodeURIComponent(env.workerName)}/settings`),
  );
  if (parked.bindings.some((binding) => dataBindings.has(binding.type)))
    throw new Error(
      "Worker still has data bindings; refusing to erase data while requests may still write.",
    );

  await cf(`/d1/database/${env.resources.directoryDbId}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql: [...tables]
        .reverse()
        .map((table) => `DELETE FROM "${table}"`)
        .join("; "),
    }),
  });
  if ((await countRows()).some((result) => result.results[0]!.row_count !== 0))
    throw new Error("D1 still contains rows after erase.");
  console.log("D1 after: every directory table is empty");

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
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();
