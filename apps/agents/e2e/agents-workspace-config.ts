// e2e/agents-workspace-config.ts — the agents app as a project's config over this checkout's
// @iterate-com/agents source, so the rows that drive the agents need neither a publish of the
// package nor esm.sh; template.e2e.test.ts proves the published package installs from the default
// template. It imports nothing, so the e2e suite (agents-source.ts) and the Workers suite
// (__workers-tests__/agent-revive.test.ts) both load it.

/** A config shaped as the default template (configs/default), over the package's source files by
 *  name: `worker.ts`, the entry, is a config entrypoint that ignores every event, and `agents.ts`
 *  re-exports the two classes the app's facets load by `mainModule`, never as the entry. */
export const agentsWorkspaceConfig: Record<string, string> = {
  "package.json": '{"main":"worker.ts"}',
  "worker.ts":
    'import { IterateConfigEntrypoint } from "iterate/sdk";\nexport default class extends IterateConfigEntrypoint {}\n',
  "agents.ts": 'export { AgentCollectionDurableObject, AgentDurableObject } from "./index.ts";\n',
  ...Object.fromEntries(
    Object.entries(
      import.meta.glob<string>(["../../../packages/agents/src/*.ts", "!**/*.test.ts"], {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
  ),
};
