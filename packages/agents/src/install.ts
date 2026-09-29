// install.ts — how a project installs the agents app. The app is a SOURCE the project owns: a folder
// of its config repo (`agents/` by convention) holding a package.json that pins this package and names
// its `main`, index.ts, which re-exports the two Durable Object classes (`agentsFolder`). `installAgents` mounts
// that source: the collection facet as the `itx.agents` rewrite rule, the `agents` processor on `/`,
// and the same source for every agent's facet. An upgrade (`upgradeApp`) commits the folder at a
// newer build and installs it again. Nothing here is the runtime, so a config worker imports
// `@iterate-com/agents/install` without loading it.
import type { IterateContextApi, RepoHandle } from "iterate/api";
import { errorCode } from "iterate/lib";
import { z } from "zod";

/** What `installAgents` needs of the project's root. */
type InstallTarget = Pick<IterateContextApi, "whoami" | "append" | "invoke"> & {
  kv: Pick<IterateContextApi["kv"], "put">;
  processors: Pick<IterateContextApi["processors"], "enable">;
};

/** The source a project installs the agents app from, by file: `version` is what package.json pins,
 *  a pkg.pr.new URL at a full commit (the loader refuses a branch; the apps pin theirs with
 *  @iterate-com/shared/pkg-pr-new `publishedCommit`). */
export function agentsFolder(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "index.ts", dependencies: { "@iterate-com/agents": version } }, null, 2)}\n`,
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

/** An app the config repo holds as a folder of its own: `dir`, the folder; `folder(version)`, its
 *  files pinning that version of `packageName` (`agentsFolder`, …), which the root manifest lists
 *  too; `runtimeKey`, the project KV key its install keeps the mounted source under. */
export type App = {
  dir: string;
  packageName: string;
  folder: (version: string) => Record<string, string>;
  runtimeKey: string;
};

/** The agents app: `agents/`, mounted by `publishAgents`. */
export const agentsApp: App = {
  dir: "agents",
  packageName: "@iterate-com/agents",
  folder: agentsFolder,
  runtimeKey: "agents/runtime",
};

/** An app at the version of its package a commit pins. */
type AppAt = { app: App; version: string };

/** The config repo's part of an install or an upgrade: what it reads and commits. */
type ConfigRepo = Pick<RepoHandle, "listFiles" | "readFile" | "commitFiles">;

/** THE CONFIG REPO'S PART OF AN INSTALL: one read of `main`, then at most ONE commit (`commitApps`)
 *  — each folder the repo lacks (no `<dir>/package.json`), and the root package.json listing its
 *  package; a folder the repo has is kept as it is, its listing too. Answers the commit to read the
 *  apps' sources at (`repo.modules({ dir, commitOid })`): the new one, or the tip that was read.
 *  Every read and write of `main` is a git exchange with Artifacts, the slowest calls an install
 *  makes, so installing two apps reads and commits once, not once per app. */
export async function commitAppFolders(repo: ConfigRepo, apps: AppAt[]) {
  const main = await repo.listFiles();
  const missing = apps.filter(({ app }) => !main.paths.includes(`${app.dir}/package.json`));
  if (!missing.length) return main.commitOid || undefined;
  return commitApps(
    repo,
    main,
    missing,
    `Install ${missing.map(({ app }) => app.packageName).join(" and ")}`,
  );
}

/** ONE COMMIT on `main` as it was read, refused if it moved since: each app's folder files as
 *  `app.folder(version)` has them (any other file under `dir` is kept), and the root package.json
 *  listing each package (`rootManifestListing`). Answers the commit to read the folders at: the new
 *  one, or the tip when the repo held all of it already. */
async function commitApps(
  repo: ConfigRepo,
  main: Awaited<ReturnType<ConfigRepo["listFiles"]>>,
  apps: AppAt[],
  message: string,
) {
  const { commitOid: tip, paths } = main;
  const before =
    tip && paths.includes("package.json")
      ? await repo.readFile("package.json", { commitOid: tip })
      : null;
  let manifest = before;
  for (const { app, version } of apps)
    manifest = rootManifestListing(manifest, app.packageName, version) ?? manifest;
  const { commitOid } = await repo.commitFiles({
    message,
    parent: tip,
    changes: [
      ...apps.flatMap(({ app, version }) =>
        Object.entries(app.folder(version)).map(([name, content]) => ({
          path: `${app.dir}/${name}`,
          content,
        })),
      ),
      ...(manifest && manifest !== before ? [{ path: "package.json", content: manifest }] : []),
    ],
  });
  return commitOid || undefined;
}

/** What an install keeps under `App.runtimeKey`: the source it mounted and that source's hash. */
const InstalledRuntime = z.object({
  cacheKey: z.string(),
  source: z.record(z.string(), z.string()),
});

/** The part of a source's package.json `installedVersion` reads. */
const SourceManifest = z.object({ dependencies: z.record(z.string(), z.string()) });

/** The version of `app.packageName` the project runs: what the package.json of the source its
 *  install keeps (`app.runtimeKey`) pins. Undefined when the app is not installed, or its source
 *  pins no such package (a bundled source, a package.json that is not JSON). */
export async function installedVersion(
  project: { kv: Pick<IterateContextApi["kv"], "get"> },
  app: Pick<App, "packageName" | "runtimeKey">,
) {
  const stored = await project.kv.get(app.runtimeKey);
  if (!stored) return undefined;
  const { source } = InstalledRuntime.parse(JSON.parse(stored));
  let manifest: unknown;
  try {
    manifest = JSON.parse(source["package.json"] ?? "");
  } catch {
    return undefined;
  }
  return SourceManifest.safeParse(manifest).data?.dependencies[app.packageName];
}

/**
 * AN UPGRADE of an installed app to `version`, a newer build of its package: `<dir>/` as
 * `app.folder(version)` has it, and the root's listing, in ONE commit on the tip it read
 * (`commitApps`, refused if main moved meanwhile), then `install` from that commit. Every file of
 * the folder is written, not only the pin: the entry re-exports the build's classes by name, so an
 * old entry under a new pin can fail to load. A folder already at `version` commits nothing and is
 * installed again, so upgrading after a failed install finishes it. Answers the commit installed.
 */
export async function upgradeApp(
  project: { repos: { get(path: string): ConfigRepo & Pick<RepoHandle, "modules"> } },
  app: App,
  version: string,
  install: (source: Record<string, string>) => Promise<unknown>,
) {
  const repo = project.repos.get("/repos/config");
  const commitOid = await commitApps(
    repo,
    await repo.listFiles(),
    [{ app, version }],
    `Upgrade ${app.packageName} to ${version}`,
  );
  try {
    await install(await repo.modules({ dir: app.dir, commitOid }));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${app.dir}/ pins the new build (config commit ${commitOid?.slice(0, 7)}), but installing it failed, so the project may still run the old one: ${why}. Upgrade again to install it.`,
      { cause: error },
    );
  }
  return commitOid;
}

