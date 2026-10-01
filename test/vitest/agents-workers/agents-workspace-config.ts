// The agents app as a project's config: `iterate/agents` comes from the platform, so the platform
// under test runs this checkout's agents. It imports nothing else, so the e2e and Workers suites
// both load it.

/** A config shaped as core/configs/default: `worker.ts` ignores every event, `agents.ts` holds the classes. */
export const agentsWorkspaceConfig: Record<string, string> = {
  "package.json": '{"main":"worker.ts"}',
  "worker.ts":
    'import { IterateConfigEntrypoint } from "iterate/sdk";\nexport default class extends IterateConfigEntrypoint {}\n',
  "agents.ts":
    'export { AgentCollectionDurableObject, AgentDurableObject } from "iterate/agents";\n',
};
