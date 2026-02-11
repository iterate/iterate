import { stringify as stringifyYaml } from "yaml";
import type { SerializedAgent } from "../trpc/router.ts";
import { resolveAgentSession } from "./agent-debug-links.ts";

export type AgentCommandEnvironment = {
  message: string;
  agentPath: string;
  // Channels must resolve agent context before invoking commands.
  // Command matching/execution is intentionally skipped when no agent exists.
  agent: SerializedAgent;
};

type AgentCommandRunOutput<T = unknown> = {
  result: T;
  // Optional command-authored markdown for "good enough" display in simple consumers.
  // If omitted, the runner auto-generates markdown from the structured result as YAML.
  resultMarkdown?: string;
};

type AgentCommandDefinition = {
  command: string;
  aliases: readonly string[];
  run: (env: AgentCommandEnvironment) => Promise<AgentCommandRunOutput<unknown>>;
};

const AGENT_COMMANDS = [
  {
    command: "debug",
    aliases: ["!debug", "/debug", "\\debug"],
    async run(env: AgentCommandEnvironment) {
      const session = resolveAgentSession(env.agent);
      const result = {
        agent: env.agent,
        terminalUrl: session.terminalUrl ?? null,
        webUrl: session.webUrl ?? null,
      } as const;

      const lines = [
        `Agent path: ${env.agentPath}`,
        `Agent harness: ${session.agentHarness ?? "unknown"}`,
        `Session source: ${session.source ?? "none"}`,
      ];

      if (result.webUrl) {
        lines.push(`Harness Web UI (direct proxy): ${result.webUrl}`);
      } else if (session.agentHarness) {
        lines.push("Harness Web UI (direct proxy): unavailable (missing machine link env)");
      }

      if (result.terminalUrl) {
        lines.push(`Open Terminal UI: ${result.terminalUrl}`);
      } else if (session.agentHarness) {
        lines.push("Open Terminal UI: unavailable (missing machine link env)");
      }

      return {
        result,
        resultMarkdown: lines.join("\n"),
      } as const;
    },
  },
] as const satisfies readonly AgentCommandDefinition[];

type AgentCommand = (typeof AGENT_COMMANDS)[number];

type AgentCommandMatchFor<C extends AgentCommand> = {
  command: C["command"];
  result: Awaited<ReturnType<C["run"]>>["result"];
  // Final markdown that all consumers can display directly.
  // Fancy consumers can ignore this and render `result` with richer UI (e.g. Slack blocks).
  resultMarkdown: string;
};

export type AgentCommandMatch = AgentCommand extends infer C
  ? C extends AgentCommand
    ? AgentCommandMatchFor<C>
    : never
  : never;

async function runMatchedAgentCommand<C extends AgentCommand>(
  command: C,
  environment: AgentCommandEnvironment,
): Promise<AgentCommandMatchFor<C>> {
  const commandOutput = (await command.run(environment)) as Awaited<ReturnType<C["run"]>>;
  const payload = {
    command: command.command,
    result: commandOutput.result,
    resultMarkdown:
      commandOutput.resultMarkdown ?? renderResultAsYamlMarkdown(commandOutput.result),
  } satisfies AgentCommandMatchFor<C>;

  return payload;
}

export async function runAgentCommand(
  environment: AgentCommandEnvironment,
): Promise<AgentCommandMatch | null> {
  const sanitizedMessage = environment.message.replace(/<@[^>]+>/g, " ").trim();
  if (!sanitizedMessage) return null;

  const [firstToken] = sanitizedMessage.split(/\s+/);
  if (!firstToken) return null;

  const command = AGENT_COMMANDS.find((entry) =>
    entry.aliases.some((alias) => alias === firstToken.toLowerCase()),
  );
  if (!command) return null;

  return runMatchedAgentCommand(command, { ...environment, message: sanitizedMessage });
}

function renderResultAsYamlMarkdown(result: unknown): string {
  const yaml = stringifyYaml(result).trim();
  return ["```yaml", yaml || "{}", "```"].join("\n");
}
