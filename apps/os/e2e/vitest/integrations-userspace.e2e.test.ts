// A project-owned integration, end to end: the project implements "waitrose"
// as ordinary code in its own repo and mounts it into the integrations
// collection with provideCapability({ path: ["integrations", "waitrose"] }) —
// data, not deployment. It is then addressed exactly like a built-in, at fully
// qualified connection paths: itx.integrations.waitrose.family.searchProducts(...)
// and itx.integrations.waitrose.mum.basket.add(...). Per-connection session
// secrets ride as getSecret(path) placeholders in the worker's fetch
// headers and substitute at project egress: the echo fixture (standing in for
// the Waitrose API) is the only party that ever sees material.

import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startEgressEcho } from "./itx-capability-fixtures.ts";
import { petshopBaseUrl, petshopExpireTokens } from "./petshop-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);

function waitroseWorkerSource(echoUrl: string): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const WAITROSE_API_URL = ${JSON.stringify(echoUrl)};

    // The session secret is addressed per connection and NEVER read here: the
    // authorization header carries a getSecret placeholder that project egress
    // substitutes inside the secret Durable Object. The integration's own code
    // cannot see its tokens.
    function waitroseSdk(connection) {
      const authorization =
        'getSecret({ path: "/secrets/integrations/waitrose/' + connection + '/session" })';
      const call = async (operation, payload) => {
        const response = await fetch(WAITROSE_API_URL, {
          method: "POST",
          headers: { authorization, "x-waitrose-operation": operation },
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

    // Mounted at ["integrations", "waitrose"], so the first remaining path
    // segment is the CONNECTION and the rest is the SDK method path — the same
    // /integrations/<slug>/<connection> address shape as built-ins.
    export class WaitroseIntegration extends WorkerEntrypoint {
      invokeCapability({ path, args }) {
        const [connection, ...rest] = path;
        if (!connection || rest.length === 0) {
          throw new Error(
            "waitrose expects <connection>.<method>, e.g. itx.integrations.waitrose.family.searchProducts(...)",
          );
        }
        let receiver = waitroseSdk(connection);
        for (const segment of rest.slice(0, -1)) receiver = receiver?.[segment];
        const method = receiver?.[rest[rest.length - 1]];
        if (typeof method !== "function") {
          throw new Error("waitrose sdk has no method " + rest.join("."));
        }
        return method.apply(receiver, args);
      }
    }
  `;
}

describe("provided integrations", () => {
  test("a project mounts waitrose into the collection; connections + secret confinement hold", async () => {
    const echo = await startEgressEcho();
    try {
      using session = withItxSession();
      using itx = session.authenticate({
        type: "admin-secret",
        secret: adminSecret(),
      });
      using project = itx.projects.create({ slug: `waitrose-${RUN_SUFFIX}` });
      await project.__describe();
      const integrations = project.integrations as any;

      // Before the mount, the name resolves through the capability table and
      // fails loudly — nothing is silently invented.
      await expect(integrations.waitrose.family.searchProducts("milk")).rejects.toThrow(
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
      ).rejects.toThrow(/already on the ITX surface/);

      // …but not under the names the collection's own dispatch claims: a mount
      // there would be durable, journaled, and silently unreachable, so it is
      // rejected loudly at provide time. Both builtin slugs and the
      // collection's own verbs are reserved.
      await expect(
        project.provideCapability({
          path: ["integrations", "slack", "shadow"],
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
        family: `waitrose-session-family-${RUN_SUFFIX}`,
        mum: `waitrose-session-mum-${RUN_SUFFIX}`,
      };
      for (const [connection, material] of Object.entries(secrets)) {
        using secret = project.secrets.get(`/secrets/integrations/waitrose/${connection}/session`);
        await secret.update({ egress: { urls: [echo.url] }, material });
        await waitForCondition(async () => (await secret.describe()).hasMaterial, {
          description: `waitrose/${connection} secret to fold`,
        });
      }

      // The integration is code in the project repo…
      await project.repo.commitFiles({
        changes: [{ content: waitroseWorkerSource(echo.url), path: "integrations/waitrose.js" }],
        message: "Implement the waitrose integration",
      });

      // …and ONE durable capability mount makes it part of the collection.
      using _provision = await project.provideCapability({
        path: ["integrations", "waitrose"],
        type: "itx-expression",
        flattenNestedPaths: true,
        instructions:
          "Waitrose grocery integration. Address a connection first: itx.integrations.waitrose.<connection>.searchProducts(term) / .basket.add(itemId).",
        expression: [
          "workers",
          [
            "get",
            {
              type: "stateless",
              path: "/",
              entrypoint: "WaitroseIntegration",
              source: {
                files: { type: "repo", repoPath: "/" },
                options: { entryPoint: "integrations/waitrose.js" },
              },
            },
          ],
        ],
      });

      // Same address shape as a built-in, fully qualified connection first.
      const search = await integrations.waitrose.family.searchProducts("milk");
      expect(search).toEqual({
        operation: "search-products",
        payload: { term: "milk" },
        sentAuthorization: 'getSecret({ path: "/secrets/integrations/waitrose/family/session" })',
        receivedAuthorization: secrets.family,
      });

      const basket = await integrations.waitrose.mum.basket.add("item-123");
      expect(basket).toEqual({
        operation: "basket-add",
        payload: { itemId: "item-123" },
        sentAuthorization: 'getSecret({ path: "/secrets/integrations/waitrose/mum/session" })',
        receivedAuthorization: secrets.mum,
      });

      // Negative controls: the worker only ever held the placeholder
      // (sentAuthorization above), describe() leaks nothing, uses land on the
      // audit trail.
      using familySecret = project.secrets.get("/secrets/integrations/waitrose/family/session");
      const described = await familySecret.describe();
      expect(JSON.stringify(described)).not.toContain(secrets.family);
      await waitForCondition(async () => (await familySecret.describe()).audit.usedCount >= 1, {
        description: "waitrose/family usage audit to fold",
      });

      // The collection enumerates the mount alongside built-in connections.
      expect(await project.integrations.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            connection: null,
            integration: "waitrose",
            path: "/integrations/waitrose",
            source: "provided",
          }),
        ]),
      );

      // Built-ins stay strict: no implicit connection, unknown names stay loud.
      await expect(integrations.slack.chat.postMessage({ text: "hi" })).rejects.toThrow(
        /use itx.integrations.list\(\) to see connections/,
      );
      await expect(integrations.ocado.family.searchProducts("milk")).rejects.toThrow(
        /no capability/,
      );
    } finally {
      await echo.close();
    }
  });
});

// The SEEDED waitrose integration, live against the deployed dummy-petshop's
// Waitrose-shaped GraphQL fixture — the username/password → session-token
// archetype closed end to end. Every project repo carries
// integrations/waitrose/** (the vendored client + entrypoint from
// apps/os/project-repo-template); the connection secret holds ONLY the
// account credential plus the `waitrose-session` refresh strategy, so the
// Secret DO logs in itself: mint on first use (no initial token anywhere),
// re-mint on 401. Same opt-in gate as integrations-petshop.e2e.test.ts.
describe.skipIf(!process.env.PETSHOP_BASE_URL)("seeded waitrose integration", () => {
  test("username/password secret + waitrose-session strategy: mint on first use, re-mint on 401", async () => {
    const petshop = petshopBaseUrl();
    const username = `mum-${RUN_SUFFIX}@example.com`;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `waitrose-live-${RUN_SUFFIX}` });
    await project.__describe();
    const integrations = project.integrations as any;

    // The connection secret: the account credential and NOTHING token-shaped.
    // "correct-horse" is the fixture's one accepted password (waitrose.ts).
    using secret = project.secrets.get("/secrets/integrations/waitrose/mum/session");
    await secret.update({
      egress: { urls: [petshop] },
      material: { username, password: "correct-horse" },
      refresh: {
        kind: "waitrose-session",
        graphqlUrl: `${petshop}/api/graphql-prod/graph/live`,
      },
    });
    await waitForCondition(async () => (await secret.describe()).refresh === "waitrose-session", {
      description: "waitrose/mum refresh strategy to fold",
    });

    // ONE durable mount of the SEEDED worker — the exact recipe the template's
    // integrations/waitrose/README.md documents, plus `props.baseUrl` to point
    // the vendored client at the fixture instead of the real Waitrose.
    using _provision = await project.provideCapability({
      path: ["integrations", "waitrose"],
      type: "itx-expression",
      flattenNestedPaths: true,
      instructions:
        "Waitrose grocery integration. Address a connection first: itx.integrations.waitrose.<connection>.shoppingContext() / .trolley(orderId?).",
      expression: [
        "workers",
        [
          "get",
          {
            type: "stateless",
            path: "/",
            entrypoint: "WaitroseIntegration",
            props: { baseUrl: petshop },
            source: {
              files: { type: "repo", repoPath: "/", include: ["integrations/waitrose/**"] },
              options: { entryPoint: "integrations/waitrose/worker.ts" },
            },
          },
        ],
      ],
    });

    // First use: the material has no accessToken, so substitution misses, the
    // strategy runs the NewSession login inside the Secret DO, and the retried
    // request lands — the fixture's ids derive from the login username.
    const context = await integrations.waitrose.mum.shoppingContext();
    expect(context).toEqual({
      customerId: `customer-${username}`,
      customerOrderId: `order-${username}`,
      customerOrderState: "PENDING",
      defaultBranchId: "branch-petshop",
    });

    // Force a real 401 (epoch bump kills the stored session) and call again:
    // re-login IS the refresh — the same strategy re-mints and the retry wins.
    await petshopExpireTokens();
    const trolley = await integrations.waitrose.mum.trolley();
    expect(trolley.trolley.orderId).toBe(`order-${username}`);
    expect(trolley.trolley.trolleyItems).toHaveLength(1);

    // Confinement: describe() leaks neither the password nor a session token
    // (hasMaterial is the only material-shaped fact), and uses are audited.
    const described = await secret.describe();
    expect(JSON.stringify(described)).not.toContain("correct-horse");
    expect(described.hasMaterial).toBe(true);
    await waitForCondition(async () => (await secret.describe()).audit.usedCount >= 2, {
      description: "waitrose/mum usage audit to fold",
    });
  });
});
