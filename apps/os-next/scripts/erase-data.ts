/**
 * Erase ALL data in a deployed os-next environment, leaving its infrastructure
 * (worker, routes, DNS, secrets, resource ids) untouched:
 *
 *   pnpm erase-data --env prd --yes-i-mean-prd --dry-run   # count only; changes nothing
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * `--env` is mandatory here (no DOPPLER_CONFIG fallback): a destructive script
 * must never pick its target from ambient shell state.
 *
 * What it erases and why that is sufficient for os-next:
 *   - every row of every table in src/control-plane.sql — the D1 directory
 *     (users, Google identities, orgs, memberships, projects, OAuth activity).
 *     Rows go, the schema stays; the next deploy re-applies it as a no-op.
 *   - every key in the three KV namespaces: oauth (the OAuth provider's
 *     clients, grants and tokens), secrets (project API-key hashes and
 *     `secret:<projectId>:*`) and itx (the `itx.kv` built-in, prefixed per context).
 *   Everything else a context owns lives in its IterateContextDurableObject, and
 *   the worker rename of 2026-09-12 already reset every instance. The D1 rows and
 *   KV keys are bound by id, so they survived that rename and now point at nothing
 *   (pre-rename and e2e-test junk). With them gone the env is logically pristine.
 *
 * Deliberately left alone: the Artifacts repos namespace (bound by NAME —
 * `artifactsNamespace`), the Durable Objects (already reset; no tombstone
 * redeploy here), worker secrets, routes, DNS and the resource ids in envs.ts.
 */
import { readFileSync } from "node:fs";
import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { fetchCloudflareWith429Retry } from "../../../scripts/lib/cloudflare-429-retry.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/**
 * The directory's tables in declaration order, read from the schema file so a
 * new table is picked up without touching this script. A child table is always
 * declared after the table it references, so deleting in REVERSE declaration
 * order satisfies every foreign key.
 */
function directoryTablesInDeclarationOrder(): string[] {
  const schema = readFileSync(new URL("../src/control-plane.sql", import.meta.url), "utf8");
  return [...schema.matchAll(/create table if not exists (\w+)/g)].map((match) => match[1]);
}

/** Erase ALL data in a deployed os-next environment; infrastructure stays (see file header). */
export default async function eraseData(options: {
  /** Target environment name from envs.ts. Required — destructive scripts never infer their target. */
  env: string;
  /** Confirm erasing PRODUCTION data (required when --env prd). */
  yesIMeanPrd?: boolean;
  /** Count what would be deleted and stop; nothing is changed. Run this first. */
  dryRun?: boolean;
}) {
  // Refused before Doppler is even consulted: the check needs no secrets.
  if (options.env === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }
  const context = await resolveEnvContext({
    envs: osNextEnvs,
    dopplerProject: "project-worker",
    env: options.env,
  });
  const { resources } = context.env;
  console.log(
    `${options.dryRun ? "Counting (dry run)" : "Erasing"} all data in ${context.name} (worker ${context.env.workerName})`,
  );

  // ---- D1 directory: every table in control-plane.sql ------------------------
  // The REST /query endpoint answers one entry per statement sent, in order.
  const d1Query = (sql: string) =>
    context.cf<{ results: Record<string, number>[] }[]>(
      `/d1/database/${resources.directoryDbId}/query`,
      { method: "POST", body: JSON.stringify({ sql }) },
    );
  const tables = directoryTablesInDeclarationOrder();
  const countRows = async (): Promise<Record<string, number>> => {
    const counted = await d1Query(
      tables.map((table) => `SELECT count(*) AS row_count FROM "${table}"`).join("; "),
    );
    return Object.fromEntries(
      tables.map((table, index) => [table, counted[index].results[0].row_count]),
    );
  };
  const logRowCounts = (label: string, counts: Record<string, number>) => {
    for (const table of tables) console.log(`D1 ${label}: ${table} — ${counts[table]} rows`);
  };
  logRowCounts("before", await countRows());
  if (!options.dryRun) {
    const childTablesFirst = [...tables].reverse();
    await d1Query(childTablesFirst.map((table) => `DELETE FROM "${table}"`).join("; "));
    logRowCounts("after", await countRows());
  }

  // ---- KV: every key in the three namespaces --------------------------------
  // Listed here rather than through context.cf(): that helper returns only
  // `result` and drops `result_info.cursor`, and a dry run needs the WHOLE
  // listing to count exactly (1000 keys per page is the API maximum).
  const listKeyNames = async (namespaceId: string): Promise<string[]> => {
    const names: string[] = [];
    let cursor = "";
    do {
      const path = `/accounts/${context.env.cloudflareAccountId}/storage/kv/namespaces/${namespaceId}/keys?limit=1000&cursor=${cursor}`;
      const response = await fetchCloudflareWith429Retry(`GET ${path}`, () =>
        fetch(`https://api.cloudflare.com/client/v4${path}`, {
          headers: { authorization: `Bearer ${context.secrets.CLOUDFLARE_API_TOKEN}` },
        }),
      );
      const body = (await response.json()) as {
        success: boolean;
        errors: unknown;
        result: { name: string }[];
        result_info: { cursor?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(
          `Cloudflare API GET ${path} failed (${response.status}): ${JSON.stringify(body.errors).slice(0, 500)}`,
        );
      }
      names.push(...body.result.map((key) => key.name));
      cursor = body.result_info.cursor || "";
    } while (cursor);
    return names;
  };
  for (const [label, namespaceId] of [
    ["oauth", resources.oauthKvId],
    ["secrets", resources.secretsKvId],
    ["itx", resources.itxKvId],
  ] as const) {
    const names = await listKeyNames(namespaceId);
    console.log(`KV before: ${label} (${namespaceId}) — ${names.length} keys`);
    if (options.dryRun) continue;
    // Bulk delete accepts up to 10,000 keys per call, but a call that large times out at
    // Cloudflare's gateway (a 524 on the first prd run, 2026-09-14); 1,000 per call lands.
    for (let offset = 0; offset < names.length; offset += 1_000) {
      await context.cf(`/storage/kv/namespaces/${namespaceId}/bulk/delete`, {
        method: "POST",
        body: JSON.stringify(names.slice(offset, offset + 1_000)),
      });
    }
    // KV listings are eventually consistent: a non-zero count right after the
    // delete is usually lag, not survivors — a --dry-run a minute later settles it.
    console.log(
      `KV after: ${label} (${namespaceId}) — ${(await listKeyNames(namespaceId)).length} keys`,
    );
  }

  console.log(
    options.dryRun
      ? `Dry run: nothing changed in ${context.name}. Re-run without --dry-run to erase.`
      : `✅ ${context.name} data erased: D1 directory and the three KV namespaces wiped; infra intact.`,
  );
}
if (process.argv[1]?.endsWith("erase-data.ts"))
  void createCli({ ...import.meta, name: "erase-data" }).run();
