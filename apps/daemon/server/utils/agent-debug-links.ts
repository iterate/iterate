import { buildOpencodeAttachUrl, buildOpencodeWebSessionUrl } from "./observability-links.ts";

type JsonRecord = Record<string, unknown>;

type AgentDebugRoute = {
  destination: string;
  metadata?: JsonRecord | null;
};

type AgentDebugInfo = {
  path: string;
  workingDirectory: string;
  metadata?: JsonRecord | null;
  activeRoute?: AgentDebugRoute | null;
};

type SessionResolutionSource = "agent.metadata" | "route.destination";

export type ResolvedAgentSession = {
  agentHarness: "opencode" | null;
  opencodeSessionId: string | null;
  source: SessionResolutionSource | null;
  terminalAttachUrl?: string;
  opencodeWebUrl?: string;
};

type AgentHarnessMetadata = {
  agentHarness: "opencode";
  opencodeSessionId: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function readAgentHarnessMetadata(metadata: JsonRecord | null): AgentHarnessMetadata | null {
  if (!metadata) return null;
  const agentHarness = readString(metadata.agentHarness);
  const opencodeSessionId = readString(metadata.opencodeSessionId);
  if (agentHarness !== "opencode" || !opencodeSessionId) return null;
  return { agentHarness: "opencode", opencodeSessionId };
}

export function extractOpencodeSessionIdFromDestination(
  destination?: string | null,
): string | null {
  if (!destination) return null;
  const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
  return match?.[1] ?? null;
}

export function resolveAgentSession(agent: AgentDebugInfo): ResolvedAgentSession {
  // Current contract:
  // - agent metadata stores the active harness and session id
  // - today only OpenCode is supported:
  //   { agentHarness: "opencode", opencodeSessionId: "..." }
  //
  // Future direction:
  // harness providers should publish deep links directly in structured metadata.
  const agentMetadata = readRecord(agent.metadata);
  const routeDestination = agent.activeRoute?.destination ?? null;

  const harnessMetadata = readAgentHarnessMetadata(agentMetadata);
  if (harnessMetadata) {
    const { opencodeSessionId } = harnessMetadata;
    return {
      agentHarness: "opencode",
      opencodeSessionId,
      source: "agent.metadata",
      terminalAttachUrl: buildOpencodeAttachUrl({
        sessionId: opencodeSessionId,
        workingDirectory: agent.workingDirectory,
      }),
      opencodeWebUrl: buildOpencodeWebSessionUrl({
        sessionId: opencodeSessionId,
        workingDirectory: agent.workingDirectory,
      }),
    };
  }

  const sessionIdFromRoute = extractOpencodeSessionIdFromDestination(routeDestination);
  if (sessionIdFromRoute) {
    return {
      agentHarness: "opencode",
      opencodeSessionId: sessionIdFromRoute,
      source: "route.destination",
      terminalAttachUrl: buildOpencodeAttachUrl({
        sessionId: sessionIdFromRoute,
        workingDirectory: agent.workingDirectory,
      }),
      opencodeWebUrl: buildOpencodeWebSessionUrl({
        sessionId: sessionIdFromRoute,
        workingDirectory: agent.workingDirectory,
      }),
    };
  }

  return { agentHarness: null, opencodeSessionId: null, source: null };
}
