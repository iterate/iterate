/**
 * Project DO addressing + stub minting, in its own module so light consumers
 * (itx handle, the project directory, oRPC routers) can mint stubs without
 * bundling the project Durable Object implementation. Lives under a
 * domain durable-objects/ directory so raw PROJECT binding access stays
 * inside the trusted set (no-raw-durable-object-binding-access lint rule).
 */
import { env } from "cloudflare:workers";
import { formatDurableObjectName } from "~/domains/durable-object-names.ts";

/** Project DOs are addressed by the canonical project root Durable Object name. */
export function getProjectDurableObjectName(projectId: string) {
  return formatDurableObjectName({ path: "/", projectId });
}

/** Mint a Project DO stub. */
export function getProjectDurableObjectStub(projectId: string) {
  return env.PROJECT.getByName(getProjectDurableObjectName(projectId));
}
