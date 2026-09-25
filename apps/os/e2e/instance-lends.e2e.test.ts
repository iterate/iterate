// instance-lends.e2e.test.ts — THE DEPLOYMENT'S OWN SECRETS on a deployed worker: the operator (the
// admin bearer's `session.global`) sets `global:/secrets/<name>` to a pet-shop bearer pinned to the
// shop and lends it to a project it creates. The project's plain HTTP and its loaded code's outbound
// WebSocket (`/gateway-header`, the bearer on the upgrade: the OpenAI-Realtime shape) reach the shop
// through the lend, each use metered on the instance's log with the borrower; a project's own key at
// the path is never replaced; the revocation is a 502.
//
// The lend here is to ONE project: a lend to every project is state of the whole shared preview, and
// every project another file creates while it stands would borrow it and list it among its secrets
// (secrets-connections.e2e.test.ts pins a new project's list empty). Lending to every project, a new
// project borrowing it and a kept path are pinned in __workers-tests__/instance-lends.test.ts, and
// the WebSocket through that lend in __workers-tests__/secret-sockets-over-lends.test.ts.
import { expect } from "vitest";
import { adminCredentials, readAll, session, until } from "./support/client.ts";
import { petshopBaseUrl, petshopLegacyBearer } from "./support/petshop.ts";
import { deployedOnly, freshDnsSafeProjectSlug } from "./support/project-host.ts";
import { dialWebSocket } from "./support/websocket-dialler.ts";

const BEARER = 'Bearer getSecret("/secrets/petshop")';

deployedOnly(
  "DEPLOYED: the instance's pet-shop key lent to a project: /api/me and a WebSocket reach the shop through it, secret/used names the borrower, a project's own key stays, and the revocation is a 502",
  async () => {
    const shop = petshopBaseUrl();
    const token = await petshopLegacyBearer(
      `${freshDnsSafeProjectSlug("instance-key")}@example.com`,
    );
    const operator = session().authenticate(adminCredentials());
    const global = operator.global;
    const name = `/secrets/${freshDnsSafeProjectSlug("petshop-key")}`;
    await global.secrets.set(name, token, { urls: [shop] });
    // the instance's secret goes with the row, and every lend of it with the secret
    try {
      await lentAndUsed(operator, global, { shop, name });
    } finally {
      await global.secrets.delete(name);
    }
  },
);

/** The row's story once the instance's secret `name` holds the shop's bearer: lent to a project it
 *  creates, used, refused over a project's own key, revoked. */
async function lentAndUsed(
  operator: any,
  global: any,
  { shop, name }: { shop: string; name: string },
) {
  const borrower = await operator.projects.create({
    project: freshDnsSafeProjectSlug("instance-borrower"),
  });
  const { projectId } = await borrower.whoami();
  const { lendId } = await global.secrets.lend(name, { to: projectId, as: "/secrets/petshop" });

  expect(await me(borrower, shop)).toMatchObject({ status: 200 });
  expect(
    await dialWebSocket(borrower, `${shop}/gateway-header`, { authorization: BEARER }, null),
  ).toEqual({ status: 101, ops: ["hello", "ready", "dispatch", "echo"], close: 1000 });
  // each dispatch lands on the INSTANCE's secret's log, best-effort after the answer
  const used = await until("secret/used names the borrower", async () => {
    const uses = (await readAll(global.cd(name)))
      .filter((event) => event.type === "events.iterate.com/secret/used")
      .map((event) => event.payload);
    return uses.length >= 2 && uses;
  });
  expect(used).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "GET", status: 200, borrower: projectId }),
      expect.objectContaining({ status: 101, borrower: projectId }),
    ]),
  );

  const own = await operator.projects.create({
    project: freshDnsSafeProjectSlug("instance-own"),
  });
  await own.secrets.set("/secrets/petshop", "the project's own key", { urls: [shop] });
  const { projectId: ownId } = await own.whoami();
  await expect(global.secrets.lend(name, { to: ownId, as: "/secrets/petshop" })).rejects.toThrow(
    /a secret of its own/,
  );
  expect(await me(own, shop)).toMatchObject({ status: 401 });

  await global.secrets.revokeLend(name, lendId);
  expect(await me(borrower, shop)).toMatchObject({ status: 502 });
}

/** The shop's `/api/me` through `itx`'s egress, its bearer the project's `/secrets/petshop`. */
async function me(itx: any, shop: string) {
  const response: Response = await itx.fetch(
    new Request(`${shop}/api/me`, { headers: { authorization: BEARER } }),
  );
  return { status: response.status, body: await response.text() };
}
