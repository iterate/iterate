// Typed project facades on the itx handle: wiring, not logic. Every method is
// ONE delegation to the same domain function the corresponding oRPC router
// calls; failures carry ItxError codes (errors.ts, D18). All of them are
// project-scoped — the trust kernel (handle.ts) resolves the projectId before
// constructing a facade, so there is nothing to authorize here (Law 3).

import { RpcTarget } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { getItxErrorCode, ItxError } from "./errors.ts";
import type { ItxRuntime } from "./handle.ts";
import { getUserPrincipal } from "~/auth/principal.ts";
import {
  getAgentStub,
  listAgentPresets,
  listProjectAgents,
} from "~/domains/agents/agent-directory.ts";
import { listInboundMcpSessions } from "~/domains/inbound-mcp-server/session-directory.ts";
import {
  createGoogleAuthorizationUrl,
  createSlackAuthorizationUrl,
  providerConnectionStatus,
  requestBaseUrl,
  type OAuthProvider,
} from "~/domains/secrets/oauth.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";

/** Agents: runtime state deliberately has no facade method — it lives on the
 * agent stream's reduced-state views (subscribe/onStateChange). */
export class ItxAgents extends RpcTarget {
  constructor(private readonly projectId: string) {
    super();
  }

  async list() {
    return await listProjectAgents({ projectId: this.projectId });
  }

  async presets() {
    return await listAgentPresets({ projectId: this.projectId });
  }

  async sendMessage(input: { agentPath: string; channel?: string; message: string }) {
    const agent = await getAgentStub({
      agentPath: StreamPath.parse(input.agentPath),
      projectId: this.projectId,
    });
    return await agent.sendMessage({ channel: input.channel, message: input.message });
  }
}

export class ItxIntegrations extends RpcTarget {
  constructor(
    private readonly runtime: ItxRuntime,
    private readonly projectId: string,
  ) {
    super();
  }

  async getConnection(input: { provider: OAuthProvider }) {
    return await providerConnectionStatus({
      db: createD1Client(this.runtime.env.DB),
      projectId: this.projectId,
      provider: input.provider,
    });
  }

  async startOAuthFlow(input: { provider: OAuthProvider; callbackUrl?: string }) {
    const user = getUserPrincipal(this.runtime.principal);
    if (!user) {
      throw new ItxError({ code: "FORBIDDEN", message: "OAuth flows need a user principal." });
    }
    const create =
      input.provider === "slack" ? createSlackAuthorizationUrl : createGoogleAuthorizationUrl;
    return {
      authorizationUrl: await create({
        // The redirect URI MUST come from config, never from a request: this
        // call arrives over a long-lived socket whose connect request may be
        // arbitrarily old (and on another host than the OAuth callback).
        baseUrl: requestBaseUrl({ config: this.runtime.config }),
        callbackUrl: input.callbackUrl,
        config: this.runtime.config,
        db: createD1Client(this.runtime.env.DB),
        projectId: this.projectId,
        userId: user.userId,
      }),
    };
  }
}

export class ItxMcp extends RpcTarget {
  constructor(private readonly projectId: string) {
    super();
  }

  async listSessions() {
    return await listInboundMcpSessions({ projectId: this.projectId });
  }
}

/** Secrets: every method returns redacted summaries (the capability's
 * summary surface) — material never leaves except through project egress. */
export class ItxSecrets extends RpcTarget {
  constructor(
    private readonly runtime: ItxRuntime,
    private readonly projectId: string,
  ) {
    super();
  }

  async list() {
    return { secrets: await this.capability().listSecrets() };
  }

  async get(input: { id: string }) {
    return await withSecretsErrors(() => this.capability().getSecretSummary(input));
  }

  async upsert(input: { key: string; material: string; metadata?: Record<string, unknown> }) {
    return await withSecretsErrors(() => this.capability().setSecret(input));
  }

  async remove(input: { id: string }) {
    return await this.capability().deleteSecretById(input);
  }

  private capability() {
    return getSecretsCapability({
      exports: this.runtime.exports as unknown as Parameters<
        typeof getSecretsCapability
      >[0]["exports"],
      props: { projectId: this.projectId },
    });
  }
}

/** The same message-sniffing map the oRPC secrets router applied: the
 * capability throws plain Errors, callers read codes. */
async function withSecretsErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message.includes("not found")) {
      throw new ItxError({ code: "NOT_FOUND", message: error.message });
    }
    if (error.message.includes("required")) {
      throw new ItxError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

/**
 * Domain flows shared with oRPC (ProjectsCapability) speak ORPCError; itx
 * callers read ItxError. Four of the five codes are shared names (so
 * getItxErrorCode reads them straight off the ORPCError); UNAUTHORIZED folds
 * into FORBIDDEN (itx has no UNAUTHORIZED — auth happened at connect, D18)
 * and everything else is INTERNAL.
 */
export async function rethrowAsItxError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    const code =
      getItxErrorCode(error) ?? (error.code === "UNAUTHORIZED" ? "FORBIDDEN" : "INTERNAL");
    throw new ItxError({ code, message: error.message });
  }
}
