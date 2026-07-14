import type { ItxReactHandle } from "~/itx/itx-react.tsx";

/** How many 100-repo pages to pull from the installation before cutting off —
 * a picker, not a mirror of the whole org. */
const MAX_INSTALLATION_REPO_PAGES = 5;

export type InstallationRepo = {
  defaultBranch: string;
  fullName: string;
  name: string;
  owner: string;
  pushedAt: string | null;
};

/** The slice of GitHub's installation-repositories page the picker reads. */
type GithubInstallationReposPage = {
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

/**
 * Every repository the connection's GitHub App installation can see (its
 * "selected repositories" set — an unselected repo simply isn't in this list),
 * most recently pushed first. Uses the same Octokit surface exposed to agents:
 * `itx.integrations.github.get(connection).octokit.rest.apps.listReposAccessibleToInstallation`.
 * A GitHub failure is returned as data, not thrown: suspense callers would
 * otherwise take down a whole page instead of one picker panel.
 */
export async function listInstallationRepos(
  itx: ItxReactHandle,
  connection: string,
): Promise<{ error: string | null; repos: InstallationRepo[]; totalCount: number }> {
  const repos: InstallationRepo[] = [];
  let totalCount = 0;
  let error: string | null = null;
  for (let page = 1; page <= MAX_INSTALLATION_REPO_PAGES; page++) {
    let response: GithubInstallationReposPage;
    try {
      response = (await itx.integrations.github
        .get(connection)
        .octokit.rest.apps.listReposAccessibleToInstallation({
          page,
          per_page: 100,
        })) as GithubInstallationReposPage;
    } catch (caught) {
      // A later page's failure keeps what earlier pages returned: a partial
      // list with a warning beats discarding fetched repositories.
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
    totalCount = response.data.total_count;
    repos.push(
      ...response.data.repositories.map((repo) => ({
        defaultBranch: repo.default_branch,
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        pushedAt: repo.pushed_at,
      })),
    );
    if (response.data.repositories.length === 0 || repos.length >= totalCount) break;
  }
  repos.sort((left, right) => (right.pushedAt ?? "").localeCompare(left.pushedAt ?? ""));
  return { error, repos, totalCount: Math.max(totalCount, repos.length) };
}
