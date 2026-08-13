import type {
  IntegrationConnectionListEntry,
  IntegrationConnectionStatus,
  ProjectStub,
  PublicBuiltinIntegrationSlug,
} from "iterate/client";

export const CONNECTABLE_INTEGRATIONS = [
  {
    description:
      "Receive Slack events and call Slack Web API methods with project-scoped credentials.",
    key: "slack",
    name: "Slack",
    provider: "slack",
  },
  {
    description: "Use Gmail API tools through a connected Google account.",
    key: "gmail",
    name: "Google",
    provider: "google",
  },
  {
    description:
      "Use the GitHub REST API, route repository webhooks, and enable gh/git in sandboxes.",
    key: "github",
    name: "GitHub",
    provider: "github",
  },
  {
    description: "Connect a BotFather bot so agents can chat through Telegram.",
    key: "telegram",
    name: "Telegram",
    provider: "telegram",
  },
] as const;

export const PLATFORM_INTEGRATIONS = [
  {
    description: "Search, Extract, Task, FindAll, Monitor, and Chat through Parallel.",
    name: "Parallel",
    namespace: "itx.integrations.parallel",
  },
  {
    description: "Built-in Exa MCP tools for web search and page fetch.",
    name: "Exa",
    namespace: "itx.mcp.exa",
  },
  {
    description: "Cloudflare Workers AI model calls at the edge.",
    name: "Cloudflare Edge AI",
    namespace: "itx.ai",
  },
] as const;

type BuiltinEntry = Extract<IntegrationConnectionListEntry, { source: "builtin" }>;

export type MobileIntegrationConnection = BuiltinEntry & {
  status: IntegrationConnectionStatus;
};

export type MobileAccountConnection = {
  connected: boolean | null;
  connection: string;
  integration: string;
  path: string;
};

export type MobileIntegrations = {
  accounts: MobileAccountConnection[];
  connections: Record<PublicBuiltinIntegrationSlug, MobileIntegrationConnection[]>;
  provided: Extract<IntegrationConnectionListEntry, { source: "provided" }>[];
};

/**
 * Read the project's integration catalogue and join built-in journal entries
 * to their current connection state. Journals survive disconnects, so callers
 * need both pieces to render history without claiming stale credentials work.
 */
export async function listMobileIntegrations(project: ProjectStub): Promise<MobileIntegrations> {
  const [entries, secrets] = await Promise.all([
    project.integrations.list(),
    project.secrets.list(),
  ]);
  const builtinEntries = entries.filter(
    (entry): entry is BuiltinEntry => entry.source === "builtin",
  );
  const connectedEntries = await Promise.all(
    builtinEntries.map(async (entry) => ({
      ...entry,
      status: await project.integrations.getConnection({
        connection: entry.connection,
        provider: entry.integration === "gmail" ? "google" : entry.integration,
      }),
    })),
  );

  const connections = {
    github: connectedEntries.filter((entry) => entry.integration === "github"),
    gmail: connectedEntries.filter((entry) => entry.integration === "gmail"),
    slack: connectedEntries.filter((entry) => entry.integration === "slack"),
    telegram: connectedEntries.filter((entry) => entry.integration === "telegram"),
    waitrose: connectedEntries.filter((entry) => entry.integration === "waitrose"),
  };
  const accountEntries = secrets.flatMap((secret) => {
    const match = /^\/secrets\/integrations\/([^/]+)\/([^/]+)\/session$/.exec(secret.path);
    if (!match) return [];
    return [
      {
        connection: match[2]!,
        integration: match[1]!,
        path: secret.path,
      },
    ];
  });
  const accounts = await Promise.all(
    accountEntries.map(async (account): Promise<MobileAccountConnection> => {
      if (account.integration !== "waitrose") return { ...account, connected: null };
      const status =
        connections.waitrose.find((entry) => entry.connection === account.connection)?.status ||
        (await project.integrations.getConnection({
          connection: account.connection,
          provider: "waitrose",
        }));
      return { ...account, connected: status.connected };
    }),
  );
  return {
    accounts,
    connections,
    provided: entries.filter(
      (entry): entry is Extract<IntegrationConnectionListEntry, { source: "provided" }> =>
        entry.source === "provided",
    ),
  };
}
