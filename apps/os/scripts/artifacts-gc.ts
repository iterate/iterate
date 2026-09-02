/**
 * Backfill GC for orphaned Cloudflare Artifacts repos:
 *
 *   pnpm artifacts-gc --env preview_1 --dry-run
 *   pnpm artifacts-gc --env preview_1 --max-deletes 20000
 *   pnpm artifacts-gc --env prd --yes-i-mean-prd --dry-run
 *
 * Every project repo is backed by an Artifacts repo in the env's
 * `<worker>-repos` namespace (each creation also minting a 365-day write
 * token), and until erase-data grew its Artifacts pass nothing ever deleted
 * them — the dev/preview account accumulated ~783k orphans. erase-data now
 * keeps up going forward but its per-run budget can't drain a six-figure
 * backlog; this script exists to chip away at the pile, one env per
 * invocation, resumable (oldest first, so every run makes durable progress).
 *
 * What it will NOT delete:
 *   - repos younger than --older-than-hours (default 24) — recent repos may
 *     belong to in-flight work, and preview data is disposable within hours
 *     anyway. Listing is oldest-first, so the sweep stops at the cutoff.
 *   - repos whose name decodes to a project id with a live
 *     `project:<id>` entry in the env's project-directory KV — a currently
 *     leased preview slot (or prd) keeps its live projects' history.
 *   - repos whose name doesn't parse as a RepoArtifactNameCodec name (not
 *     created by this app — assume nothing, delete nothing).
 *   - on prd only: deployment-wide "global--*" repos, which no project owns.
 *
 * Rate limits: every API call rides the shared 429-backoff choke point, and
 * --max-deletes (default 5000) bounds a run's share of the account's global
 * control-plane budget (1200 req / 5 min).
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { fetchCloudflareWith429Retry } from "../../../scripts/lib/cloudflare-429-retry.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { RepoArtifactNameCodec } from "../src/domains/repos/utils.ts";

const LIST_PAGE_LIMIT = 200; // the Artifacts list endpoint's maximum
const DELETE_CONCURRENCY = 10;

/** Delete old, orphaned Artifacts repos from an env's `<worker>-repos` namespace. */
export default async function artifactsGc(options: {
  /** Target environment name from envs.ts. Required — destructive scripts never infer their target. */
  env: string;
  /** Confirm running against PRODUCTION (required when --env prd). */
  yesIMeanPrd?: boolean;
  /** Only delete repos created at least this many hours ago. */
  olderThanHours?: number;
  /** Stop after this many deletions (rate-limit politeness; rerun to continue). */
  maxDeletes?: number;
  /** List and report what would be deleted without deleting anything. */
  dryRun?: boolean;
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const { env } = ctx;
  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to GC PRODUCTION Artifacts repos without --yes-i-mean-prd.");
  }
  // ?? not ||: an explicit 0 is meaningful for both — a zero-hour cutoff
  // deletes regardless of age (the live-project skip still applies), and a
  // zero budget must not silently become the default.
  const olderThanHours = options.olderThanHours ?? 24;
  const maxDeletes = options.maxDeletes ?? 5000;
  const cutoffIso = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const namespace = `${env.osWorkerName}-repos`;

  // Cursor-paginated raw calls: ctx.cf strips result_info (and with it the
  // cursor), and unlike erase-data's delete-everything pass, skipping live
  // repos means we must be able to advance PAST entries we leave in place.
  const cfEnvelope = async <T>(path: string, init?: RequestInit) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}${path}`;
    const response = await fetchCloudflareWith429Retry(`${init?.method || "GET"} ${path}`, () =>
      fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}` },
      }),
    );
    // Trusted-shape cast, same contract as ctx.cf/cfV4 (env-context.ts) which
    // returns `body.result as T` unvalidated: the v4 envelope is Cloudflare's
    // documented response shape, and a surprise mismatch surfaces immediately
    // at the call site (undefined .result / .cursor), not as silent deletion
    // of the wrong thing — repo names always come from the listing itself.
    const body = (await response.json().catch(() => null)) as null | {
      success?: boolean;
      errors?: unknown;
      result: T;
      result_info?: { cursor?: string; count?: number };
    };
    if (!response.ok || !body || body.success === false) {
      throw new Error(
        `Cloudflare API ${init?.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body?.errors || body).slice(0, 300)}`,
      );
    }
    return body;
  };

  // ---- live projects: `project:<id>` keys in the project-directory KV --------
  const liveProjectIds = new Set<string>();
  for (let cursor: string | undefined; ; ) {
    const page = await cfEnvelope<{ name: string }[]>(
      `/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/keys?prefix=project:&limit=1000` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
    for (const key of page.result) liveProjectIds.add(key.name.slice("project:".length));
    cursor = page.result_info?.cursor || undefined;
    if (!cursor || page.result.length === 0) break;
  }
  console.log(
    `${namespace}: ${liveProjectIds.size} live project(s) in the directory; deleting repos created before ${cutoffIso}`,
  );

  // ---- sweep, oldest first ---------------------------------------------------
  const totals = { deleted: 0, failed: 0, skippedLive: 0, skippedForeign: 0, skippedGlobal: 0 };
  let cursor: string | undefined;
  let done = false;
  while (!done) {
    const page = await cfEnvelope<{ name: string; created_at: string }[]>(
      `/artifacts/namespaces/${namespace}/repos?limit=${LIST_PAGE_LIMIT}&sort=created_at&direction=asc` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
    if (page.result.length === 0) break;

    const triage = triageArtifactsRepoPage({
      repos: page.result,
      liveProjectIds,
      cutoffIso,
      protectGlobalRepos: ctx.name === "prd",
    });
    totals.skippedLive += triage.skippedLive.length;
    totals.skippedForeign += triage.skippedForeign.length;
    totals.skippedGlobal += triage.skippedGlobal.length;

    const budget = maxDeletes - totals.deleted;
    const deletable = triage.deletable.slice(0, budget);
    if (options.dryRun) {
      totals.deleted += deletable.length;
      if (deletable.length > 0) {
        console.log(
          `dry-run: would delete ${deletable.length} repo(s), oldest ${page.result[0]!.created_at} (${totals.deleted} total so far)`,
        );
      }
    } else if (deletable.length > 0) {
      const queue = [...deletable];
      let failedThisPage = 0;
      await Promise.all(
        Array.from({ length: DELETE_CONCURRENCY }, async () => {
          for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            try {
              await ctx.cf(`/artifacts/namespaces/${namespace}/repos/${encodeURIComponent(name)}`, {
                method: "DELETE",
              });
              totals.deleted += 1;
            } catch (error) {
              failedThisPage += 1;
              totals.failed += 1;
              if (totals.failed <= 3)
                console.warn(`delete failed (retried next pass): ${String(error).slice(0, 160)}`);
            }
          }
        }),
      );
      console.log(`${namespace}: ${totals.deleted}/${maxDeletes} deleted…`);
      if (failedThisPage === deletable.length || totals.failed > 50) {
        console.warn(
          `${namespace}: too many failed deletes (${totals.failed}) — stopping; rerun to retry`,
        );
        break;
      }
    }

    if (triage.reachedCutoff || totals.deleted >= maxDeletes) {
      done = true;
    } else if (!options.dryRun && deletable.length > 0) {
      // Deletions shift the oldest-first window, so restart from the head
      // rather than trusting a cursor into a mutated listing. The skipped
      // repos re-listed at the head are bounded (a slot's live projects are
      // few), and a pure-skip page advances by cursor below.
      cursor = undefined;
    } else {
      cursor = page.result_info?.cursor || undefined;
      if (!cursor) done = true;
    }
  }

  const summary = { namespace, cutoffIso, dryRun: !!options.dryRun, ...totals };
  console.log(
    `${options.dryRun ? "🔎 dry-run" : "✅"} ${JSON.stringify(summary)}` +
      (totals.deleted >= maxDeletes ? " — max-deletes reached, rerun to continue" : ""),
  );
  return summary;
}

