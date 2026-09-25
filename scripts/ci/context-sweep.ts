// THE CONTEXT SWEEP — what Cloudflare stores against what the platform holds. A project's deletion
// (apps/os/src/project/processor.ts) destroys the contexts its registry names; a context whose
// announcement never landed is not named, so it would outlive its project, stored and billed, with
// no way to find it by name. Cloudflare lists every object of the context namespace that holds data
// (the List Objects API, by id alone); each says who it is from its own birth record
// (`session.contexts.identify`, which records no wake), and one whose project the control plane
// no longer holds is an orphan. Report-only unless `--destroy`, which destroys each orphan through
// `session.contexts.destroy` — refused for a global context and for any project that still exists.
//
//   doppler run --project os --config prd -- pnpm tsx scripts/ci/context-sweep.ts [--destroy]
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the deployment's account) and the
// deployment's APP_CONFIG (its operator bearer). Exits non-zero when an object could not say who it
// is or an orphan could not be destroyed; orphans alone are the report, not a failure.
import { parseArgs } from "node:util";
import { connectIterate } from "iterate/node";
import { osEnvs } from "../../envs.ts";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";

/** One stored object as the sweep sees it. */
export type SweptContext =
  | { id: string; projectId: string; path: string }
  | { id: string; error: string };

/** What the sweep does with each object: a live project's context, a global context (users,
 *  organizations: never swept), an orphan of a project the control plane no longer holds, or one
 *  that could not say who it is. */
export function classifyContexts(contexts: SweptContext[], liveProjectIds: ReadonlySet<string>) {
  const report = {
    live: [] as string[],
    global: [] as string[],
    orphans: [] as { id: string; projectId: string; path: string }[],
    unidentified: [] as { id: string; error: string }[],
  };
  for (const context of contexts) {
    if ("error" in context) report.unidentified.push(context);
    else if (context.projectId === "global") report.global.push(context.id);
    else if (liveProjectIds.has(context.projectId)) report.live.push(context.id);
    else report.orphans.push(context);
  }
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      destroy: { type: "boolean", default: false },
      env: { type: "string", default: "prd" },
    },
  });
  const target = osEnvs[values.env!];
  if (!target) throw new Error(`no osEnvs entry ${values.env}`);
  const token = required("CLOUDFLARE_API_TOKEN");
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces`;
  const cloudflare = async <T>(
    url: string,
  ): Promise<{ result: T; result_info?: { cursor?: string } }> => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { success: boolean; errors: unknown; result: T };
    if (!body.success) throw new Error(`${url}: ${JSON.stringify(body.errors)}`);
    return body as never;
  };

  const namespace = (
    await cloudflare<{ id: string; class?: string; script?: string }[]>(`${api}?per_page=1000`)
  ).result.find(
    (row) => row.class === "IterateContextDurableObject" && row.script === target.workerName,
  );
  if (!namespace)
    throw new Error(`no IterateContextDurableObject namespace on ${target.workerName}`);
  const stored: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await cloudflare<{ id: string; hasStoredData?: boolean }[]>(
      `${api}/${namespace.id}/objects?limit=10000${cursor ? `&cursor=${cursor}` : ""}`,
    );
    stored.push(...page.result.filter((row) => row.hasStoredData).map((row) => row.id));
    cursor = page.result_info?.cursor;
    if (!cursor || page.result.length === 0) break;
  }

  const config = parseAppConfig({
    APP_CONFIG: required("APP_CONFIG"),
    APP_CONFIG_SECRETS__KEY: process.env.APP_CONFIG_SECRETS__KEY,
  });
  using connection = await connectIterate({
    baseUrl: target.baseUrl,
    auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
  });
  const session = connection.session as unknown as {
    projects: { list(): Promise<{ id: string }[]> };
    contexts: {
      identify(ids: string[]): Promise<SweptContext[]>;
      destroy(id: string): Promise<{ projectId: string; path: string }>;
    };
  };
  const contexts: SweptContext[] = [];
  for (let start = 0; start < stored.length; start += 50)
    contexts.push(...(await session.contexts.identify(stored.slice(start, start + 50))));
  const live = new Set((await session.projects.list()).map((project) => project.id));
  const report = classifyContexts(contexts, live);

  const destroyed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (values.destroy)
    for (const orphan of report.orphans)
      try {
        await session.contexts.destroy(orphan.id);
        destroyed.push(orphan.id);
      } catch (error) {
        failed.push({ id: orphan.id, error: String(error).slice(0, 300) });
      }

  console.log(
    JSON.stringify({
      event: "context-sweep.report",
      env: values.env,
      namespace: namespace.id,
      stored: stored.length,
      live: report.live.length,
      global: report.global.length,
      orphans: report.orphans.length,
      unidentified: report.unidentified.length,
      destroyed: destroyed.length,
      destroyFailed: failed.length,
    }),
  );
  for (const orphan of report.orphans)
    console.log(`orphan ${orphan.projectId}${orphan.path} (${orphan.id})`);
  for (const context of report.unidentified)
    console.log(`unidentified ${context.id}: ${context.error}`);
  for (const failure of failed) console.log(`destroy failed ${failure.id}: ${failure.error}`);
  if (report.unidentified.length || failed.length) process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (run under doppler run --project os --config prd)`);
  return value;
}

if (process.argv[1]?.endsWith("context-sweep.ts")) await main();
