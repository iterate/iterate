// THE CONTEXT SWEEP — what Cloudflare stores against what the platform holds. A project's deletion
// (apps/os/src/project/processor.ts) destroys the contexts its registry names; a context whose
// announcement never landed is not named, so it would outlive its project, stored and billed, with
// no way to find it by name. Cloudflare lists every object of the context namespace that holds data
// (the List Objects API, by id alone); each says who it is from its own birth record
// (`session.contexts.identify`, which records no wake), and one whose project the control plane
// no longer holds is an orphan. Report-only unless `--destroy`, which destroys each orphan through
// `session.contexts.destroy` — refused for a global context and for any project that still exists.
//
//   pnpm tsx scripts/ci/context-sweep.ts --env prd [--destroy]
//
// The deployment's Cloudflare credentials and APP_CONFIG (its operator bearer) come from its own
// Doppler config (scripts/lib/env-context.ts `resolveEnvContext`, which refuses a Doppler account
// that is not envs.ts's). It fails when an object could not say who it is or an orphan could not be
// destroyed; orphans alone are the report, not a failure.
import type { IterateSessionApi } from "iterate/api";
import { connectIterate } from "iterate/node";
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../envs.ts";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { getWorkerDoNamespaces } from "../lib/do-reset.ts";
import { resolveEnvContext } from "../lib/env-context.ts";

/** One stored object as the sweep sees it. */
export type SweptContext = Awaited<ReturnType<IterateSessionApi["contexts"]["identify"]>>[number];

/** What an object with no birth record answers (apps/os iterate-context-durable-object.ts
 *  `iterateContextAddressOf`): it is empty — destroyed moments ago, and Cloudflare's list still
 *  flags it as holding data for a few minutes (measured on prd, 2026-09-25: up to ~7 min). */
const EMPTIED = "only a context that was born answers";

/** What the sweep does with each object: a live project's context, a global context (users,
 *  organizations: never swept), an orphan of a project the control plane no longer holds, one just
 *  emptied (destroyed, the list not caught up), or one that could not say who it is. */
export function classifyContexts(contexts: SweptContext[], liveProjectIds: ReadonlySet<string>) {
  const report = {
    live: [] as string[],
    global: [] as string[],
    orphans: [] as { id: string; projectId: string; path: string }[],
    emptied: [] as string[],
    unidentified: [] as { id: string; error: string }[],
  };
  for (const context of contexts) {
    if ("error" in context && context.error.includes(EMPTIED)) report.emptied.push(context.id);
    else if ("error" in context) report.unidentified.push(context);
    else if (context.projectId === "global") report.global.push(context.id);
    else if (liveProjectIds.has(context.projectId)) report.live.push(context.id);
    else report.orphans.push(context);
  }
  return report;
}

/** The largest page Cloudflare's List Objects API answers. The API client hands back no cursor, so
 *  the sweep reads one page and refuses a full one, which may be cut off. */
const OBJECTS_PAGE = 10_000;

/** Sweep the context namespace of the OS deployment `env`: report every orphan, and with `destroy`
 *  destroy each. */
export default async function contextSweep(options: {
  /** The OS deployment to sweep (envs.ts osEnvs). */
  env: string;
  /** Destroy each orphan (session.contexts.destroy). */
  destroy?: boolean;
}) {
  const ctx = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const target = ctx.env;
  const namespaces = (await getWorkerDoNamespaces(ctx, target.workerName)).filter(
    ({ className }) => className === "IterateContextDurableObject",
  );
  if (namespaces.length !== 1)
    throw new Error(
      `expected one IterateContextDurableObject namespace on ${target.workerName}, found ${namespaces.length}`,
    );
  const { namespaceId } = namespaces[0]!;
  const objects = await ctx.cf<{ id: string; hasStoredData?: boolean }[]>(
    `/workers/durable_objects/namespaces/${namespaceId}/objects?limit=${OBJECTS_PAGE}`,
  );
  if (objects.length >= OBJECTS_PAGE)
    throw new Error(`${OBJECTS_PAGE} or more context objects: the listing may be cut off`);
  const stored = objects.filter((row) => row.hasStoredData).map((row) => row.id);

  const config = parseAppConfig({
    APP_CONFIG: ctx.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: ctx.secrets.APP_CONFIG_SECRETS__KEY,
  });
  using connection = await connectIterate({
    baseUrl: target.baseUrl,
    auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
  });
  const { session } = connection;
  const contexts: SweptContext[] = [];
  for (let start = 0; start < stored.length; start += 50)
    contexts.push(...(await session.contexts.identify(stored.slice(start, start + 50))));
  const live = new Set((await session.projects.list()).map((project) => project.id));
  const report = classifyContexts(contexts, live);

  const destroyed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (options.destroy)
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
      env: options.env,
      namespace: namespaceId,
      stored: stored.length,
      live: report.live.length,
      global: report.global.length,
      orphans: report.orphans.length,
      emptied: report.emptied.length,
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
  if (report.unidentified.length || failed.length)
    throw new Error(
      `${report.unidentified.length} object(s) could not say who they are, ${failed.length} orphan(s) not destroyed`,
    );
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "context-sweep" }).run();
