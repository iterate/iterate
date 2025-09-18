import type { AgentsOAuthProvider } from "agents/mcp/do-oauth-client-provider";

export class MCPOAuthProvider implements AgentsOAuthProvider {
  clientId: string;
  serverId: string;
  authUrl: string | undefined;

  constructor(params: { clientId: string; serverId: string }) {
    this.clientId = params.clientId;
    this.serverId = params.serverId;
  }

  clearTokens() {}

  async tokens() {
    return {
      access_token: "test",
      token_type: "Bearer",
      refresh_token: "test",
    };
  }

  get redirectUrl(): string {
    return "test";
  }

  get clientMetadata() {
    return {
      client_name: "test",
      client_uri: "test",
      redirect_uris: ["test"] as string[],
    };
  }

  async clientInformation() {
    return {
      client_id: "test",
      client_name: "test",
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
