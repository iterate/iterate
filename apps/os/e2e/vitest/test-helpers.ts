import type { RpcStub } from "capnweb";
import { connectItx, type ItxWebSocketMessage } from "../../src/itx-client.ts";
import type {
  Agent,
  ItxAuthCredentials,
  Itx,
  Session,
  UnauthenticatedItx,
} from "../../src/types.ts";

export type { ItxWebSocketMessage };

/**
 * The deployment admin API secret gating the `admin-secret` and `impersonate`
 * credential lanes. Provided by the Doppler config the suite runs under.
 */
export function adminSecret(): string {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!secret) {
    throw new Error("itx e2e needs APP_CONFIG_ADMIN_API_SECRET (run under doppler).");
  }
  return secret;
}

// setup.ts resolves APP_CONFIG_BASE_URL (Doppler value or the local
// dev-server discovery file) before any suite runs.
function requireAppBaseUrl(): string {
  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("itx e2e needs APP_CONFIG_BASE_URL (run under doppler or the e2e setup).");
  }
  return baseUrl;
}

type ItxSessionInput = {
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void;
};

type AuthenticatedItxSessionInput = ItxSessionInput & {
  auth: ItxAuthCredentials;
};

type ProjectItxSessionInput = AuthenticatedItxSessionInput & {
  projectId: string;
};

type AgentItxSessionInput = AuthenticatedItxSessionInput & {
  agentPath: string;
  projectId: string;
};

export function buildUrl({
  path,
  protocol = "http",
}: {
  path: string;
  protocol?: "ws" | "http";
}): string {
  const url = new URL(path, requireAppBaseUrl());
  if (protocol === "ws") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  return url.toString();
}

/**
 * The node itx client pointed at the suite's deployment: `connectItx` with
 * `baseUrl` filled in from APP_CONFIG_BASE_URL. `onWebSocketMessage` (frame
 * recording) is plumbed straight through to the client.
 */
export function withItxSession(input: AgentItxSessionInput): RpcStub<Agent>;
export function withItxSession(input: ProjectItxSessionInput): RpcStub<Itx>;
export function withItxSession(input: AuthenticatedItxSessionInput): RpcStub<Session>;
export function withItxSession(input?: ItxSessionInput): RpcStub<UnauthenticatedItx>;
export function withItxSession(
  input:
    | AgentItxSessionInput
    | AuthenticatedItxSessionInput
    | ItxSessionInput
    | ProjectItxSessionInput = {},
): RpcStub<Agent> | RpcStub<Session> | RpcStub<Itx> | RpcStub<UnauthenticatedItx> {
  const baseUrl = requireAppBaseUrl();
  if (!("auth" in input)) return connectItx({ ...input, baseUrl });
  if (!("projectId" in input)) return connectItx({ ...input, baseUrl });
  if (!("agentPath" in input)) return connectItx({ ...input, baseUrl });
  return connectItx({ ...input, baseUrl });
}
