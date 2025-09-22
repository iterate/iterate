import type { AgentsOAuthProvider } from "agents/mcp/do-oauth-client-provider";
import { eq, and } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { Auth } from "../../auth/auth.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";

export class BetterAuthMCPOAuthProvider implements AgentsOAuthProvider {
  clientId: string | undefined;
  serverId: string | undefined;
  authUrl: string | undefined;

  private accountId: string | undefined;
  private baseUrl: string;

  constructor(
    private params: {
      auth: Auth;
      db: DB;
      userId: string;
      estateId: string;
      integrationSlug: string;
      serverUrl: string;
      env?: { VITE_PUBLIC_URL?: string };
      reconnect?: {
        id: string;
        oauthClientId?: string;
        oauthCode?: string;
      };
      agentDurableObjectId?: string;
      agentDurableObjectName?: string;
    },
  ) {
    // Get base URL from env or use default
    this.baseUrl = this.params.env?.VITE_PUBLIC_URL || "http://localhost:5173";
  }

  private get providerId() {
    return `mcp-${this.params.integrationSlug}`;
  }

  async clearTokens() {
    if (!this.accountId) {
      return;
    }

    // Delete the account directly from the database
    await this.params.db
      .delete(schema.account)
      .where(
        and(eq(schema.account.id, this.accountId), eq(schema.account.providerId, this.providerId)),
      );

    this.accountId = undefined;
  }

  async tokens() {
    // Set clientId and serverId from reconnect if available
    if (this.params.reconnect) {
      this.clientId = this.params.reconnect.oauthClientId;
      this.serverId = this.params.reconnect.id;
    }

    // Only return existing tokens - the MCP library handles token exchange
    const account = await this.params.db.query.account.findFirst({
      where: and(
        eq(schema.account.userId, this.params.userId),
        eq(schema.account.providerId, this.providerId),
      ),
    });

    if (account?.accessToken) {
      this.accountId = account.id;
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
      redirect_uris: [this.redirectUrl] as string[],
    };
  }

  async clientInformation() {
    if (!this.clientId) {
      return undefined;
    }

    // Retrieve client information from verification table if it exists
    const verificationKey = `mcp-client-${this.providerId}-${this.clientId}`;
    const verification = await this.params.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, verificationKey),
    });

    if (!verification) {
      return undefined;
    }

    try {
      const clientInfo = JSON.parse(verification.value);
      console.log("Retrieved client information:", {
        hasClientSecret: !!clientInfo.client_secret,
        clientId: clientInfo.client_id,
      });
      return clientInfo; // Return the full client information including client_secret
    } catch (error) {
      console.error("Failed to parse client information:", error);
      return undefined;
    }
  }

  async saveTokens(tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }): Promise<void> {
    console.log("saveTokens called with:", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
      userId: this.params.userId,
      providerId: this.providerId,
      estateId: this.params.estateId,
      clientId: this.clientId,
      serverId: this.serverId,
    });

    if (!this.clientId || !this.serverId) {
      throw new Error("Cannot save tokens without clientId and serverId");
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : undefined;

    // Check if account already exists
    const existingAccount = await this.params.db.query.account.findFirst({
      where: and(
        eq(schema.account.userId, this.params.userId),
        eq(schema.account.providerId, this.providerId),
      ),
    });

    if (existingAccount) {
      // Update existing account
      await this.params.db
        .update(schema.account)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || existingAccount.refreshToken,
          accessTokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.account.id, existingAccount.id));

      this.accountId = existingAccount.id;
      console.log("Updated existing account:", existingAccount.id);
    } else {
      // Create new account
      const newAccountId = typeid("acc").toString();
      console.log("Creating new account:", {
        id: newAccountId,
        providerId: this.providerId,
        userId: this.params.userId,
      });

      await this.params.db.insert(schema.account).values({
        id: newAccountId,
        accountId: this.clientId, // Use clientId as the account identifier
        providerId: this.providerId,
        userId: this.params.userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: expiresAt,
        scope: "", // MCP doesn't provide scope information
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      this.accountId = newAccountId;
      console.log("Account created successfully");

      // Associate account with estate
      await this.params.db
        .insert(schema.estateAccountsPermissions)
        .values({
          id: typeid("eap").toString(),
          accountId: newAccountId,
          estateId: this.params.estateId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      // Store provider mapping
      await this.params.db
        .insert(schema.providerEstateMapping)
        .values({
          id: typeid("pem").toString(),
          internalEstateId: this.params.estateId,
          externalId: this.serverId,
          providerId: this.providerId,
          providerMetadata: {
            serverUrl: this.params.serverUrl,
            integrationSlug: this.params.integrationSlug,
            clientId: this.clientId,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }
  }

  async saveClientInformation(info: any): Promise<void> {
    console.log("saveClientInformation called with:", info);
    this.clientId = info.client_id;

    // Store client information in verification table with a long expiration
    const verificationKey = `mcp-client-${this.providerId}-${info.client_id}`;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

    // First, delete any existing verification with the same identifier
    await this.params.db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, verificationKey));

    // Then insert the new one
    await this.params.db.insert(schema.verification).values({
      id: typeid("ver").toString(),
      identifier: verificationKey,
      value: JSON.stringify(info),
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log("Client information saved successfully");
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.clientId) {
      throw new Error("Cannot save code verifier without clientId");
    }

    // Store code verifier in verification table with short expiration
    const verificationKey = `mcp-verifier-${this.providerId}-${this.clientId}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // First, delete any existing verification with the same identifier
    await this.params.db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, verificationKey));

    // Then insert the new one
    await this.params.db.insert(schema.verification).values({
      id: typeid("ver").toString(),
      identifier: verificationKey,
      value: verifier,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    // Extract client_id from the auth URL if present
    const client_id = authUrl.searchParams.get("client_id");
    if (client_id) {
      this.clientId = client_id;
    }

    // Generate state and store it for verification
    const state = typeid("state").toString();
    const stateData = {
      integrationSlug: this.params.integrationSlug,
      serverUrl: this.params.serverUrl,
      estateId: this.params.estateId,
      userId: this.params.userId,
      callbackURL: `${this.baseUrl}/estates/${this.params.estateId}/agents`, // Default callback to estate agents page
      clientId: this.clientId,
      agentDurableObjectId: this.params.agentDurableObjectId,
      agentDurableObjectName: this.params.agentDurableObjectName,
    };

    // Store state in verification table
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await this.params.db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, state));

    await this.params.db.insert(schema.verification).values({
      id: typeid("ver").toString(),
      identifier: state,
      value: JSON.stringify(stateData),
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add state to the auth URL
    authUrl.searchParams.set("state", state);

    // Store the modified auth URL for the frontend to use
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
