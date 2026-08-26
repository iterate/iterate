import type { ConfigRepoTemplateReference } from "../../lib/config-repo-template-reference.ts";
import { formatConfigRepoTemplateReference } from "../../lib/config-repo-template-reference.ts";
import { CONFIG_REPO_TEMPLATE_CATALOG } from "./config-repo-template-catalog.generated.ts";
import { repointPackageJsonDependencies } from "./project-repo-seed.ts";
import type { RepoCreateRequest } from "./repo-processor-contract.ts";
import type { RepoFileChange } from "./types.ts";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** What `repo.syncFromTemplate` returns. */
export type TemplateSyncResult = {
  /** The branch head after the sync — a fresh commit, or the unchanged head. */
  commitOid: string;
  /** Paths committed from the template (adds, updates, and deletes). */
  updated: string[];
  /** Both-changed paths left untouched — the template moved AND the repo's
   * copy differs from the template content at the last sync. */
  skipped: string[];
  /** The template revision this sync read. */
  templateCommitOid: string;
  /** Present (true) when nothing needed updating and nothing was skipped. */
  upToDate?: boolean;
};

/**
 * The template a repo can sync against, derived from its durable creation
 * request. `github-public-template` is the recorded picker choice;
 * `empty` maps to the reference the picker's "Default" option sends, because
 * the embedded seed IS that template folder. A pinned commit-SHA ref (how
 * preview deployments pin templates at creation) is stripped so "latest"
 * resolves to the template repository's default-branch HEAD. Import-created
 * repos have no template: their content authority is the imported repository.
 */
export function templateReferenceForCreateRequest(
  createRequest: RepoCreateRequest | null,
): ConfigRepoTemplateReference {
  if (createRequest === null) {
    throw new Error("This repo has no creation request yet — nothing to sync from.");
  }
  if (createRequest.type === "empty") return defaultConfigRepoTemplateReference();
  if (createRequest.type !== "github-public-template") {
    throw new Error(
      `This repo was created by a "${createRequest.type}" import, not from a template — ` +
        "sync it against its source repository instead (syncFromGithub).",
    );
  }
  const { owner, repo, path, ref } = createRequest;
  return {
    owner,
    repo,
    ...(path === undefined ? {} : { path }),
    ...(ref === undefined || COMMIT_SHA_PATTERN.test(ref) ? {} : { ref }),
  };
}

/** The GitHub reference behind the template picker's "Default" option. */
function defaultConfigRepoTemplateReference(): ConfigRepoTemplateReference {
  const defaultEntry = CONFIG_REPO_TEMPLATE_CATALOG.find((entry) => entry.label === "Default");
  if (defaultEntry === undefined) {
    throw new Error("The config repo template catalog has no Default entry.");
  }
  return { owner: "iterate", repo: "iterate", path: defaultEntry.path };
}

/**
 * The per-file three-way plan: for every path the template (base or latest)
 * mentions, compare the template's change against the user's. No line-level
 * merging — a file either moves to the latest template content wholesale or
 * stays the user's.
 */
export function planTemplateSync(input: {
  /** Template content at the last sync (or the seed/root commit). */
  base: Record<string, string>;
  /** Latest template content. */
  latest: Record<string, string>;
  /** Current branch-head content for the paths under consideration. */
  head: Record<string, string>;
}): { changes: RepoFileChange[]; updated: string[]; skipped: string[] } {
  const paths = [...new Set([...Object.keys(input.base), ...Object.keys(input.latest)])].sort();
  const changes: RepoFileChange[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const base = input.base[path];
    const latest = input.latest[path];
    const head = input.head[path];
    if (latest === base) continue; // template unchanged — the user's copy stands
    if (latest === head) continue; // repo already carries the latest template content
    if (head !== base) {
      skipped.push(path);
      continue;
    }
    updated.push(path);
    changes.push(latest === undefined ? { path, delete: true } : { path, content: latest });
  }
  return { changes, updated, skipped };
}

/** The exact repo reads/writes `runTemplateSync` performs, injectable so the
 * sync specs drive an in-memory repo instead of Cloudflare Artifacts. */
