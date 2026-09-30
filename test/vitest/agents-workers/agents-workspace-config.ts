// The agents app as a project's config over this checkout's source, no publish or esm.sh needed; it
// imports nothing, so the e2e and Workers suites both load it. The published package is template.e2e's.

/** A config shaped as core/configs/default: `worker.ts` ignores every event, `agents.ts` holds the classes. */
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
