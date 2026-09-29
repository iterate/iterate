// install.ts — what a config repo's init case calls (README.md), and the Agents app's upgrade of
// the build the config pins. Not the runtime, so importing it loads none.
import type {} from "./api.ts"; // registers `itx.agents` on InstalledAppRoots
import type { FacetSpec, IterateContextApi, RepoHandle } from "iterate/api";
import { z } from "zod";

/** One of the app's facets: `className` from `agents.ts` of the project's published config. */
export function agentsFacetSpec(
  className: "AgentCollectionDurableObject" | "AgentDurableObject",
): FacetSpec {
  return { className, mainModule: "agents.ts", source: ["itx", ["cd", "/"], "config"] };
}

/** Idempotent: enabling the row again appends nothing, and the rule is written back if removed. */
export async function installAgents(
  itx: Pick<IterateContextApi, "append"> & {
    processors: Pick<IterateContextApi["processors"], "enable">;
  },
) {
  const spec = agentsFacetSpec("AgentCollectionDurableObject");
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

/** The part of a config repo's root package.json an upgrade reads and rewrites; every other field
 *  is carried through untouched. */
const RootManifest = z.object({ dependencies: z.record(z.string(), z.string()).optional() });

/** The `@iterate-com/agents` a root package.json's `text` lists among its dependencies: undefined
 *  for none, no file, or one that is not a package.json. */
function agentsPinIn(text: string | null): string | undefined {
  try {
    return RootManifest.parse(JSON.parse(text || "{}")).dependencies?.["@iterate-com/agents"];
  } catch {
    return undefined;
  }
}

/** The build of the agents app the project RUNS: what the root package.json pins at the commit of
 *  `/repos/config` the platform last published (the `project` facet's `publishedCommit`), which
 *  `agents.ts` re-exports — never the tip's while an upgrade's publication is owed or after it was
 *  refused. Undefined before the first publication, or when that commit pins no such package. */
export async function agentsVersion(project: {
  facets: {
    get(name: "project"): { snapshot(): Promise<{ state: { publishedCommit: string | null } }> };
  };
  repos: { get(path: string): Pick<RepoHandle, "readFile"> };
}): Promise<string | undefined> {
  const { state } = await project.facets.get("project").snapshot();
  if (!state.publishedCommit) return undefined;
  const repo = project.repos.get("/repos/config");
  return agentsPinIn(await repo.readFile("package.json", { commitOid: state.publishedCommit }));
}

/**
 * AN UPGRADE of the project's agents to `version`: the root package.json's pin, committed on the tip
 * it read (refused if main moved meanwhile; a file already so commits nothing, and the tip's outcome
 * answers), then that commit's outcome on `/`, past any give-up for now (`unavailable`), which
 * leaves it owed. Published, every agent's call from 5 s on loads the new build (`agentsFacetSpec`);
 * refused, main moving on included, it throws why and the person upgrades again. Answers the
 * commit.
 */
export async function upgradeAgents(
  project: Pick<IterateContextApi, "waitForEvent"> & {
    repos: { get(path: string): Pick<RepoHandle, "tip" | "readFile" | "commitFiles"> };
  },
  version: string,
) {
  const repo = project.repos.get("/repos/config");
  const tip = await repo.tip();
  const manifest: Record<string, unknown> = JSON.parse(
    (await repo.readFile("package.json")) || "{}",
  );
  // the pin set in place: every other field and dependency keeps its value and its order
  const { dependencies } = RootManifest.parse(manifest);
  manifest.dependencies = { ...dependencies, "@iterate-com/agents": version };
  const { commitOid } = await repo.commitFiles({
    message: `Upgrade @iterate-com/agents to ${version}`,
    parent: tip,
    changes: [{ path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` }],
  });
  // one deadline for the whole wait: a give-up for now does not restart it
  const deadline = Date.now() + 120_000;
  for (let afterOffset = 0; ;) {
    const outcome = await project.waitForEvent({
      type: [
        "events.iterate.com/project/worker-updated",
        "events.iterate.com/project/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (outcome.type === "events.iterate.com/project/worker-updated") return commitOid;
    if (!outcome.payload?.unavailable)
      throw new Error(`The upgrade was not published: ${String(outcome.payload?.error)}`);
    // the platform gave up for now and still owes the commit: its outcome comes after this one
    afterOffset = outcome.offset;
  }
}