export type TemplateSyncDeps = {
  /** Fetch one template revision (ref absent = the default branch HEAD). */
  downloadTemplate: (
    reference: ConfigRepoTemplateReference,
  ) => Promise<{ commitOid: string; files: Array<{ content: string; path: string }> }>;
  /** The deployment's pkg.pr.new knobs, re-applied to every fetched template
   * revision so GitHub content diffs cleanly against the substituted seed. */
  repointConfig: {
    iterateRepoPkgRef?: string;
    iterateRepoPkgSpecOverrides?: Record<string, string>;
  };
  /** The seed/root commit's file contents — the base before any recorded sync. */
  readRootCommitFiles: () => Promise<Record<string, string>>;
  /** Current branch-head content for the given paths (absent paths omitted). */
  readHeadFiles: (paths: string[]) => Promise<{ commitOid: string; files: Record<string, string> }>;
  /** Commit the plan's changes as one normal default-branch commit. */
  commitChanges: (input: {
    changes: RepoFileChange[];
    message: string;
  }) => Promise<{ commitOid: string }>;
  /** Record the template revision as the next sync's base. */
  appendTemplateSynced: (payload: { templateCommitOid: string }) => Promise<void>;
};

/**
 * Reconcile a repo against its template: three-way per file against the
 * template content at the last sync, one normal commit for the adoptable
 * changes, both-changed files skipped and reported. `repo/template-synced`
 * advances the base to the revision this run read, commit or not — each
 * run's report is "what the template changed since the last sync", so a
 * skipped file is reported once per template change instead of on every
 * click (and is never auto-updated again until the template moves).
 */
export async function runTemplateSync(
  input: {
    reference: ConfigRepoTemplateReference;
    /** The last recorded `repo/template-synced` base, or null before any sync. */
    baseTemplateCommitOid: string | null;
  },
  deps: TemplateSyncDeps,
): Promise<TemplateSyncResult> {
  const latest = await deps.downloadTemplate(input.reference);
  const latestFiles = substitutedFileMap(latest.files, deps.repointConfig);
  const base =
    input.baseTemplateCommitOid === null
      ? await deps.readRootCommitFiles()
      : input.baseTemplateCommitOid === latest.commitOid
        ? latestFiles
        : substitutedFileMap(
            (await deps.downloadTemplate({ ...input.reference, ref: input.baseTemplateCommitOid }))
              .files,
            deps.repointConfig,
          );

  const paths = [...new Set([...Object.keys(base), ...Object.keys(latestFiles)])];
  const head = await deps.readHeadFiles(paths);
  const plan = planTemplateSync({ base, latest: latestFiles, head: head.files });

  // The subject carries the human-readable provenance; the git trailers
  // carry the machine-readable identity, so "which template revision is this
  // commit from" survives in plain git history (mirrors, clones, re-imports)
  // independent of the stream's own template-synced fact.
  const reference = formatConfigRepoTemplateReference(input.reference);
  const committed =
    plan.changes.length > 0
      ? await deps.commitChanges({
          changes: plan.changes,
          message:
            `Sync from template ${reference} @ ${latest.commitOid.slice(0, 7)}\n\n` +
            `Template-Reference: ${reference}\n` +
            `Template-Commit: ${latest.commitOid}`,
        })
      : null;
  if (input.baseTemplateCommitOid !== latest.commitOid) {
    await deps.appendTemplateSynced({ templateCommitOid: latest.commitOid });
  }
  return {
    commitOid: committed === null ? head.commitOid : committed.commitOid,
    updated: plan.updated,
    skipped: plan.skipped,
    templateCommitOid: latest.commitOid,
    ...(committed === null && plan.skipped.length === 0 && { upToDate: true }),
  };
}

function substitutedFileMap(
  files: Array<{ content: string; path: string }>,
  repointConfig: TemplateSyncDeps["repointConfig"],
): Record<string, string> {
  const repointed = repointPackageJsonDependencies(files, repointConfig).files;
  return Object.fromEntries(repointed.map((file) => [file.path, file.content]));
}
