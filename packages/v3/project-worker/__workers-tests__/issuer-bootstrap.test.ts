import { env, SELF } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Env } from "../src/control-plane.ts";
import type { Session } from "../src/session.ts";
import { directory } from "../src/directory.ts";
import { oauthHelpers, parseAuthorization } from "../src/oauth.ts";
import { applyDirectorySchema } from "./support.ts";

const bindings = env as unknown as Env;
const origin = "https://control.test";
beforeAll(applyDirectorySchema);
afterEach(() => vi.restoreAllMocks());

test("a verified identity can establish the ordinary app session without an issuer identity cookie", async () => {
  // Only the public DNS transport is replaced. The provider, code/PKCE exchange,
  // BrowserSession storage, public API admission and revocation are real.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const user = await directory(bindings.DB).upsertGoogleUser("1357924680", "bootstrap@example.com");
  const id = crypto.randomUUID();
  const session = bindings.BROWSER_SESSION.getByName(`${origin}:${id}`);
  const helpers = oauthHelpers(bindings);
  const authorization = await session.begin(
    { origin, issuer: origin, resource: `${origin}/api`, scopes: ["iterate", "account"] },
    "/authorize?original-client=preserved",
  );
  const request = await parseAuthorization(
    { ...bindings, OAUTH_PROVIDER: helpers },
    new Request(authorization),
  );
  const approved = await helpers.completeAuthorization({
    request,
    userId: user.id,
    scope: request.scope,
    metadata: { clientName: "Iterate" },
    revokeExistingGrants: false,
    props: {
      kind: "user-grant",
      version: 1,
      userId: user.id,
      email: user.email,
      projects: null,
      tokenKind: "oauth",
      deadline: Date.now() + 30 * 24 * 3600_000,
    },
  });
  const callback = new URL(approved.redirectTo).searchParams;
  expect(
    await session.complete({
      state: callback.get("state")!,
      issuer: callback.get("iss")!,
      code: callback.get("code")!,
      error: "",
    }),
  ).toEqual({ next: "/authorize?original-client=preserved" });
  const headers = { Cookie: `__Host-itx-session=${id}`, Origin: origin };
  const connected = await SELF.fetch(`${origin}/api`, {
    headers: { ...headers, Upgrade: "websocket" },
  });
  expect(connected.status).toBe(101);
  connected.webSocket!.accept();
  using api = newWebSocketRpcSession<Session>(connected.webSocket! as unknown as WebSocket);
  expect((await api.info()).principal).toEqual({ actor: user.id, email: user.email });
  expect((await api.grants.list()).items).toEqual([
    expect.objectContaining({ name: "Iterate", current: true }),
  ]);
  await api.logout();
  const refused = await SELF.fetch(`${origin}/api`, { method: "POST", headers, body: "" });
  expect(refused.status).toBe(401);
  expect(await session.bearer()).toBeNull();
});
