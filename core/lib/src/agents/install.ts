// install.ts — what a config repo's init case calls (README.md). Not the runtime, so importing it
// loads none.
import type {} from "./api.ts"; // registers `itx.agents` on InstalledAppRoots
import type { FacetSpec, IterateContextApi } from "../api.ts";

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
