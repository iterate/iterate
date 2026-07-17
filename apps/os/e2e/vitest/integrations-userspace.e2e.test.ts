// A project-owned integration, end to end: the project implements "ocado"
// as ordinary code in its own repo and mounts it into the integrations
// collection with provideCapability({ path: ["integrations", "ocado"] }) —
// data, not deployment. It is then addressed exactly like a built-in, at fully
// qualified connection paths: itx.integrations.ocado.get("family").searchProducts(...)
// and itx.integrations.ocado.get("mum").basket.add(...). Per-connection session
// secrets ride as getSecret(path) placeholders in the worker's fetch
// headers and substitute at project egress: the echo fixture (standing in for
// the vendor API) is the only party that ever sees material.
//
// (Waitrose itself is a BUILT-IN — itx.integrations.waitrose, dispatched in
// deployment code over the vendored client — so its slug is reserved here;
// the builtin's surface is asserted below without dialing the vendor.)

import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startEgressEcho } from "./itx-capability-fixtures.ts";
import { petshopBaseUrl, petshopExpireTokens, shouldSkipPetshopE2e } from "./petshop-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);

test("a project mounts ocado into the collection; connections + secret confinement hold", async () => {
  const echo = await startEgressEcho();
  try {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug: `ocado-${RUN_SUFFIX}` });
    await project.__describe();
    const integrations = project.integrations as any;

    // Before the mount, the name resolves through the capability table and
    // fails loudly — nothing is silently invented.
    await expect(integrations.ocado.get("family").searchProducts("milk")).rejects.toThrow(
      /no capability/,
    );

    // The built-in namespace itself cannot be shadowed; providing UNDER it
    // is the extension point.
    await expect(
      project.provideCapability({
        path: ["integrations"],
        type: "live",
        capability: {},
      }),
    ).rejects.toThrow(/already on the itx surface/);

    // …but not under the names the collection's own dispatch claims: a mount
    // there would be durable, journaled, and silently unreachable, so it is
    // rejected loudly at provide time. Both builtin slugs and the
    // collection's own verbs are reserved — waitrose included, now that it
    // is a builtin.
    await expect(
      project.provideCapability({
        path: ["integrations", "slack", "shadow"],
        type: "live",
        capability: {},
      }),
    ).rejects.toThrow(/built-in integrations member/);
    await expect(
      project.provideCapability({
        path: ["integrations", "waitrose", "shadow"],
        type: "live",
        capability: {},
      }),
    ).rejects.toThrow(/built-in integrations member/);
    await expect(
      project.provideCapability({
        path: ["integrations", "posthog", "shadow"],
        type: "live",
        capability: {},
      }),
    ).rejects.toThrow(/built-in integrations member/);
    await expect(
      project.provideCapability({
        path: ["integrations", "list"],
        type: "live",
        capability: {},
      }),
    ).rejects.toThrow(/built-in integrations member/);

    // Two connections of one integration, secrets at the same fully
    // qualified paths a built-in would use.
    const secrets = {
      family: `ocado-session-family-${RUN_SUFFIX}`,
      mum: `ocado-session-mum-${RUN_SUFFIX}`,
    };
    for (const [connection, material] of Object.entries(secrets)) {
      using secret = project.secrets.get(`/secrets/integrations/ocado/${connection}/session`);
      await secret.create({ egress: { urls: [echo.url] }, material });
      await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
        description: `ocado/${connection} secret to fold`,
      });
    }

    // The integration is code in the project repo…
    await project.repo.commitFiles({
      changes: [{ content: ocadoWorkerSource(echo.url), path: "integrations/ocado.js" }],
      message: "Implement the ocado integration",
    });

    // …and ONE durable capability mount makes it part of the collection.
    using _provision = await project.provideCapability({
      path: ["integrations", "ocado"],
      type: "itx-expression",
      flattenNestedPaths: true,
      instructions:
        'Ocado grocery integration. Select a connection with get("<connection>"): itx.integrations.ocado.get("family").searchProducts(term) / .basket.add(itemId).',
      expression: [
        "workers",
        [
          "get",
          {
            type: "stateless",
            path: "/",
            entrypoint: "OcadoIntegration",
            source: {
              files: { type: "repo", repoPath: "/repos/config" },
              options: { entryPoint: "integrations/ocado.js" },
            },
          },
        ],
      ],
    });

    // Same address shape as a built-in, fully qualified connection first.
    const search = await integrations.ocado.get("family").searchProducts("milk");
    expect(search).toEqual({
      operation: "search-products",
      payload: { term: "milk" },
      sentAuthorization: 'getSecret({ path: "/secrets/integrations/ocado/family/session" })',
      receivedAuthorization: secrets.family,
    });

    const basket = await integrations.ocado.get("mum").basket.add("item-123");
    expect(basket).toEqual({
      operation: "basket-add",
      payload: { itemId: "item-123" },
      sentAuthorization: 'getSecret({ path: "/secrets/integrations/ocado/mum/session" })',
      receivedAuthorization: secrets.mum,
    });

    // Negative controls: the worker only ever held the placeholder
    // (sentAuthorization above), describe() leaks nothing, uses land on the
    // audit trail.
    using familySecret = project.secrets.get("/secrets/integrations/ocado/family/session");
    const described = await familySecret.__describe();
    expect(JSON.stringify(described)).not.toContain(secrets.family);
    await waitForCondition(async () => (await familySecret.__describe()).audit.usedCount >= 1, {
      description: "ocado/family usage audit to fold",
    });

    // The collection enumerates the mount alongside built-in connections.
    expect(await project.integrations.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: null,
          integration: "ocado",
          path: "/integrations/ocado",
          source: "provided",
        }),
      ]),
    );
    await expect(integrations.ocado.get().searchProducts("milk")).rejects.toThrow(
      /No concrete ocado integration connection is available/,
    );

    // get() is the only selector and teaches the missing-connection case;
    // unknown integration names still stay loud.
    await expect(integrations.slack.get().chat.postMessage({ text: "hi" })).rejects.toThrow(
      /No connected slack account is available/,
    );
    await expect(integrations.tesco.get("family").searchProducts("milk")).rejects.toThrow(
      /no capability/,
    );

    // Discovery: __describe on a provided mount answers from the mount's
    // durable metadata, never dialing the provider. (A trailing __describe
    // is a valid INVOCATION path — only mount NAMES reserve it; this used
    // to die in path validation with "invalid capability path segment".)
    const describedMount = await integrations.ocado.__describe();
    expect(JSON.stringify(describedMount)).toContain("Ocado grocery integration");
    await expect(integrations.tesco.__describe()).rejects.toThrow(/no capability/);
  } finally {
    await echo.close();
  }
});

