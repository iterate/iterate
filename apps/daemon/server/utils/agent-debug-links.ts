import { buildOpencodeAttachUrl, buildOpencodeWebSessionUrl } from "./observability-links.ts";

type JsonRecord = Record<string, unknown>;

type AgentDebugRoute = {
  destination: string;
  metadata?: JsonRecord | null;
};

type AgentDebugInfo = {
  path: string;
  workingDirectory: string;
  activeRoute?: AgentDebugRoute | null;
};

type SessionResolutionSource = "route.metadata" | "route.destination";

export type ResolvedAgentSession = {
  agentHarness: "opencode" | null;
  source: SessionResolutionSource | null;
  terminalUrl?: string;
  webUrl?: string;
};

type AgentHarnessMetadata = {
  agentHarness: "opencode";
  opencodeSessionId: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readAgentHarnessMetadata(metadata: JsonRecord | null): AgentHarnessMetadata | null {
  if (!metadata) return null;
  const agentHarness = readString(metadata.agentHarness);
  const opencodeSessionId = readString(metadata.opencodeSessionId);
  if (agentHarness !== "opencode" || !opencodeSessionId) return null;
  return { agentHarness: "opencode", opencodeSessionId };
}

function extractOpencodeSessionIdFromDestination(destination?: string | null): string | null {
  if (!destination) return null;
  const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
  return match?.[1] ?? null;
}

export function resolveAgentSession(agent: AgentDebugInfo): ResolvedAgentSession {
  // Current contract:
  // - active route metadata stores harness/session for this route
  // - today only OpenCode is supported:
  //   { agentHarness: "opencode", opencodeSessionId: "..." }
  //
  // Future direction:
  // harness providers should publish deep links directly in structured metadata.
  const routeMetadata = agent.activeRoute?.metadata ?? null;
  const routeDestination = agent.activeRoute?.destination ?? null;

  const harnessMetadata = readAgentHarnessMetadata(routeMetadata);
  if (harnessMetadata) {
    const { opencodeSessionId } = harnessMetadata;
    return {
      agentHarness: "opencode",
      source: "route.metadata",
      terminalUrl: buildOpencodeAttachUrl({
        sessionId: opencodeSessionId,
        workingDirectory: agent.workingDirectory,
      }),
      webUrl: buildOpencodeWebSessionUrl({
        sessionId: opencodeSessionId,
        workingDirectory: agent.workingDirectory,
      }),
    };
  }

  const sessionIdFromRoute = extractOpencodeSessionIdFromDestination(routeDestination);
  if (sessionIdFromRoute) {
    return {
      agentHarness: "opencode",
      source: "route.destination",
      terminalUrl: buildOpencodeAttachUrl({
        sessionId: sessionIdFromRoute,
        workingDirectory: agent.workingDirectory,
      }),
      webUrl: buildOpencodeWebSessionUrl({
        sessionId: sessionIdFromRoute,
        workingDirectory: agent.workingDirectory,
      }),
    };
  }

  return { agentHarness: null, source: null };
}
