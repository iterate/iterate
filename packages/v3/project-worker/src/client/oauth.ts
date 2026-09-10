import * as oauth from "oauth4webapi";
import { OAuthScopes } from "../oauth-scopes.ts";

/** The same code/PKCE parameters for browser login and a console-minted token. */
export async function authorizationCodeRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resources: string[];
  scopes?: string[];
}) {
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const state = oauth.generateRandomState();
  const url = new URL("/authorize", input.issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: OAuthScopes.parse(input.scopes ?? []).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  for (const resource of input.resources) url.searchParams.append("resource", resource);
  return { url, state, verifier };
}