// The builtin waitrose surface, asserted without ever dialing the vendor:
// the grammar guard, per-connection __describe (the connect recipe lives
// there), and a loud method miss out of the replayed client.
test("builtin waitrose: grammar, __describe, and method-miss stay loud", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({ slug: `waitrose-builtin-${RUN_SUFFIX}` });
  await project.__describe();
  const integrations = project.integrations as any;

  // get() is the only connection selector. With no connected secret it
  // explains how to connect or select an exact account.
  await expect(integrations.waitrose.get().shoppingContext()).rejects.toThrow(
    /No connected waitrose account is available/,
  );

  using sessionSecret = project.secrets.get("/secrets/integrations/waitrose/mum/session");
  await sessionSecret.create({
    egress: { urls: ["https://www.waitrose.com"] },
    material: { username: "mum@example.com", password: "not-used" },
  });
  await waitForCondition(async () => (await sessionSecret.__describe()).hasMaterial, {
    description: "waitrose/mum connection secret to fold",
  });
  await waitForCondition(
    async () =>
      (await project.integrations.list()).some(
        (entry) => entry.integration === "waitrose" && entry.connection === "mum",
      ),
    { description: "waitrose/mum to appear in integrations.list()" },
  );

  // The connection node answers __describe with the client surface and the
  // connection-secret recipe — no journal, no vendor round trip. This also
  // proves get() resolves the first credential-defined connection.
  const description = await integrations.waitrose.get().__describe();
  const rendered = JSON.stringify(description);
  expect(rendered).toContain("vendored Waitrose client");
  expect(rendered).toContain("waitrose-session");

  // A method the client does not have misses loudly instead of dialing out.
  await expect(integrations.waitrose.get("mum").noSuchMethod()).rejects.toThrow(/noSuchMethod/);
});

