// `pnpm cli config-repo reset --project <slug-or-id>` — overwrite a project's
// config repo (`/repos/config`) so its tree matches the CURRENT template at
// apps/os/config-repo-template. Run it from `apps/os`; the active Doppler
// config supplies the OS deployment URL and its matching admin secret:
//
//   doppler run --config prd -- pnpm cli config-repo reset --project iterate
//
// It seeds the exact same file map a freshly created project on this
// deployment would get (`projectRepoSeedFiles`, including the pkg.pr.new
// ref/spec swaps), then commits ONE batch that writes every template file and
// deletes anything the project still carries that the template no longer
// ships. Config-repo commits land on main and redeploy the project worker
// automatically, so the reset takes effect on the next build — no extra step.

import process from "node:process";

import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { connectItx } from "iterate/node";

import { projectRepoSeedFiles } from "../src/domains/repos/project-repo-seed.ts";
import { parseIterateRepoPkgSpecOverridesEnv } from "../src/pkg-pr-new.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

type ResetOptions = {
  /** Project slug or `prj_` ID whose `/repos/config` to reset. */
  project: string;
  /**
   * The pkg.pr.new ref to pin the seeded manifests' iterate/iterate specs to.
   * Defaults to the deployment's own `APP_CONFIG_ITERATE_REPO_PKG_REF` (unset
   * on prd → the template's `@main` pkg.pr.new builds), so a reset matches
   * exactly what a new project on this deployment would install.
   */
  pkgRef?: string;
  /** Commit message. Defaults to a descriptive template-reset line. */
  message?: string;
  /** Print the plan (files to write / delete) without committing. */
  dryRun?: boolean;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or the live local dev server. */
  baseUrl?: string;
};

/**
 * Reset one project's config repo to the current template. Destructive by
 * design: the project's own edits under `/repos/config` are discarded. Use
 * `--dry-run` first to see exactly which paths will be written and deleted.
 */
export async function reset(options: ResetOptions) {
  const project = options.project?.trim();
  if (!project) throw new Error("--project <slug-or-id> is required.");

  // Match the deployment's seed exactly. On prd these env vars are unset, so
  // the template ships its canonical `@main` specs; preview passes the
  // PR-head ref, local dev its tarball overrides. An explicit `--pkg-ref`
  // overrides the deployment ref.
  const pkgRef =
    options.pkgRef?.trim() || process.env.APP_CONFIG_ITERATE_REPO_PKG_REF?.trim() || undefined;
  const templateFiles = projectRepoSeedFiles({
    iterateRepoPkgRef: pkgRef,
    iterateRepoPkgSpecOverrides: parseIterateRepoPkgSpecOverridesEnv(
      process.env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES,
    ),
  });
  const templatePaths = new Set(templateFiles.map((file) => file.path));

  const connection = adminConnection(options);
  using session = connectItx(connection);
  const repo = session.projects.get(project).repo;

  // Everything the project currently has under /repos/config. Anything not in
  // the template is scheduled for deletion so the tree ends up byte-for-byte
  // the template, not a union of old and new files.
  const { commitOid, paths: currentPaths } = await repo.listFiles();
  const deletes = currentPaths
    .filter((path) => !templatePaths.has(path))
    .map((path) => ({ path, delete: true as const }));
  const writes = templateFiles.map(({ path, content }) => ({ path, content }));
  const changes = [...writes, ...deletes];

  const plan = {
    project,
    fromCommit: commitOid,
    pkgRef: pkgRef || "(template default: @main)",
    writes: writes.length,
    deletes: deletes.map((change) => change.path),
  };

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, ...plan }, null, 2)}\n`);
    process.exit(0);
  }

  const result = await repo.commitFiles({
    message: options.message?.trim() || "Reset config repo to template",
    changes,
  });

  process.stdout.write(`${JSON.stringify({ ...plan, result }, null, 2)}\n`);

  // The Cap'n Web WebSocket would otherwise keep the process alive.
  process.exit(0);
}

// Same admin-secret connection every CLI itx command builds: the secret stays
// in this Node process and authenticates to the deployment's `/api` surface.
function adminConnection(options: { baseUrl?: string }) {
  const baseUrl =
    options.baseUrl?.trim() ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readDevServerInfo(new URL("..", import.meta.url).pathname, {
      requireLive: true,
    })?.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");
  return {
    auth: { type: "admin-secret" as const, secret },
    baseUrl,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  };
}
