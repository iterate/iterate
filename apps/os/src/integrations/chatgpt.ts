// src/integrations/chatgpt.ts — CHATGPT: a connection is a person's ChatGPT plan, which OpenAI's Sign
// in with ChatGPT lets the project's code use for Responses API requests
// (https://developers.openai.com/siwc/token-sharing-open-source). Its tokens live in
// `/secrets/chatgpt-<connection>`, an `oauth-refresh-token` secret of a PUBLIC client OpenAI registers
// for that person and workspace during the consent (`dynamic_agent_client` in, the issued `oaiapp_…`
// back as the callback's `client_id`): the material holds that client's ID beside the tokens, and a
// refresh sends it alone. Code in the project calls the model through `itx.fetch`, the token never in
// its hands:
//
//   POST https://api.openai.com/v1/responses
//   authorization: Bearer getSecret("/secrets/chatgpt-<connection>", { field: "accessToken" })
//   { "model": "gpt-6-astra", "input": [...], "store": false, "stream": true }
//
// (`store: false`, `stream: true` and a list `input` are required; `temperature`,
// `max_output_tokens` and a few more are refused: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.)
// The plan covers the Responses API alone: GPT-Live, Realtime and transcription refuse the token.
//
// OpenAI sends a public client back only to a loopback address, so the consent ends on
// `http://127.0.0.1:1455/auth/callback`, which nothing serves: the Dash's ChatGPT sheet takes the
// address the person pastes to the platform's callback, which completes the attempt as any other
// (secret-oauth.ts, "A LOOPBACK REDIRECT").
//   connectChatgpt       → the consent URL (`itx.secrets.beginOAuth`)
//   finishChatgptConnect → the ID token names the account, then `chatgpt/connected` on `/`
// A project connects it; a person's own connection, lent to projects, is not offered yet.
import { codedError } from "iterate/lib";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import {
  appendConnected,
  consentAttemptKeyOf,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";

/** OpenAI's Sign in with ChatGPT for open-source tools, as its registration and sign-in page spells
 *  it: https://developers.openai.com/siwc/token-sharing-open-source/sign-in. The pin is the issuer
 *  (the exchange and every refresh) and the API the plan pays for. */
const CHATGPT = {
  authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
  tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
  urls: ["https://auth.openai.com", "https://api.openai.com"],
  /** OpenAI registers a client for the person and workspace during the consent. */
  clientId: "dynamic_agent_client",
  /** The only redirect a public client gets: a loopback address, the docs' own example. */
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  /** Identity, a refresh token, and the plan's usage for requests to `resource`. */
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  resource: "https://api.openai.com/v1",
} as const;

/** Begin consent. A reconnect is a new connection: each consent registers a client of its own. */
export async function connectChatgpt(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    scopes?: string[];
  },
) {
  if (input.client !== "iterate")
    throw codedError(
      "INVALID_INPUT",
      "ChatGPT has no app of your own: OpenAI registers its client during the consent.",
    );
  if (input.scopes?.length)
    throw codedError("INVALID_INPUT", "ChatGPT asks for one set of permissions, no more.");
  using itx = scope.getItx();
  const { authorizationUrl, nonce } = await itx.secrets.beginOAuth(
    tokenSecretPathOf("chatgpt", input.connection),
    {
      authorizationEndpoint: CHATGPT.authorizationEndpoint,
      tokenEndpoint: CHATGPT.tokenEndpoint,
      clientId: CHATGPT.clientId,
      clientAuth: "none",
      redirectUri: CHATGPT.redirectUri,
      // the exchange is refused without it (`invalid_grant`, and the code is spent)
      resource: CHATGPT.resource,
      scope: CHATGPT.scope,
      urls: [...CHATGPT.urls],
      next: input.next,
      extra: {
        // what the consent page calls the agent, which the person may rename there
        agent_name_hint: "iterate",
        ext_agent_host_id: await agentHostIdOf(scope),
        // the ID token's replay guard; the ID token comes straight from the token endpoint, so its
        // claims are read without it (rules.ts `idTokenClaimsOf`)
        nonce: crypto.randomUUID(),
      },
    },
  );
  await scope.storage.put<ConnectionAttempt>(
    consentAttemptKeyOf("chatgpt", input.connection, nonce),
    { client: "iterate", origin: "", until: Date.now() + SECRET_OAUTH_TTL_MS },
  );
  return { authorizationUrl };
}

/** Record the account the consent's ID token names: its address, and its OpenID `sub`. */
export async function finishChatgptConnect(
  scope: IntegrationScope,
  connection: string,
  _attempt: ConnectionAttempt,
  consent: { grantedScopes: string[]; idTokenClaims?: { sub: string; email?: string } },
) {
  const account = consent.idTokenClaims;
  if (!account) throw new Error("ChatGPT's token response named no account");
  return {
    row: await appendConnected(scope, {
      provider: "chatgpt",
      connection,
      client: "iterate",
      account: account.email || account.sub,
      externalId: account.sub,
      scopes: consent.grantedScopes,
    }),
  };
}

/** THE AGENT HOST OpenAI attributes the plan's usage to (`ext_agent_host_id`): the project, whose
 *  agents make the requests. Stable per project and opaque, as OpenAI asks
 *  (https://developers.openai.com/siwc/token-sharing-open-source): a `urn:uuid:` of a SHA-256 of
 *  the project's id, so it needs no storage and names nothing about the person. */
async function agentHostIdOf(scope: Pick<IntegrationScope, "projectId">): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`iterate agent host ${scope.projectId}`),
    ),
  ).slice(0, 16);
  // an RFC 9562 UUIDv8: the version and variant bits set on the hash's first 128 bits
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
