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

/** How long an upgrade waits for its commit's outcome in all, from its start: longer than the
 *  platform spends on one publication before it gives up for now (apps/os project/processor.ts
 *  `PUBLICATION_BUDGET_MS`). */
const PUBLICATION_WAIT_MS = 120_000;
/** How long ONE call of that wait is held on the project's root before it is asked again on a
 *  fresh call, so an instance Cloudflare replaces under the wait costs one slice (apps/os
 *  project/collection.ts `TERMINAL_WAIT_SLICE_MS` says why). */
const PUBLICATION_WAIT_SLICE_MS = 5_000;

/** The `@iterate-com/agents` a root package.json's `text` lists among its dependencies: undefined
 *  for none, no file, or one that is not JSON. */
function agentsPinIn(text: string | null): string | undefined {
  try {
    return (JSON.parse(text || "{}") as RootManifest).dependencies?.["@iterate-com/agents"];
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
 * AN UPGRADE of the project's agents to `version`, a newer build of `@iterate-com/agents`: the root
 * package.json's pin, in ONE commit on the tip it read (refused if `main` moved meanwhile), or the
 * tip as it stands when it pins `version` already (an upgrade before, refused or still owed). Then
 * that commit's one outcome on `/`, waited for until two minutes from now: published, the platform
 * moved `itx.config` to it and every agent loads the new build on its next call
 * (`agentsFacetSpec`); refused (the probe, a module that does not resolve), it throws why, with the
 * pin committed. A commit main moved on from is followed to main's head, which holds the pin too:
 * main is linear. Answers the commit the project runs.
 */
export async function upgradeAgents(
  project: Pick<IterateContextApi, "readEvents" | "waitForEvent"> & {
    repos: { get(path: string): Pick<RepoHandle, "tip" | "readFile" | "commitFiles"> };
  },
  version: string,
): Promise<string> {
  const deadline = Date.now() + PUBLICATION_WAIT_MS;
  const repo = project.repos.get("/repos/config");
  let commitOid = await repo.tip();
  if (!commitOid) throw new Error("The project's config repo has no commit to upgrade");
  const text = await repo.readFile("package.json", { commitOid });
  // a tip that pins the build already: its outcome is in the root's history
  let afterOffset = 0;
  if (agentsPinIn(text) !== version) {
    // the head of `/` before the commit: its outcome lands after it
    ({ scannedThroughOffset: afterOffset } = await project.readEvents(Number.MAX_SAFE_INTEGER, 1));
    const manifest = JSON.parse(text || "{}") as RootManifest;
    (manifest.dependencies ||= {})["@iterate-com/agents"] = version;
    ({ commitOid } = await repo.commitFiles({
      message: `Upgrade @iterate-com/agents to ${version}`,
      parent: commitOid,
      changes: [{ path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` }],
    }));
    if (!commitOid) throw new Error("The upgrade's commit left the config repo's main unborn");
  }
  while (Date.now() < deadline) {
    const outcome = await project
      .waitForEvent({
        type: [
          "events.iterate.com/project/worker-updated",
          "events.iterate.com/project/worker-update-failed",
        ],
        payload: { commitOid },
        afterOffset,
        timeoutMs: Math.max(0, Math.min(PUBLICATION_WAIT_SLICE_MS, deadline - Date.now())),
      })
      .catch((error: unknown) => {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
      });
    // a slice that timed out is asked again on a fresh call until the deadline
    if (!outcome) continue;
    if (outcome.type === "events.iterate.com/project/worker-updated") return commitOid;
    const head = await repo.tip();
    if (!head || head === commitOid)
      throw new Error(
        `package.json pins the new build (config commit ${commitOid.slice(0, 7)}), but its publication failed, so the project still runs the old one: ${String(outcome.payload?.error)}`,
      );
    commitOid = head;
  }
  throw new Error(
    `The platform has not published config commit ${commitOid.slice(0, 7)}, which pins the new build, within two minutes: the project still runs the old build until it does`,
  );
}
