import type { AgentsOAuthProvider } from "agents/mcp/do-oauth-client-provider";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { generateRandomString } from "better-auth/crypto";
import type { Auth } from "../../auth/auth.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { MCPOAuthState } from "../../auth/oauth-state-schemas.ts";
import type { AgentDurableObjectInfo } from "../../auth/oauth-state-schemas.ts";
import { DynamicClientInfo } from "../../auth/oauth-state-schemas.ts";

/**
 * Connector between MCP OAuthClientProvider and our better auth plugin
 *
 * Inspired by agents SDK implementation: https://github.com/cloudflare/agents/blob/4e087816e8c011f87eedb3302db80724fe6080ac/packages/agents/src/index.ts
 * Durable Object version reference implementation: https://github.com/cloudflare/agents/blob/6db2cd6f1497705f8636b1761a2db364d49d4861/packages/agents/src/mcp/do-oauth-client-provider.ts
 *
 * MCPClientManager requires reconnect argument with id (serverId from previos connect), oauthClientId, and oauthCode from oauth callback (cloudflare craft).
 * It turns out we don't need to pass the serverId and the reconnect will still work as expected.
 * This is good because we are creating a new MCPClientManager for each connect request (and a newserverId is generated every time).
 *
 * So we call MCPClientManager.connect twice. First without reconnect, then with reconnect.
 * In the first call, we create the dynamic client and save the account to the dynamic_client_info table.
 * We save code verifier to the verification table for 10 minutes.
 * We save state object to the verification table for 10 minutes. We add agentDurableObject to the state object so we can get the stub in the callbackMCP.
 * Then we construct the redirect url and let the connector handle the translation of the url to MCP:OAUTH_REQUIRED event.
 * Then LLM generates a message to the user to authorize the connection.
 * The user clicks the url and is redirected to the authorization url.
 * On redirect, we call callbackMCP from integrations auth plugin.
 * We add another connect request with reconnect argument.
 * This time OAuthClientProvider will exchange the code for tokens and save them to the account table.
 * Then when it requires to get tokens(), it will get them from the account table.
 * Congrats, we successfully connected to the MCP server.
 */
export class MCPOAuthProvider implements AgentsOAuthProvider {
  clientId: string | undefined;
  serverId: string | undefined;
  authUrl: string | undefined;

  private dbAccountId: string | undefined;
  private baseUrl: string;

  constructor(
    private params: {
      auth: Auth;
      db: DB;
      userId: string;
      estateId: string;
      integrationSlug: string;
      serverUrl: string;
      callbackUrl: string | undefined;
      agentDurableObject: AgentDurableObjectInfo;
    },
  ) {
    this.baseUrl = import.meta.env.VITE_PUBLIC_URL;
  }

  private get providerId() {
    return this.params.integrationSlug;
  }

  async clearTokens() {
    // If we have a cached dbAccountId, use it for efficiency
    if (this.dbAccountId) {
      await this.params.db
        .delete(schema.account)
        .where(
          and(
            eq(schema.account.id, this.dbAccountId),
            eq(schema.account.providerId, this.providerId),
          ),
        );
    } else if (this.clientId) {
      // If we have clientId, delete by userId, providerId, and clientId
      await this.params.db
        .delete(schema.account)
        .where(
          and(
            eq(schema.account.userId, this.params.userId),
            eq(schema.account.providerId, this.providerId),
            eq(schema.account.accountId, this.clientId),
          ),
        );
    } else {
      // If we don't have clientId, find and delete the most recent account
      const recentAccount = await this.params.db.query.account.findFirst({
        where: and(
          eq(schema.account.userId, this.params.userId),
          eq(schema.account.providerId, this.providerId),
        ),
        orderBy: (account, { desc }) => [desc(account.createdAt)],
      });

      if (recentAccount) {
        await this.params.db.delete(schema.account).where(eq(schema.account.id, recentAccount.id));
      }
    }

    this.dbAccountId = undefined;
    this.clientId = undefined;
  }

  async tokens() {
    // If we don't have a clientId, try to find the most recent account for this user/provider
    if (!this.clientId) {
      const recentAccount = await this.params.db.query.account.findFirst({
        where: and(
          eq(schema.account.userId, this.params.userId),
          eq(schema.account.providerId, this.providerId),
        ),
        orderBy: (account, { desc }) => [desc(account.createdAt)],
      });

      if (recentAccount?.accountId) {
        this.clientId = recentAccount.accountId;
        this.dbAccountId = recentAccount.id;
      } else {
        return undefined;
      }
    }

    const account = await this.params.db.query.account.findFirst({
      where: and(
        eq(schema.account.userId, this.params.userId),
        eq(schema.account.providerId, this.providerId),
        eq(schema.account.accountId, this.clientId),
      ),
    });

    // Refresh logic comes from mcp typescript sdk (we assume)
    // https://github.com/modelcontextprotocol/typescript-sdk/blob/1d475bb3f75674a46d81dba881ea743a763cbc12/src/client/auth.ts#L980
    if (account?.accessToken) {
      this.dbAccountId = account.id;
      return {
        access_token: account.accessToken,
        token_type: "Bearer",
        refresh_token: account.refreshToken || undefined,
      };
    }

    return undefined;
  }

