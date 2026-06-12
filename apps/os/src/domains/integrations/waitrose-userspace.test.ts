// The Waitrose case, end to end — THE test for userspace integrations,
// derived secrets, and the ACCOUNT dimension, mirroring
// iterate-config-repo/apps/waitrose/worker.js:
//
//   1. A project worker defines a whole "waitrose integration" in userspace:
//      an SDK factory of the ACCOUNT whose requests carry a
//      getSecret({ key }) placeholder header, and a connect flow that
//      journals username + password and declares the access token as DERIVED
//      (Waitrose sessions last ~5 minutes; there is no refresh token — you
//      re-login).
//   2. itx.integrations.waitrose.searchProducts("milk") forwards to the
//      project worker's integrations({ slug, account, path, args }) export as
//      one call; itx.integrations["waitrose:mum"] is a SECOND account of the
//      same integration, with its own credentials, token, and journal.
//   3. The SDK's bare fetch() goes through egress substitution, which asks
//      the account's access-token secret for material; finding none (or
//      stale), the secret derives INLINE — logging in with that account's
//      journaled credentials.
//   4. Six minutes later the token is stale; the next search re-derives
//      transparently. The SDK code never sees a token or password.
//
// The platform pieces under test are the REAL pure modules
// (secret-derivation.ts, egress-secret-substitution.ts); the Durable Object /
// workerd plumbing around them is emulated in ~40 lines (MiniSecretSystem ≙
// SecretDurableObject, egressFetch ≙ EgressPipe).

import { describe, expect, it } from "vitest";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import {
  deriveViaHttpExchange,
  materialIsStale,
  SecretDerivation,
} from "~/domains/secrets/secret-derivation.ts";

describe("waitrose: a userspace integration on derived secrets", () => {
  it("connects two accounts; each searches with its own inline-derived 5-minute tokens", async () => {
    const world = createWaitroseWorld();
    const { clock, fakeWaitroseApi, itx } = world;

    // ---- the project worker's userspace code (mirrors the template app) ----
    const NEW_SESSION_MUTATION =
      "mutation NewSession($input: SessionInput) { generateSession(session: $input) " +
      "{ accessToken failures { type message } } }";

    async function connectWaitrose({
      username,
      password,
      account = "default",
    }: {
      username: string;
      password: string;
      account?: string;
    }) {
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
            url: "https://www.waitrose.com/api/graphql-prod/graph/live",
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
          extract: { materialPointer: "/data/generateSession/accessToken", ttlSeconds: 300 },
        },
      });
    }

    const sdkRequests: Array<{ authorization: string }> = [];
    // The SDK is a factory of the ACCOUNT — the instance dimension.
    const waitroseSdk = (account: string) => ({
      async searchProducts(searchTerm: string) {
        const headers = {
          // The placeholder the SDK actually sends — egress substitutes it.
          authorization: `Bearer getSecret({ key: "waitrose/${account}/access-token" })`,
          "content-type": "application/json",
        };
        sdkRequests.push({ authorization: headers.authorization });
        const response = await world.egressFetch(
          "https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent/search/-1?clientType=WEB_APP",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ customerSearchRequest: { queryParams: { searchTerm } } }),
          },
        );
        if (!response.ok) throw new Error(`Waitrose search failed: HTTP ${response.status}`);
        return (await response.json()) as { products: string[] };
      },
    });

    // The root worker's `integrations` export: one call in, local path walk.
    async function integrations({
      slug,
      account = "default",
      path,
      args,
    }: {
      slug: string;
      account?: string;
      path: string[];
      args: unknown[];
    }) {
      const entry = ({ waitrose: waitroseSdk } as Record<string, (account: string) => object>)[
        slug
      ];
      if (!entry) throw new Error(`No userspace integration named "${slug}".`);
      const sdk = entry(account);
      let parent: unknown = sdk;
      for (const segment of path.slice(0, -1))
        parent = (parent as Record<string, unknown>)[segment];
      const method = path.at(-1)!;
      return await (parent as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    }

    // ---- the flow -----------------------------------------------------------

    // 1. Two Waitrose accounts, connected with their own credentials.
    await connectWaitrose({ username: "jonas@example.com", password: "hunter2" });
    await connectWaitrose({ username: "mum@example.com", password: "teatime", account: "mum" });

    // 2. itx.integrations.waitrose.searchProducts("milk") — account "default".
    const results = (await integrations({
      slug: "waitrose",
      path: ["searchProducts"],
      args: ["milk"],
    })) as { products: string[] };

    expect(results.products).toEqual(["Essential Milk 2L"]);
    // The login derivation ran exactly once, lazily, for the default account.
    expect(fakeWaitroseApi.logins).toEqual([
      { username: "jonas@example.com", password: "hunter2", clientId: "ANDROID_APP" },
    ]);
    // The SDK only ever held placeholders, never tokens.
    expect(sdkRequests.every((r) => r.authorization.includes("getSecret("))).toBe(true);
    expect(fakeWaitroseApi.searchAuthHeaders).toEqual(["Bearer session-jonas@example.com-1"]);

    // 3. itx.integrations["waitrose:mum"] — the SECOND account derives its own
    //    session from its own credentials; the default account's token is
    //    untouched.
    await integrations({
      slug: "waitrose",
      account: "mum",
      path: ["searchProducts"],
      args: ["biscuits"],
    });
    expect(fakeWaitroseApi.logins.at(-1)).toEqual({
      username: "mum@example.com",
      password: "teatime",
      clientId: "ANDROID_APP",
    });
    expect(fakeWaitroseApi.searchAuthHeaders.at(-1)).toBe("Bearer session-mum@example.com-1");

    // 4. A second default-account search inside the 5-minute window reuses
    //    its token — no new login.
    await integrations({ slug: "waitrose", path: ["searchProducts"], args: ["bread"] });
    expect(fakeWaitroseApi.logins).toHaveLength(2);
    expect(fakeWaitroseApi.searchAuthHeaders.at(-1)).toBe("Bearer session-jonas@example.com-1");

    // 5. Six minutes later both sessions are stale — the next default search
    //    re-logs-in inline, invisibly to the SDK.
    clock.advanceSeconds(6 * 60);
    await integrations({ slug: "waitrose", path: ["searchProducts"], args: ["cheese"] });
    expect(fakeWaitroseApi.searchAuthHeaders.at(-1)).toBe("Bearer session-jonas@example.com-2");

    // The whole lifecycle is journaled, per account: default has 2 rotations,
    // mum has 1.
    expect(world.rotationsBySlug("waitrose/default/access-token")).toBe(2);
    expect(world.rotationsBySlug("waitrose/mum/access-token")).toBe(1);
  });
});

