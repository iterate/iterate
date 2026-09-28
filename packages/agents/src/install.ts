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

/** A config repo's root package.json once it lists an installed app's package `name` at `version`
 *  as a devDependency, or `undefined` when there is nothing to change. The app's folder pins what
 *  the loader resolves; the root lists it too because `tsc` over the whole repo resolves the folder's
 *  imports from the root's `node_modules`. A root that depends on the package at runtime (the
 *  with-agents template's worker imports the installer) keeps its own pin. */
export function rootManifestListing(
  manifest: string | null,
  name: string,
  version: string,
): string | undefined {
  const parsed = JSON.parse(manifest || "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (parsed.dependencies?.[name] || parsed.devDependencies?.[name] === version) return undefined;
  const devDependencies = Object.fromEntries(
    Object.entries({ ...parsed.devDependencies, [name]: version }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  return `${JSON.stringify({ ...parsed, devDependencies }, null, 2)}\n`;
}

/** An app the config repo holds as a folder of its own: its files (`agentsFolder`, …) under `dir`,
 *  and the package the root manifest lists at `version`. */
export type AppFolder = {
  dir: string;
  folder: Record<string, string>;
  packageName: string;
  version: string;
};

/** THE CONFIG REPO'S PART OF AN INSTALL: one read of `main`, then at most ONE commit — each folder
 *  the repo lacks (no `<dir>/package.json`), and the root package.json listing its package
 *  (`rootManifestListing`); a folder the repo has is kept as it is, its listing too. Answers the
 *  commit to read the apps' sources at (`repo.modules({ dir, commitOid })`): the new one, or the tip
 *  that was read. Every read and write of `main` is a git exchange with Artifacts, the slowest calls
 *  an install makes, so installing two apps reads and commits once, not once per app. */
export async function commitAppFolders(
  repo: Pick<RepoHandle, "listFiles" | "readFile" | "commitFiles">,
  apps: AppFolder[],
) {
  const { commitOid: tip, paths } = await repo.listFiles();
  const missing = apps.filter((app) => !paths.includes(`${app.dir}/package.json`));
  if (!missing.length) return tip || undefined;
  const before =
    tip && paths.includes("package.json")
      ? await repo.readFile("package.json", { commitOid: tip })
      : null;
  let manifest = before;
  for (const app of missing)
    manifest = rootManifestListing(manifest, app.packageName, app.version) ?? manifest;
  const { commitOid } = await repo.commitFiles({
    message: `Install ${missing.map((app) => app.packageName).join(" and ")}`,
    changes: [
      ...missing.flatMap((app) =>
        Object.entries(app.folder).map(([name, content]) => ({
          path: `${app.dir}/${name}`,
          content,
        })),
      ),
      ...(manifest && manifest !== before ? [{ path: "package.json", content: manifest }] : []),
    ],
  });
  return commitOid || undefined;
}

/** The agents app as `commitAppFolders` commits it, pinning `version`. */
export const agentsApp = (version: string) => ({
  dir: "agents",
  folder: agentsFolder(version),
  packageName: "@iterate-com/agents",
  version,
});

/** Mount the app in a project root from its source: a folder's files by name, as
 *  `repo.modules({ dir })` answers them (`agentsFolder`, or any source whose entry exports the two
 *  classes) — the runtime every agent's facet loads, the `agents` processor on `/` and the
 *  `itx.agents` rule, without loading it. `installAgents` is this and then `upgradeAgents`. */
export async function publishAgents(itx: InstallTarget, source: Record<string, string>) {
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
}

/** Rebind every agent to the runtime the project has mounted: its first call, so it loads the app
 *  (the loader resolves its packages, from esm.sh the first time a dependency set is seen). */
export async function upgradeAgents(itx: Pick<IterateContextApi, "invoke">) {
  await itx.invoke(["itx", "agents", ["upgrade"]]);
}

/** Install the app into a project root from its source (`publishAgents`), then rebind every agent to
 *  it. Installing the same source again changes nothing; a new source is an upgrade. */
export async function installAgents(itx: InstallTarget, source: Record<string, string>) {
  await publishAgents(itx, source);
  await upgradeAgents(itx);
}

/** A project created a moment ago may still be seeding its config repo: the project's creation
 *  creates it and commits the seed onto an unborn `main`, so a commit here first would refuse the
 *  seed. Resolves once creation has settled (at once for a project created earlier). */
export async function configRepoSettled(project: Pick<IterateContextApi, "waitForEvent">) {
  const settled = await project.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  if (settled.type !== "events.iterate.com/project/created")
    throw new Error("The project's creation failed, so there is no config repo to install into");
}

/** A project without `itx.agents` gets the app: the config repo's `agents/` folder as it is, or
 *  `agentsFolder(version)` committed there first when the repo has none (`commitAppFolders`), then
 *  installed. A project that has the rule keeps its own. */
export async function ensureAgents(
  project: InstallTarget & {
    rewriteRules: Pick<IterateContextApi["rewriteRules"], "get">;
    repos: {
      get(path: string): Pick<RepoHandle, "listFiles" | "readFile" | "commitFiles" | "modules">;
    };
    waitForEvent: IterateContextApi["waitForEvent"];
  },
  version: string,
) {
  if ((await project.rewriteRules.get("itx.agents"))?.target) return;
  await configRepoSettled(project);
  const repo = project.repos.get("/repos/config");
  const commitOid = await commitAppFolders(repo, [agentsApp(version)]);
  await installAgents(project, await repo.modules({ dir: "agents", commitOid }));
}
