// A whole third-party integration defined in USERSPACE — no platform code
// knows Waitrose exists. After connecting, `itx.integrations.waitrose.*` is a
// Waitrose SDK (modeled on github.com/jonastemplestein/waitrose). Three
// pieces:
//
//  1. connectWaitrose({ username, password }) — journal the credentials as
//     Secrets and declare the access token as a DERIVED secret. Waitrose has
//     no refresh tokens: you re-login with username/password, and sessions
//     live ~5 minutes. The platform re-derives the token INLINE whenever a
//     request finds it stale, journaling each rotation.
//  2. The SDK below — plain fetch() calls whose authorization header carries
//     a getSecret({ key: ... }) placeholder. This code NEVER sees the token
//     (or the password): substitution happens in the platform's terminal
//     egress pipe.
//  3. The root worker.js `integrations` export forwards
//     itx.integrations.waitrose.<method>(...) calls here.

import { env } from "cloudflare:workers";

const GRAPHQL_URL = "https://www.waitrose.com/api/graphql-prod/graph/live";
const SEARCH_API_URL = "https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent";

const NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) " +
  "{ accessToken failures { type message } } }";

// One-time setup: itx.worker.connectWaitrose({ username: "...", password: "..." }).
// The ACCOUNT is the instance dimension — pass account: "mum" to connect a
// second Waitrose login, then call itx.integrations["waitrose/mum"].…
export async function connectWaitrose({ username, password, account = "default" }) {
  const itx = await env.ITERATE.context;
  await itx.secrets.set({
    slug: `waitrose/${account}/username`,
    material: username,
    sensitivity: "plain",
  });
  await itx.secrets.set({ slug: `waitrose/${account}/password`, material: password });
  await itx.secrets.set({
    slug: `waitrose/${account}/access-token`,
    derivation: {
      kind: "http-exchange",
      request: {
        url: GRAPHQL_URL,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: NEW_SESSION_MUTATION,
          variables: {
            input: {
              username: `getSecret({ key: "waitrose/${account}/username" })`,
              password: `getSecret({ key: "waitrose/${account}/password" })`,
              clientId: "ANDROID_APP",
            },
          },
        }),
      },
      extract: {
        materialPointer: "/data/generateSession/accessToken",
        ttlSeconds: 300,
      },
    },
  });
  return { connected: true };
}

const waitrose = (account) => ({
  async searchProducts(searchTerm, options = {}) {
    const response = await fetch(`${SEARCH_API_URL}/search/-1?clientType=WEB_APP`, {
      method: "POST",
      headers: {
        // Substituted (and inline-refreshed) by project egress — never here.
        authorization: `Bearer getSecret({ key: "waitrose/${account}/access-token" })`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        customerSearchRequest: {
          queryParams: { searchTerm, start: 0, sortBy: "RELEVANCE", ...options },
        },
      }),
    });
    if (!response.ok) throw new Error(`Waitrose search failed: HTTP ${response.status}`);
    return await response.json();
  },
});

export default {
  integrations: { waitrose },

  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "waitrose") return;
    return new Response(
      "Waitrose userspace integration. Connect with itx.worker.connectWaitrose({ username, password }), " +
        "then itx.integrations.waitrose.searchProducts('milk').",
    );
  },
};
