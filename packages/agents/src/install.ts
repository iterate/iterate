// install.ts — how a project installs the agents app. The app is a SOURCE the project owns: a folder
// of its config repo (`agents/` by convention) holding a package.json that pins this package and an
// index.ts that re-exports its two Durable Object classes (`agentsFolder`). `installAgents` mounts
// that source: the collection facet as the `itx.agents` rewrite rule, the `agents` processor on `/`,
// and the same source for every agent's facet. Nothing here is the runtime, so a config worker
// imports `@iterate-com/agents/install` without loading it.
import type { IterateContextApi, RepoHandle } from "iterate/api";

/** What `installAgents` needs of the project's root. */
type InstallTarget = Pick<IterateContextApi, "whoami" | "append" | "invoke"> & {
  kv: Pick<IterateContextApi["kv"], "put">;
  processors: Pick<IterateContextApi["processors"], "enable">;
};

/** A pkg.pr.new build of a package in this repository: `ref` is a commit, a PR number or `main`. */
export const pkgPrNewVersion = (name: string, ref: string) =>
  `https://pkg.pr.new/iterate/iterate/${name}@${ref}`;

/** The build of package `name` an app installs: its own commit's when pkg.pr.new has published it
 *  (every main commit, and a PR head that changed the package), else main's. */
export async function publishedVersion(name: string, commit: string | undefined) {
  if (commit) {
    const version = pkgPrNewVersion(name, commit);
    if ((await fetch(version, { method: "HEAD" })).ok) return version;
  }
  return pkgPrNewVersion(name, "main");
}

/** The source a project installs the agents app from, by file: `version` is what package.json pins
 *  (a pkg.pr.new URL, or an npm range once the package is on npm). */
export function agentsFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ dependencies: { "@iterate-com/agents": version } }, null, 2)}\n`,
    "index.ts":
      'export { AgentCollectionDurableObject, AgentDurableObject } from "@iterate-com/agents";\n',
  };
}

/** Install the app into a project root from its source: a folder's files by name, as
 *  `repo.modules({ dir })` answers them (`agentsFolder`, or any source whose entry exports the two
 *  classes). Installing the same source again changes nothing; a new source is an upgrade, and every
 *  agent is rebound to it. */
export async function installAgents(itx: InstallTarget, source: Record<string, string>) {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install agents at the project root");
  // The runtime's name is its content hash: every facet it hosts names it (a processor row shows
  // which runtime an agent runs), and an upgrade is a new name.
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((name) => [name, source[name]]),
    ),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const cacheKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await itx.kv.put("agents/runtime", JSON.stringify({ cacheKey, source }));
  const spec = { cacheKey, source, className: "AgentCollectionDurableObject" };
  await itx.processors.enable("agents", {
    ...spec,
    consumes: ["events.iterate.com/agent/created", "events.iterate.com/agent/deleted"],
  });
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.agents",
      target: ["itx", "facets", ["get", "agents", spec]],
      description:
        "The project's installed agents app: list(), create(path), get(path).message(text), delete(path)",
    },
  });
  await itx.invoke(["itx", "agents", ["upgrade"]]);
}

/** A project without `itx.agents` gets the app: the config repo's `agents/` folder as it is, or
 *  `agentsFolder(version)` committed there first when the repo has none, then installed. A project
 *  that has the rule keeps its own. */
export async function ensureAgents(
  project: InstallTarget & {
    rewriteRules: Pick<IterateContextApi["rewriteRules"], "get">;
    repos: { get(path: string): Pick<RepoHandle, "readFile" | "commitFiles" | "modules"> };
    waitForEvent: IterateContextApi["waitForEvent"];
  },
  version: string,
) {
  if ((await project.rewriteRules.get("itx.agents"))?.target) return;
  // A project created a moment ago may still be seeding its config repo: the project's creation
  // creates it and commits the seed onto an unborn `main`, so a commit here first would refuse the
  // seed. Install once creation has settled (at once for a project created earlier).
  const settled = await project.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  if (settled.type !== "events.iterate.com/project/created")
    throw new Error("The project's creation failed, so there is no config repo to install into");
  const repo = project.repos.get("/repos/config");
  const commit = (await repo.readFile("agents/package.json"))
    ? undefined
    : await repo.commitFiles({
        message: "Install the agents app",
        changes: Object.entries(agentsFolder(version)).map(([name, content]) => ({
          path: `agents/${name}`,
          content,
        })),
      });
  // No commitOid (nothing committed, or a commit that changed nothing) reads the tip.
  const commitOid = commit?.commitOid ?? undefined;
  await installAgents(project, await repo.modules({ dir: "agents", commitOid }));
}
