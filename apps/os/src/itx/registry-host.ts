// One context-node shape: the Project Durable Object (project contexts) and
// ContextDO (child contexts) embed the SAME ContextRegistryHost — identity,
// audit destination, and code-context defaults differ; the wiring does not.

import { durableObjectFacetsHook, type ContextRegistryHost } from "./registry.ts";
import { resolveDialableTargets } from "./protocol.ts";
import type { CodeContext } from "./code-contexts.ts";
import { parseConfig } from "~/config.ts";

export function createContextRegistryHost(input: {
  ctx: DurableObjectState;
  env: unknown;
  contextId: string;
  projectId: string;
  audit: ContextRegistryHost["audit"];
  /**
   * The code-defined fallthrough link. The project node passes
   * `platformProjectContext`; child contexts deliberately pass none — their
   * misses delegate up the real chain to the parent NODE, which is where the
   * code-context link lives (a child resolving defaults in-process would
   * skip any shadowing rows on the project).
   */
  defaults?: CodeContext;
}): ContextRegistryHost {
  return {
    audit: input.audit,
    // Gated on the dialable allowlists inside the registry before this runs.
    binding: (name) => (input.env as Record<string, unknown>)[name],
    contextId: input.contextId,
    defaults: input.defaults,
    dialable: resolveDialableTargets(parseConfig(input.env).itx),
    facets: durableObjectFacetsHook(input.ctx),
    loader: (input.env as { LOADER?: unknown }).LOADER as ContextRegistryHost["loader"],
    loopback: (exportName, options) => {
      const exports = input.ctx.exports as unknown as Record<
        string,
        (options: Record<string, unknown>) => unknown
      >;
      const factory = exports[exportName];
      if (typeof factory !== "function") {
        throw new Error(`Loopback export ${exportName} is not available.`);
      }
      return factory(options);
    },
    projectId: input.projectId,
    sql: input.ctx.storage.sql,
  };
}
