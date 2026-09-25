// secret-sockets.e2e.test.ts — OUTBOUND WEBSOCKETS THROUGH A SECRET on a deployed worker, against the
// deployed pet shop's gateways (apps/dummy-petshop src/gateway.ts), which validate a real sealed
// token and close 4001 on anything else. Loaded code dials with its plain `fetch` (its context's
// egress), `https://` plus `Upgrade: websocket` — workerd's fetch refuses a `wss://` URL. Two auth
// shapes: the OpenAI-Realtime one (`/gateway-header`, the bearer on the UPGRADE, substituted like
// any header) and the Discord one (`/gateway`, the token inside the IDENTIFY FRAME, substituted only
// when the upgrade names its secret in `x-itx-secret-frames`). Each through a project's own secret
// and through a person's secret LENT to the project, whose use crosses the borrowed path to the
// lender's context and facet on fetch channels (a 101's socket crosses no Workers-RPC call).
// Deployed only: the local worker cannot make an outbound upgrade (secrets.e2e.test.ts). The
// in-process proof of every hop is __workers-tests__/secret-sockets-over-lends.test.ts.
import { expect } from "vitest";
import { cookieSession, freshCtx, openItx } from "./support/client.ts";
import { petshopBaseUrl, petshopLegacyBearer } from "./support/petshop.ts";
import { issuerCookie } from "./support/principal.ts";
import { deployedOnly, freshDnsSafeProjectSlug } from "./support/project-host.ts";
import { dialWebSocket } from "./support/websocket-dialler.ts";

const FRAME_TOKEN = 'getSecret("/secrets/shop")';
const IDENTIFY = JSON.stringify({ op: "identify", token: FRAME_TOKEN });
const ACCEPTED = { status: 101, ops: ["hello", "ready", "dispatch", "echo"], close: 1000 };

deployedOnly.for([
  {
    row: "a project's own secret, the bearer on the upgrade (/gateway-header)",
    secret: "own",
    path: "/gateway-header",
    headers: { authorization: `Bearer ${FRAME_TOKEN}` },
    identify: null,
    expected: ACCEPTED,
  },
  {
    row: "a person's secret lent to the project, the bearer on the upgrade (/gateway-header)",
    secret: "lent",
    path: "/gateway-header",
    headers: { authorization: `Bearer ${FRAME_TOKEN}` },
    identify: null,
    expected: ACCEPTED,
  },
  {
    row: "a project's own secret, the token in the IDENTIFY frame (/gateway, x-itx-secret-frames)",
    secret: "own",
    path: "/gateway",
    headers: { "x-itx-secret-frames": FRAME_TOKEN },
    identify: IDENTIFY,
    expected: ACCEPTED,
  },
  {
    row: "a person's secret lent to the project, the token in the IDENTIFY frame (/gateway, x-itx-secret-frames)",
    secret: "lent",
    path: "/gateway",
    headers: { "x-itx-secret-frames": FRAME_TOKEN },
    identify: IDENTIFY,
    expected: ACCEPTED,
  },
  {
    row: "without x-itx-secret-frames the placeholder reaches the shop literally, which refuses it, 4001",
    secret: "own",
    path: "/gateway",
    headers: {},
    identify: IDENTIFY,
    expected: { status: 101, ops: ["hello", "invalid"], close: 4001 },
  },
] as const)("DEPLOYED: an outbound WebSocket through $row", async (row) => {
  const shop = petshopBaseUrl();
  const token = await petshopLegacyBearer(`${freshDnsSafeProjectSlug("ws")}@example.com`);
  const itx = row.secret === "own" ? await ownSecret(shop, token) : await lentSecret(shop, token);
  const dialled = await dialWebSocket(itx, `${shop}${row.path}`, row.headers, row.identify);
  expect(dialled).toEqual(row.expected);
  expect(JSON.stringify(dialled)).not.toContain(token);
});

/** A fresh project whose own `/secrets/shop` holds `token`, pinned to the shop. */
async function ownSecret(shop: string, token: string) {
  const itx = openItx(freshCtx("secret-sockets"));
  await itx.secrets.set("/secrets/shop", token, { urls: [shop] });
  return itx;
}

/** A person's `/secrets/shop-mine` holding `token`, lent to a project they create as
 *  `/secrets/shop`: the project's itx, as that person. */
async function lentSecret(shop: string, token: string) {
  const email = `${freshDnsSafeProjectSlug("ws-lender")}@example.com`;
  const api: any = await cookieSession(await issuerCookie(email));
  const itx = await api.projects.create({ project: freshDnsSafeProjectSlug("ws-lend") });
  const { projectId } = await itx.whoami();
  await api.user.secrets.set("/secrets/shop-mine", token, { urls: [shop] });
  await api.user.secrets.lend("/secrets/shop-mine", { to: projectId, as: "/secrets/shop" });
  return itx;
}
