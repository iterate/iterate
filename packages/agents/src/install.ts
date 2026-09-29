// install.ts — what a config repo's init case calls (README.md), and the Agents app's upgrade of
// the build the config pins. Not the runtime, so importing it loads none.
import type { FacetSpec, IterateContextApi, RepoHandle } from "iterate/api";
import { errorCode } from "iterate/lib";

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
type RootManifest = { dependencies?: Record<string, string> };

/** How long an upgrade waits for its commit's publication in all: longer than the platform spends
 *  on one publication before it gives up for now (apps/os project/processor.ts
 *  `PUBLICATION_BUDGET_MS`). */
const PUBLICATION_WAIT_MS = 120_000;
/** How long ONE call of that wait is held on the project's root before it is asked again on a
 *  fresh call, so an instance Cloudflare replaces under the wait costs one slice (apps/os
 *  project/collection.ts `TERMINAL_WAIT_SLICE_MS` says why). */
const PUBLICATION_WAIT_SLICE_MS = 5_000;

/** The build of the agents app the project's config pins: `@iterate-com/agents` among the
 *  dependencies of the root package.json at `main`'s tip of `/repos/config`, which `agents.ts`
 *  re-exports and the project runs once that commit's publication has landed. Undefined when the
 *  config pins no such package, or its package.json is not JSON. */
export async function agentsVersion(project: {
  repos: { get(path: string): Pick<RepoHandle, "readFile"> };
}): Promise<string | undefined> {
  const text = await project.repos.get("/repos/config").readFile("package.json");
  try {
    return (JSON.parse(text || "{}") as RootManifest).dependencies?.["@iterate-com/agents"];
  } catch {
    return undefined;
  }
}

/**
 * AN UPGRADE of the project's agents to `version`, a newer build of `@iterate-com/agents`: the root
 * package.json's pin, in ONE commit on the tip it read (refused if `main` moved meanwhile), then
 * that commit's publication awaited — the platform moves `itx.config` to it, and every agent loads
 * the new build on its next call (`agentsFacetSpec`). A publication the platform refuses (the probe,
 * a module that does not resolve) throws why, with the pin committed. A config already at `version`
 * commits nothing. Answers the commit the project runs.
 */
export async function upgradeAgents(
  project: Pick<IterateContextApi, "readEvents" | "waitForEvent"> & {
    repos: { get(path: string): Pick<RepoHandle, "tip" | "readFile" | "commitFiles"> };
  },
  version: string,
): Promise<string> {
  const repo = project.repos.get("/repos/config");
  const tip = await repo.tip();
  if (!tip) throw new Error("The project's config repo has no commit to upgrade");
  const manifest = JSON.parse(
    (await repo.readFile("package.json", { commitOid: tip })) || "{}",
  ) as RootManifest;
  if (manifest.dependencies?.["@iterate-com/agents"] === version) return tip;
  // the head of `/` before the commit: its publication lands after it
  const { scannedThroughOffset } = await project.readEvents(Number.MAX_SAFE_INTEGER, 1);
  const { commitOid } = await repo.commitFiles({
    message: `Upgrade @iterate-com/agents to ${version}`,
    parent: tip,
    changes: [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            ...manifest,
            dependencies: { ...manifest.dependencies, "@iterate-com/agents": version },
          },
          null,
          2,
        )}\n`,
      },
    ],
  });
  if (!commitOid) throw new Error("The upgrade's commit left the config repo's main unborn");
  // every commit gets one outcome on `/`, found by its oid
  const started = Date.now();
  for (;;) {
    const remainingMs = started + PUBLICATION_WAIT_MS - Date.now();
    let outcome: Awaited<ReturnType<IterateContextApi["waitForEvent"]>>;
    try {
      outcome = await project.waitForEvent({
        type: [
          "events.iterate.com/project/worker-updated",
          "events.iterate.com/project/worker-update-failed",
        ],
        payload: { commitOid },
        afterOffset: scannedThroughOffset,
        timeoutMs: Math.max(0, Math.min(PUBLICATION_WAIT_SLICE_MS, remainingMs)),
      });
    } catch (error) {
      // the last slice's timeout is the whole wait's
      if (errorCode(error) !== "WAIT_TIMEOUT" || remainingMs <= PUBLICATION_WAIT_SLICE_MS)
        throw error;
      continue;
    }
    if (outcome.type === "events.iterate.com/project/worker-updated") return commitOid;
    throw new Error(
      `package.json pins the new build (config commit ${commitOid.slice(0, 7)}), but its publication failed, so the project still runs the old one: ${String(outcome.payload?.error)}`,
    );
  }
}