/**
 * Decide each listed repo's fate. Pure so tests can pin the skip rules; the
 * listing is oldest-first, so the first repo at/after the cutoff ends the
 * whole sweep, not just the page.
 */
export function triageArtifactsRepoPage(input: {
  repos: { name: string; created_at: string }[];
  liveProjectIds: Set<string>;
  /** ISO timestamp; repos created at/after it are out of scope. */
  cutoffIso: string;
  /** prd: deployment-wide "global--*" repos have no owning project to check, so leave them. */
  protectGlobalRepos: boolean;
}) {
  const result: {
    deletable: string[];
    skippedLive: string[];
    skippedForeign: string[];
    skippedGlobal: string[];
    reachedCutoff: boolean;
  } = {
    deletable: [],
    skippedLive: [],
    skippedForeign: [],
    skippedGlobal: [],
    reachedCutoff: false,
  };
  for (const repo of input.repos) {
    // ISO-8601 UTC strings compare correctly as strings.
    if (repo.created_at >= input.cutoffIso) {
      result.reachedCutoff = true;
      break;
    }
    let projectId: string | null;
    try {
      projectId = RepoArtifactNameCodec.parse(repo.name).projectId;
    } catch {
      // Earlier app versions used other shapes (e.g. `prj_<id>--iterate-config`
      // with a literal, non-base64url suffix). A leading project id is still
      // authoritative — the repo belongs to that project, and the live-set
      // check below decides its fate. Names with no project id at all
      // (`iterate-config-base`, `repo-<hex>`) stay untouched.
      const legacy = /^(prj_[0-9a-f]+)--./.exec(repo.name);
      if (!legacy) {
        result.skippedForeign.push(repo.name);
        continue;
      }
      projectId = legacy[1]!;
    }
    if (projectId === null) {
      if (input.protectGlobalRepos) {
        result.skippedGlobal.push(repo.name);
        continue;
      }
    } else if (input.liveProjectIds.has(projectId)) {
      result.skippedLive.push(repo.name);
      continue;
    }
    result.deletable.push(repo.name);
  }
  return result;
}

void createCli({ ...import.meta, name: "artifacts-gc" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