  get redirectUrl(): string {
    return `${this.baseUrl}/api/auth/integrations/callback/mcp`;
  }

  get clientMetadata() {
    return {
      client_name: `Iterate MCP Client - ${this.params.integrationSlug}`,
      client_uri: this.baseUrl,
      redirect_uris: [this.redirectUrl],
    };
  }

  async clientInformation() {
    if (!this.clientId) {
      return undefined;
    }

    const dynamicClientInfo = await this.params.db.query.dynamicClientInfo.findFirst({
      where: and(
        eq(schema.dynamicClientInfo.providerId, this.providerId),
        eq(schema.dynamicClientInfo.clientId, this.clientId),
      ),
    });

    if (!dynamicClientInfo) {
      return undefined;
    }

    const clientInfo = DynamicClientInfo.safeParse(dynamicClientInfo.clientInfo);
    if (!clientInfo.success) {
      console.error(`Failed to parse client information: ${z.prettifyError(clientInfo.error)}`);
      return undefined;
    }
    return clientInfo.data;
  }

  async saveTokens(tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }): Promise<void> {
    if (!this.clientId) {
      throw new Error("Cannot save tokens without clientId");
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : undefined;

    const existingAccount = await this.params.db.query.account.findFirst({
      where: and(
        eq(schema.account.userId, this.params.userId),
        eq(schema.account.providerId, this.providerId),
        eq(schema.account.accountId, this.clientId),
      ),
    });

    if (existingAccount) {
      await this.params.db
        .update(schema.account)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || existingAccount.refreshToken,
          accessTokenExpiresAt: expiresAt,
        })
        .where(eq(schema.account.id, existingAccount.id));

      this.dbAccountId = existingAccount.id;
    } else {
      const newAccount = await this.params.db.transaction(async (tx) => {
        const [newAccount] = await tx
          .insert(schema.account)
          .values({
            accountId: this.clientId!, // Dynamic client id is the closest thing to an *external* account id
            providerId: this.providerId,
            userId: this.params.userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            accessTokenExpiresAt: expiresAt,
            scope: "",
          })
          .returning();

        await tx.insert(schema.estateAccountsPermissions).values({
          accountId: newAccount.id,
          estateId: this.params.estateId,
        });
        return newAccount;
      });

      this.dbAccountId = newAccount.id;
    }
  }

  async saveClientInformation(_info: unknown): Promise<void> {
    const info = DynamicClientInfo.parse(_info);
    this.clientId = info.client_id;
    await this.params.db
      .insert(schema.dynamicClientInfo)
      .values({
        clientId: info.client_id,
        providerId: this.providerId,
        clientInfo: info,
      })
      .onConflictDoUpdate({
        target: [schema.dynamicClientInfo.providerId, schema.dynamicClientInfo.clientId],
        set: {
          clientInfo: info,
        },
      });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.clientId) {
      throw new Error("Cannot save code verifier without clientId");
    }

    const verificationKey = `mcp-verifier-${this.providerId}-${this.clientId}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes for OAuth flow

    await this.params.db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, verificationKey));

    await this.params.db.insert(schema.verification).values({
      identifier: verificationKey,
      value: verifier,
      expiresAt,
    });
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    if (!this.clientId) {
      throw new Error("Cannot redirect to authorization without clientId");
    }

    const state = generateRandomString(32);
    const stateData: MCPOAuthState = {
      integrationSlug: this.params.integrationSlug,
      serverUrl: this.params.serverUrl,
      estateId: this.params.estateId,
      userId: this.params.userId,
      callbackUrl: this.params.callbackUrl,
      clientId: this.clientId,
      agentDurableObject: {
        durableObjectId: this.params.agentDurableObject.durableObjectId,
        durableObjectName: this.params.agentDurableObject.durableObjectName,
        className: this.params.agentDurableObject.className,
      },
    };

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes for OAuth flow
    await this.params.db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, state));

    await this.params.db.insert(schema.verification).values({
      identifier: state,
      value: JSON.stringify(stateData),
      expiresAt,
    });

    authUrl.searchParams.set("state", state);

    this.authUrl = authUrl.toString();
  }

  async codeVerifier(): Promise<string> {
    if (!this.clientId) {
      throw new Error("Cannot get code verifier without clientId");
    }

    const verificationKey = `mcp-verifier-${this.providerId}-${this.clientId}`;
    const verification = await this.params.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, verificationKey),
    });

    if (!verification?.value) {
      throw new Error("No code verifier found");
    }

    return verification.value;
  }
}
