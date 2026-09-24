import * as oauth from "oauth4webapi";
import { OAuthScopes } from "../oauth-scopes.ts";

/** The platform's issuer as oauth4webapi's authorization server: its endpoints under `/oauth2`, and
 *  the `iss` it adds to every authorization response (RFC 9207), which `validateAuthResponse` then
 *  requires. The same description for an app's browser session and the CLI. */
export function authorizationServer(issuer: string): oauth.AuthorizationServer {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/auth`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    authorization_response_iss_parameter_supported: true,
  };
}

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
  const url = new URL("/oauth2/auth", input.issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: OAuthScopes.parse(input.scopes || []).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  for (const resource of input.resources) url.searchParams.append("resource", resource);
  return { url, state, verifier };
}
