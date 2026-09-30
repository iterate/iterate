// ai-linter/install.ts — how a project installs the linter: from a folder of its config repo that pins
// this package (`aiLinterFolder`), as the agents app installs (@iterate-com/agents/install).
// `installAiLinter` mounts it on the log of the GitHub connection that reaches the repository, which
// only a session may do (README.md). Nothing here is the runtime.
import type { IterateContextApi } from "iterate/api";

/** The source a project installs the linter from, by file: `version` is what package.json pins (a
 *  pkg.pr.new URL, or an npm range once the package is on npm). */
export function aiLinterFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "index.ts", dependencies: { "@iterate-com/ai-linter": version } }, null, 2)}\n`,
    "index.ts": 'export { AiLinterDurableObject } from "@iterate-com/ai-linter";\n',
  };
}

/** Mount the linter from its source (`aiLinterFolder`, as `repo.modules({ dir })` answers it) for the
 *  pull requests of `repository` (`owner/name`), against its `rules` folder (default `rules`), the
 *  LLM being `model` (default run.ts's), through `connection`: by default the project's one GitHub
 *  connection to the repository's owner. Each install appends its choices as the latest
 *  `ai-linter/installed`; the same source again changes nothing else, and a new source is an
 *  upgrade. */
export async function installAiLinter(
  itx: Pick<IterateContextApi, "whoami" | "cd" | "facets">,
  source: Record<string, string>,
  options: { repository: string; rules?: string; model?: string; connection?: string },
): Promise<{ repository: string; connection: string }> {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install the AI linter at the project root");
  const { repository, rules, model } = options;
  const owner = /^([^/\s]+)\/[^/\s]+$/.exec(repository)?.[1];
  if (!owner) throw new Error(`${repository} is not a GitHub repository's owner/name`);
  const connection = options.connection || (await githubConnectionTo(itx, owner));
  const log = itx.cd(`/integrations/github/${connection}`);
  // The connection's log reaches only itself: these rows lend it the root's egress (the connection's
  // token is a root secret) and the root's model.
  for (const root of ["fetch", "ai"]) {
    const match = `itx.${root}`;
    const target = `itx.builtins.cd('/').${root}`;
    if ((await log.rewriteRules.get(match))?.target !== target)
      await log.append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match, target },
      });
  }
  await log.processors.enable("ai-linter", {
    source,
    className: "AiLinterDurableObject",
    consumes: [
      "events.iterate.com/github/webhook-received",
      "ai-linter/installed",
      "ai-linter/linted",
    ],
  });
  // What it lints starts here: the log's history before the first marker is never linted.
  await log.append({
    type: "ai-linter/installed",
    payload: { repository, rules, model },
  });
  return { repository, connection };
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
