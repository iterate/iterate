// github-sync/install.ts — how a project installs the sync: from a folder of its config repo that
// pins this package (`githubSyncFolder`), as the agents app installs (@iterate-com/agents/install).
// `installGithubSync` mounts it on the two logs whose events trigger it, which only a session may do
// (README.md). Nothing here is the runtime.
import type { IterateContextApi } from "iterate/api";
import { githubRepositoryOf } from "./github-repository.ts";

/** The source a project installs the sync from, by file: `version` is what package.json pins (a
 *  pkg.pr.new URL, or an npm range once the package is on npm). */
export function githubSyncFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "index.ts", dependencies: { "@iterate-com/github-sync": version } }, null, 2)}\n`,
    "index.ts": 'export { GithubSyncDurableObject } from "@iterate-com/github-sync";\n',
  };
}

/** Mount the sync from its source (`githubSyncFolder`, as `repo.modules({ dir })` answers it) for
 *  `repo` (default `/repos/config`), whose origin must be its GitHub repository (the Dash's Config
 *  repo links it), through `connection`: by default the project's one GitHub connection to the
 *  repository's owner. Installing the same source again changes nothing but a new marker; a new
 *  source is an upgrade. */
export async function installGithubSync(
  itx: Pick<IterateContextApi, "whoami" | "append" | "cd" | "facets" | "repos" | "processors">,
  source: Record<string, string>,
  options: { repo?: string; connection?: string } = {},
): Promise<{ repo: string; repository: string; connection: string }> {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install the GitHub sync at the project root");
  const repo = options.repo || "/repos/config";
  const repository = githubRepositoryOf(await itx.repos.get(repo).origin());
  if (!repository)
    throw new Error(
      `${repo} has no GitHub origin: link it to its repository first (the Dash's Config repo)`,
    );
  const owner = repository.split("/")[0]!;
  const connection = options.connection || (await githubConnectionTo(itx, owner));
  const log = itx.cd(`/integrations/github/${connection}`);
  // The connection's log reaches only itself: these rows lend it the root's repos, where `repo` is,
  // and the root's egress, which a pull's git exchange goes through (the connection's token is a
  // root secret).
  for (const root of ["repos", "fetch"]) {
    const match = `itx.${root}`;
    const target = `itx.builtins.cd('/').${root}`;
    if ((await log.rewriteRules.get(match))?.target !== target)
      await log.append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match, target },
      });
  }
  const spec = { source, className: "GithubSyncDurableObject" };
  await log.processors.enable("github-sync", {
    ...spec,
    consumes: ["events.iterate.com/github/webhook-received", "github-sync/installed"],
  });
  await itx.processors.enable("github-sync", {
    ...spec,
    consumes: ["events.iterate.com/repo/commit-completed", "github-sync/installed"],
  });
  // What each syncs starts here: the logs' history before the markers is never synced.
  const installed = { type: "github-sync/installed", payload: { repo } };
  await Promise.all([log.append(installed), itx.append(installed)]);
  return { repo, repository, connection };
}

/** The project's connections, as its root's `project` facet records them (core/os
 *  src/integrations/contract.ts `IntegrationConnectionRow`). */
type ProjectIntegrations = {
  snapshot(): Promise<{
    state: {
      integrations: Record<string, { provider: string; connection: string; account: string }>;
    };
  }>;
};

/** The project's one GitHub connection to `owner` (a login's case does not matter to GitHub). */
async function githubConnectionTo(itx: Pick<IterateContextApi, "facets">, owner: string) {
  const { state } = await itx.facets.get<ProjectIntegrations>("project").snapshot();
  const rows = Object.values(state.integrations).filter(
    (row) => row.provider === "github" && row.account.toLowerCase() === owner.toLowerCase(),
  );
  if (rows.length !== 1)
    throw new Error(
      `expected one GitHub connection to ${owner}, found ${rows.length}: name one with { connection }`,
    );
  return rows[0]!.connection;
}
