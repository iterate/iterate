import { stringify as stringifyYaml } from "yaml";
import type { SerializedAgent } from "../trpc/router.ts";
import { resolveAgentSession } from "./agent-debug-links.ts";

type CommandGetAgent = (input: { path: string }) => Promise<SerializedAgent | null>;

export type AgentCommandEnvironment = {
  message: string;
  agentPath: string;
  getAgent: CommandGetAgent;
  rendererHint?: string;
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
      const rendererHint = env.rendererHint ?? "integration router";
      const agent = await env.getAgent({ path: env.agentPath });
      if (!agent) {
        const result = {
          status: "agent_not_found",
          agentPath: env.agentPath,
          diagnostic: `getAgent({ path: "${env.agentPath}" })`,
        } as const;
        return {
          result,
          resultMarkdown: [
            "No agent found for this thread.",
            `${rendererHint} called ${result.diagnostic} and no agent was returned.`,
            "Create the thread agent by @mentioning the bot, then run !debug again.",
          ].join("\n"),
        } as const;
      }

      const session = resolveAgentSession(agent);
      const result = {
        status: "ok",
        agentPath: env.agentPath,
        agentHarness: session.agentHarness,
        opencodeSessionId: session.opencodeSessionId,
        sessionSource: session.source,
        terminalAttachUrl: session.terminalAttachUrl ?? null,
        opencodeWebUrl: session.opencodeWebUrl ?? null,
      } as const;

      const lines = [
        `Agent path: ${result.agentPath}`,
        `Agent harness: ${result.agentHarness ?? "unknown"}`,
        `OpenCode session: ${result.opencodeSessionId ?? "unknown"}`,
        `Session source: ${result.sessionSource ?? "none"}`,
      ];

      if (result.opencodeWebUrl) {
        lines.push(
          `OpenCode Web UI (direct proxy): <${result.opencodeWebUrl}|Open OpenCode session>`,
        );
      } else if (result.agentHarness === "opencode") {
        lines.push("OpenCode Web UI (direct proxy): unavailable (missing machine link env)");
      }

      if (result.terminalAttachUrl) {
        lines.push(`Open Terminal UI: <${result.terminalAttachUrl}|Open terminal attach>`);
      } else {
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

export function renderResultAsYamlMarkdown(result: unknown): string {
  const yaml = stringifyYaml(result).trim();
  return ["```yaml", yaml || "{}", "```"].join("\n");
}
