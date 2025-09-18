// @ts-nocheck

import type { AgentsOAuthProvider } from "agents/mcp/do-oauth-client-provider";
import { APP_URLS } from "iterate:estate-manifest";
import { env } from "../legacy-agent/env.ts";
import {
  getIntegrationFetcher,
  hasIntegrationFetcher,
} from "../legacy-agent/integrations/fetcher-registry.ts";
import { integrationManifestForSlug } from "../legacy-agent/integrations/manifests.ts";
import { getIntegrationSecret } from "../legacy-agent/integrations/integration-db-utils.ts";
import type { DynamicOAuthRequest } from "../legacy-agent/integrations/oauth-handler.ts";
import { OAuthHandler } from "../legacy-agent/integrations/oauth-handler.ts";

export class MCPOAuthProvider implements AgentsOAuthProvider {
  /** MCP client ID, not OAuth client ID */
  clientId: string;
  /** MCP server ID assigned by MCPClientManager */
  serverId: string;
  /** OAuth authorization to be sent to the user */
  authUrl: string | undefined;

  #oauthRequest: DynamicOAuthRequest;
  #accessToken?: string;
  #refreshToken?: string;

  constructor(params: { oauthRequest: DynamicOAuthRequest; clientId: string; serverId: string }) {
    this.#oauthRequest = params.oauthRequest;
    this.clientId = params.clientId;
    this.serverId = params.serverId;
  }

  clearTokens() {
    this.#accessToken = undefined;
    this.#refreshToken = undefined;
  }

  async tokens() {
    if (!this.#accessToken) {
      await this.initProviderFromIntegrationSystem();
    }
    return this.#accessToken
      ? {
          access_token: this.#accessToken,
          token_type: "Bearer",
          refresh_token: this.#refreshToken,
        }
      : undefined;
  }

  private async initProviderFromIntegrationSystem() {
    const tokenUserId =
      this.#oauthRequest.mode === "personal" ? this.#oauthRequest.userId : undefined;

    try {
      this.#accessToken = await getIntegrationSecret(
        "platform",
        this.#oauthRequest.integrationSlug,
        tokenUserId,
        "access_token",
        this.#oauthRequest.mode,
      );

      try {
        this.#refreshToken = await getIntegrationSecret(
          "platform",
          this.#oauthRequest.integrationSlug,
          tokenUserId,
          "refresh_token",
          this.#oauthRequest.mode,
        );
      } catch (refreshTokenError) {
        console.log(
          `No refresh token found for integration ${this.#oauthRequest.integrationSlug}, continuing with access token only: ${refreshTokenError.message}`,
        );
      }
    } catch (error) {
      console.log(
        `Failed to get integration tokens for ${this.#oauthRequest.integrationSlug}: ${error.message}`,
      );
    }

    if (!this.#accessToken) {
      await this.setupOAuthFlow();
    }
  }

  async setupOAuthFlow(): Promise<void> {
    const integrationSlug = this.#oauthRequest.integrationSlug;
    let oauthUrl: string | undefined;
    if (hasIntegrationFetcher(integrationSlug)) {
      const existingIntegrationManifest = integrationManifestForSlug(integrationSlug);
      const fetcher = getIntegrationFetcher(integrationSlug, env);
      if (existingIntegrationManifest.type !== "oauth" || !fetcher.getOAuthCredentials) {
        throw new Error(
          `Integration ${integrationSlug} is not an OAuth integration or does not have OAuth credentials`,
        );
      }
      const credentials = fetcher.getOAuthCredentials();
      oauthUrl = await OAuthHandler.initOAuthSession({
        ...this.#oauthRequest,
        manifest: existingIntegrationManifest,
        clientId: credentials.clientId,
        mcpServerUrl: this.#oauthRequest.serverUrl,
      });
    } else {
      try {
        oauthUrl = await OAuthHandler.handleDynamicServerOAuth(this.#oauthRequest);
      } catch (error) {
        throw new Error(
          `This MCP server does not support dynamic OAuth. Try setting requiresOAuth to false and use requiresHeadersAuth instead.`,
          {
            cause: error,
          },
        );
      }
    }
    this.authUrl = `${APP_URLS.platform}/integrations/redirect?url=${encodeURIComponent(oauthUrl)}`;
  }

  get redirectUrl(): string {
    if (!this.authUrl) {
      throw new Error("No auth URL found");
    }
    return this.authUrl;
  }

  get clientMetadata() {
    return {
      client_name: this.#oauthRequest.clientName,
      client_uri: this.#oauthRequest.clientUri,
      redirect_uris: [
        OAuthHandler.buildOAuthRedirectUrl(this.#oauthRequest.integrationSlug),
      ] as string[],
    };
  }

  async clientInformation() {
    return {
      client_id: this.clientId,
      client_name: this.#oauthRequest.clientName,
    };
  }

  // Stub out the below methods because we have our own oauth flow, and we only want to use this for class as a transport token provider
  // The save/redirect methods can be called but are no-ops. The codeVerifier getter should never be called.
  async saveTokens(_tokens: any): Promise<void> {}
  async saveClientInformation(_info: any): Promise<void> {}
  async saveCodeVerifier(_verifier: string): Promise<void> {}
  async redirectToAuthorization(_authUrl: URL): Promise<void> {}
  codeVerifier(): string {
    throw new Error("Not implemented");
  }
}