/** An installed app's runtime name: the SHA-256 of its files as JSON, sorted by name. Every facet
 *  the runtime hosts names it (a processor row shows which runtime an agent runs), and an upgrade is
 *  a new name. */
export async function sourceCacheKey(source: Record<string, string>) {
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((name) => [name, source[name]]),
    ),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Mount the app in a project root from its source: a folder's files by name, as
 *  `repo.modules({ dir })` answers them (`agentsFolder`, or any source whose entry exports the two
 *  classes) — the runtime every agent's facet loads, the `agents` processor on `/` and the
 *  `itx.agents` rule, without loading it. `installAgents` is this and then `upgradeAgents`. */
export async function publishAgents(itx: InstallTarget, source: Record<string, string>) {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install agents at the project root");
  const cacheKey = await sourceCacheKey(source);
  await itx.kv.put(agentsApp.runtimeKey, JSON.stringify({ cacheKey, source }));
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

/** How long `configRepoSettled` waits for the project's creation in all. */
const PROJECT_CREATION_WAIT_MS = 60_000;
/** How long ONE call of that wait is held on the project's root before it is asked again on a
 *  fresh call, so an instance Cloudflare replaces under the wait costs one slice (apps/os
 *  project/collection.ts `TERMINAL_WAIT_SLICE_MS` says why). */
const PROJECT_CREATION_WAIT_SLICE_MS = 5_000;

/** A project created a moment ago may still be seeding its config repo: the project's creation
 *  creates it and commits the seed onto an unborn `main`, so a commit here first would refuse the
 *  seed. Resolves once creation has settled (at once for a project created earlier); a failed
 *  creation throws, saying why it failed. */
export async function configRepoSettled(project: Pick<IterateContextApi, "waitForEvent">) {
  const started = Date.now();
  for (;;) {
    const remainingMs = started + PROJECT_CREATION_WAIT_MS - Date.now();
    let settled: Awaited<ReturnType<IterateContextApi["waitForEvent"]>>;
    try {
      settled = await project.waitForEvent({
        type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
        afterOffset: 0,
        timeoutMs: Math.min(PROJECT_CREATION_WAIT_SLICE_MS, remainingMs),
      });
    } catch (error) {
      // the last slice's timeout is the whole wait's
      if (errorCode(error) !== "WAIT_TIMEOUT" || remainingMs <= PROJECT_CREATION_WAIT_SLICE_MS)
        throw error;
      continue;
    }
    if (settled.type !== "events.iterate.com/project/created")
      throw new Error(
        `The project's creation failed, so there is no config repo to install into: ${String(settled.payload?.error)}`,
      );
    return;
  }
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
  const commitOid = await commitAppFolders(repo, [{ app: agentsApp, version }]);
  await installAgents(project, await repo.modules({ dir: "agents", commitOid }));
}