// ---- the emulated platform (≙ SecretDurableObject + EgressPipe) ------------

type StoredSecret = {
  material?: string;
  expiresAt?: string;
  derivation?: SecretDerivation;
  sensitivity?: "secret" | "plain";
};

function createWaitroseWorld() {
  let nowMs = Date.parse("2026-06-11T12:00:00.000Z");
  const clock = {
    now: () => nowMs,
    advanceSeconds: (seconds: number) => {
      nowMs += seconds * 1000;
    },
  };

  const fakeWaitroseApi = createFakeWaitroseApi();
  const secrets = new Map<string, StoredSecret>();
  const secretEvents: Array<{ type: "set" | "rotated" | "used"; slug: string }> = [];

  // ≙ SecretDurableObject.revealForPlatformUse with ensureFreshMaterial.
  async function reveal(slug: string): Promise<string> {
    const secret = secrets.get(slug);
    if (!secret) throw new Error(`Secret ${slug} was not found.`);
    const stale = materialIsStale({
      hasMaterial: secret.material != null,
      expiresAt: secret.expiresAt,
      leewaySeconds: secret.derivation?.refreshLeewaySeconds ?? 0,
      nowMs: clock.now(),
    });
    if (stale && secret.derivation != null) {
      if (secret.derivation.kind !== "http-exchange") throw new Error("spike: http-exchange only");
      const derived = await deriveViaHttpExchange({
        derivation: secret.derivation,
        resolveSecretKey: reveal, // sibling secrets — derivations chain
        fetchImpl: fakeWaitroseApi.fetch,
        nowMs: clock.now(),
      });
      secret.material = derived.material;
      secret.expiresAt = derived.expiresAt;
      secretEvents.push({ type: "rotated", slug });
    }
    if (secret.material == null) throw new Error(`Secret ${slug} has no material.`);
    secretEvents.push({ type: "used", slug });
    return secret.material;
  }

  // ≙ the itx.secrets capability.
  const itx = {
    secrets: {
      async set(input: Omit<StoredSecret, "derivation"> & { slug: string; derivation?: unknown }) {
        secrets.set(input.slug, {
          ...(input.material == null ? {} : { material: input.material }),
          ...(input.expiresAt == null ? {} : { expiresAt: input.expiresAt }),
          ...(input.derivation == null
            ? {}
            : { derivation: SecretDerivation.parse(input.derivation) }),
        });
        secretEvents.push({ type: "set", slug: input.slug });
      },
    },
  };

  // ≙ EgressPipe: REAL substitution module, resolver backed by the secret DOs.
  async function egressFetch(url: string, init: RequestInit): Promise<Response> {
    const request = new Request(url, init);
    const [error, substituted] = await substituteProjectEgressSecretHeaders({
      headers: request.headers,
      secrets: {
        getSecretOrNull: async ({ key }) =>
          secrets.has(key) ? { material: await reveal(key) } : null,
      },
    });
    if (error) return error;
    const headers = new Headers(request.headers);
    for (const [header, value] of Object.entries(substituted)) headers.set(header, value);
    return await fakeWaitroseApi.fetch(url, { ...init, headers });
  }

  return {
    clock,
    egressFetch,
    fakeWaitroseApi,
    itx,
    rotationsBySlug: (slug: string) =>
      secretEvents.filter((event) => event.type === "rotated" && event.slug === slug).length,
  };
}

function createFakeWaitroseApi() {
  const passwords: Record<string, string> = {
    "jonas@example.com": "hunter2",
    "mum@example.com": "teatime",
  };
  const logins: Array<{ username: string; password: string; clientId: string }> = [];
  const searchAuthHeaders: string[] = [];

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlString = String(url instanceof Request ? url.url : url);
    const headers = new Headers(init?.headers);

    if (urlString.includes("/api/graphql-prod/graph/live")) {
      const body = JSON.parse(String(init?.body)) as {
        variables: { input: { username: string; password: string; clientId: string } };
      };
      const input = body.variables.input;
      if (passwords[input.username] !== input.password) {
        return Response.json({ data: { generateSession: { accessToken: null } } });
      }
      logins.push(input);
      const sessionNumber = logins.filter((l) => l.username === input.username).length;
      return Response.json({
        data: { generateSession: { accessToken: `session-${input.username}-${sessionNumber}` } },
      });
    }

    if (urlString.includes("/productcontent/search/")) {
      const authorization = headers.get("authorization") ?? "";
      searchAuthHeaders.push(authorization);
      if (!authorization.startsWith("Bearer session-")) {
        return new Response("UNAUTHENTICATED", { status: 401 });
      }
      return Response.json({ products: ["Essential Milk 2L"] });
    }

    return new Response("not found", { status: 404 });
  };

  return { fetch: fetchImpl as typeof fetch, logins, searchAuthHeaders };
}
