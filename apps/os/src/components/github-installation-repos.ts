import type { Itx } from "~/itx/itx-react.tsx";

const MAX_PAGES = 5;

export type InstallationRepo = {
  defaultBranch: string;
  fullName: string;
  name: string;
  owner: string;
  pushedAt: string | null;
};

/** Builtin GitHub connection names. Never throws (shared suspense cache key). */
export async function listGithubConnections(itx: Itx): Promise<string[]> {
  try {
    const entries = await itx.integrations.list();
    return entries.flatMap((e) =>
      e.source === "builtin" && e.integration === "github" ? [e.connection] : [],
    );
  } catch (error) {
    console.error("listGithubConnections failed", error);
    return [];
  }
}

/** Repos the App installation can see, via Octokit. Errors returned as data. */
export async function listInstallationRepos(
  itx: Itx,
  connection: string,
): Promise<{ error: string | null; repos: InstallationRepo[]; totalCount: number }> {
  const repos: InstallationRepo[] = [];
  let totalCount = 0;
  let error: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const response = (await itx.integrations.github
        .get(connection)
        .octokit.rest.apps.listReposAccessibleToInstallation({ page, per_page: 100 })) as {
        data: {
          repositories: Array<{
            default_branch: string;
            full_name: string;
            name: string;
            owner: { login: string };
            pushed_at: string | null;
          }>;
          total_count: number;
        };
      };
      totalCount = response.data.total_count;
      repos.push(
        ...response.data.repositories.map((r) => ({
          defaultBranch: r.default_branch,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          pushedAt: r.pushed_at,
        })),
      );
      if (response.data.repositories.length === 0 || repos.length >= totalCount) break;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }
  repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return { error, repos, totalCount: Math.max(totalCount, repos.length) };
}
