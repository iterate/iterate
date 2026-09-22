import type { IterateContextApi } from "iterate/next/api";

/** Install the app into a project root. Its code and catalog remain project-owned userspace. */
export async function installAgents(
  itx: Pick<IterateContextApi, "whoami" | "append" | "invoke"> & {
    kv: Pick<IterateContextApi["kv"], "put">;
    processors: Pick<IterateContextApi["processors"], "enable">;
  },
  source: string,
) {
  const { path } = await itx.whoami();
  if (path !== "/") throw new Error("Install agents at the project root");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const cacheKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await itx.kv.put(`agents/runtime/${cacheKey}.js`, source);
  await itx.kv.put("agents/runtime-key", cacheKey);
  const spec = {
    cacheKey,
    source: { "cap.js": source },
    className: "AgentCollectionDurableObject",
  };
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