// The username/password → session-token archetype, closed end to end against
// petshop's GraphQL session-login door (the wire shape the `waitrose-session`
// strategy speaks): the connection secret holds ONLY the account credential
// plus the refresh strategy, so the Secret DO logs in itself — mint on first
// use (no initial token anywhere), re-mint on 401 — and the minted session is
// an ordinary bearer on petshop's ONE pets API. Same opt-in gate as
// integrations-petshop.e2e.test.ts.
test.skipIf(shouldSkipPetshopE2e())(
  "waitrose-session strategy: username/password secret mints on first use, re-mints on 401, session works on the API",
  async () => {
    const petshop = petshopBaseUrl();
    const username = `mum-${RUN_SUFFIX}@example.com`;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `waitrose-live-${RUN_SUFFIX}` });
    await project.__describe();

    // The connection secret: the account credential and NOTHING token-shaped.
    // "correct-horse" is the fixture's one accepted password (graphql-login.ts).
    using secret = project.secrets.get("/secrets/integrations/waitrose/mum/session");
    await secret.create({
      egress: { urls: [petshop] },
      material: { username, password: "correct-horse" },
      refresh: {
        kind: "waitrose-session",
        graphqlUrl: `${petshop}/graphql`,
      },
    });
    await waitForCondition(async () => (await secret.__describe()).refresh === "waitrose-session", {
      description: "waitrose/mum refresh strategy to fold",
    });

    const callApi = async (path: string) => {
      const response = await project.egress.fetch(
        new Request(`${petshop}${path}`, {
          headers: {
            authorization:
              'Bearer getSecret({ path: "/secrets/integrations/waitrose/mum/session", field: "accessToken" })',
          },
        }),
      );
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };

    // First use: the material has no accessToken, so substitution misses, the
    // strategy runs the NewSession login inside the Secret DO, and the retried
    // request lands on the pets API as the logged-in account.
    const me = await callApi("/api/me");
    expect(me).toMatchObject({
      status: 200,
      body: { sub: username, clientId: "graphql-session-login" },
    });

    // Force a real 401 (epoch bump kills the stored session) and call again:
    // re-login IS the refresh — the same strategy re-mints and the retry wins.
    await petshopExpireTokens();
    const pets = await callApi("/api/pets");
    expect(pets).toMatchObject({ status: 200 });
    expect(Array.isArray(pets.body.pets ?? pets.body)).toBe(true);

    // Confinement: describe() leaks neither the password nor a session token
    // (hasMaterial is the only material-shaped fact), and uses are audited.
    const described = await secret.__describe();
    expect(JSON.stringify(described)).not.toContain("correct-horse");
    expect(described).toMatchObject({ hasMaterial: true });
    await waitForCondition(async () => (await secret.__describe()).audit.usedCount >= 2, {
      description: "waitrose/mum usage audit to fold",
    });
  },
);

function ocadoWorkerSource(echoUrl: string): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const OCADO_API_URL = ${JSON.stringify(echoUrl)};

    // The session secret is addressed per connection and NEVER read here: the
    // authorization header carries a getSecret placeholder that project egress
    // substitutes inside the secret Durable Object. The integration's own code
    // cannot see its tokens.
    function ocadoSdk(connection) {
      const authorization =
        'getSecret({ path: "/secrets/integrations/ocado/' + connection + '/session" })';
      const call = async (operation, payload) => {
        const response = await fetch(OCADO_API_URL, {
          method: "POST",
          headers: { authorization, "x-ocado-operation": operation },
          body: JSON.stringify(payload),
        });
        const echoed = await response.json();
        return {
          operation,
          payload,
          sentAuthorization: authorization,
          receivedAuthorization: echoed.headers.authorization,
        };
      };
      return {
        searchProducts: (term) => call("search-products", { term }),
        basket: { add: (itemId) => call("basket-add", { itemId }) },
      };
    }

    // Mounted at ["integrations", "ocado"], so get(connection) supplies
    // the first remaining path segment and the rest is the SDK method path — the same
    // /integrations/<slug>/<connection> address shape as built-ins.
    export class OcadoIntegration extends WorkerEntrypoint {
      invokeCapability({ path, args }) {
        const [connection, ...rest] = path;
        if (!connection || rest.length === 0) {
          throw new Error(
            'ocado expects <connection>.<method>, e.g. itx.integrations.ocado.get("family").searchProducts(...)',
          );
        }
        let receiver = ocadoSdk(connection);
        for (const segment of rest.slice(0, -1)) receiver = receiver?.[segment];
        const method = receiver?.[rest[rest.length - 1]];
        if (typeof method !== "function") {
          throw new Error("ocado sdk has no method " + rest.join("."));
        }
        return method.apply(receiver, args);
      }
    }
  `;
}
