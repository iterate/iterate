import type { IterateContextApi } from "iterate/api";

/** Install the app into a project root from its runtime: the files of the agents folder by name
 *  (`index.ts` its entry). Its code and catalog remain project-owned userspace. */
export async function installAgents(
  itx: Pick<IterateContextApi, "whoami" | "append" | "invoke"> & {
    kv: Pick<IterateContextApi["kv"], "put">;
    processors: Pick<IterateContextApi["processors"], "enable">;
  },
  source: Record<string, string>,
) {
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
