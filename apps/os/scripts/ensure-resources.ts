/**
 * Ensure a deployed environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Idempotent and create-only — it NEVER deletes anything. For each resource
 * (the project-directory KV, the auth D1 database, proxied DNS records for
 * every routed hostname) it creates whatever is missing, then compares
 * reality against the env's `resources` entry in envs.ts and prints the
 * exact snippet to paste when they differ. IDs live in git, so the last
 * step of bringing up a new env is always a reviewed commit.
 *
 * CI never runs this: a deploy with a missing/mismatched ID fails loudly and
 * tells you to run it yourself.
 */
import { resolveEnvContext } from "./lib/env-context.ts";

const ctx = await resolveEnvContext();
const { env, cf } = ctx;
console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

// ---- KV: project directory -----------------------------------------------
const kvTitle = `${env.osWorkerName}-project-directory`;
const kvNamespaces: { id: string; title: string }[] = await cf(
  `/storage/kv/namespaces?per_page=100`,
);
let kv = kvNamespaces.find((namespace) => namespace.title === kvTitle);
if (!kv) {
  kv = (await cf(`/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title: kvTitle }),
  })) as { id: string; title: string };
  console.log(`created KV namespace ${kvTitle} (${kv.id})`);
} else {
  console.log(`KV namespace ${kvTitle} exists (${kv.id})`);
}

// ---- D1: auth database ------------------------------------------------------
const dbName = `${env.authWorkerName}-auth-db`;
const databases: { uuid: string; name: string }[] = await cf(`/d1/database?per_page=100`);
let db = databases.find((database) => database.name === dbName);
if (!db) {
  db = (await cf(`/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name: dbName }),
  })) as { uuid: string; name: string };
  console.log(`created D1 database ${dbName} (${db.uuid})`);
} else {
  console.log(`D1 database ${dbName} exists (${db.uuid})`);
}

// ---- DNS: proxied records for every routed hostname --------------------------
// Worker zone routes only fire when a proxied DNS record answers the
// hostname. Wrangler's custom_domains can't cover wildcards, so ensure the
// records here (create-only; deploys never touch DNS).
const hostRecords = [
  new URL(env.baseUrl).hostname,
  new URL(env.mcpBaseUrl).hostname,
  ...env.projectHostnameBases.flatMap((base) => [base, `*.${base}`]),
];
const zones: { id: string; name: string }[] = await cf0(
  `/zones?account.id=${env.cloudflareAccountId}&per_page=100`,
);
for (const host of hostRecords) {
  const zone = zones.find(
    (candidate) => host === candidate.name || host.endsWith(`.${candidate.name}`),
  );
  if (!zone) {
    console.warn(`⚠ no zone for ${host} in this account — create the zone first, then re-run`);
    continue;
  }
  const existing: unknown[] = await cf0(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=5`,
  );
  if (existing.length > 0) {
    console.log(`DNS record for ${host} exists`);
    continue;
  }
  await cf0(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "AAAA",
      name: host,
      content: "100::", // originless: traffic terminates at the Worker route
      proxied: true,
      comment: `iterate ${ctx.name} os worker route host (ensure-resources.ts)`,
    }),
  });
  console.log(`created proxied DNS record for ${host}`);
}

// ---- Reconcile against envs.ts -----------------------------------------------
const expected = env.resources;
const actual = { projectDirectoryKvId: kv.id, authDbId: db.uuid };
if (
  expected.projectDirectoryKvId !== actual.projectDirectoryKvId ||
  expected.authDbId !== actual.authDbId
) {
  console.log(`\nenvs.ts is out of date for ${ctx.name} — update its resources entry to:\n`);
  console.log(`  resources: ${JSON.stringify(actual, null, 2).replaceAll("\n", "\n  ")},\n`);
  console.log("then commit and regenerate: pnpm gen:wrangler");
  process.exit(1);
}
console.log(`✅ ${ctx.name} resources all present and match envs.ts`);

/** Zone-scoped API calls (zones are account-level, not under /accounts). */
async function cf0(path: string, init?: RequestInit) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body: any = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw new Error(
      `Cloudflare API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 500)}`,
    );
  }
  return body.result;
}
