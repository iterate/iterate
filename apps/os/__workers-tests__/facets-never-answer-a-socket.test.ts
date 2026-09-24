// __workers-tests__/facets-never-answer-a-socket.test.ts — a facet reached BY ITX EXPRESSION answers
// RPC and plain HTTP, NEVER a WebSocket. A socket terminates at the edge (a session's /api pager
// socket on the context DO, a project host's lent-stub upgrade leg) and the facet behind it is
// reached by itx expression; so the context DO's `facets.get` door refuses an upgrade aimed at a
// facet, coded FACET_NO_UPGRADE, BEFORE the facet is even materialized — and a test's direct release
// can abort an idle facet with nothing to lose (a socket a facet HELD would die with it, 1006, unseen
// by the parent: measured 2026-09-13, the reason for this rule). The one facet that PROXIES a socket
// — the `secret` facet, reached by egress, never by expression — is the other test:
// secret-facet-proxies-a-socket.test.ts.
//
// Pinned in the `workers` vitest project (inside workerd) because the refusal must be seen on the
// production route — a project host `<app>--<project>.projects.test`, the edge's `x-itx-expression:
// itx.apps.<app>`, the rewrite rule provided at `itx.apps.<app>` whose target is the hosting
// spelling — and at the DO's own `invoke` method, where a caller passes the Request itself.

import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { errorCode } from "iterate/next/lib";
import { adminCredentials, openSession, stub } from "./support.ts";

/** A stateful app hosted as a facet: `fetch()` serves plain HTTP AND would upgrade a WebSocket if
 *  asked — so the refusal below is the platform's, not the class's. `hits()` is its RPC method. */
const SRC_APP_FACET = /* js */ `
import { FacetDurableObject } from "./processor.js";
export class AppFacetDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hits"];
  #hits = 0;
  fetch(request) {
    this.#hits++;
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({ served: "plain-http", hits: this.#hits, path: new URL(request.url).pathname });
  }
  hits() { return this.#hits; }
}
`;
const APP_FACET_SPEC = { source: { "cap.js": SRC_APP_FACET }, className: "AppFacetDurableObject" };

/** The project in the directory, its root context on the admin session, and the app provided at
 *  `itx.apps.app` — the rewrite rule whose target is the hosting spelling. */
async function projectWithAppFacet(project: string) {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project });
  await itx.provide("itx.apps.app", ["itx", "facets", ["get", "app", APP_FACET_SPEC]]);
  const { projectId } = (await itx.invoke("itx.whoami()")) as { projectId: string };
  return { ctx: projectId, host: `https://app--${project}.projects.test` };
}

test("a project host reaches a facet-hosted app over plain HTTP and RPC; a WebSocket upgrade on it is refused (400, FACET_NO_UPGRADE) and materializes nothing", async () => {
  const { ctx, host } = await projectWithAppFacet("facet-app");

  // The upgrade FIRST — before any plain call: a refusal that touched the facet would show as a hit.
  const upgrade = await exports.default.fetch(`${host}/live`, {
    headers: { Upgrade: "websocket" },
  });
  expect(upgrade.status).toBe(400);
  expect(upgrade.webSocket).toBeNull();
  expect(await upgrade.text()).toMatch(/never a WebSocket/);

  // Plain HTTP through the same route: the facet's own fetch answers.
  const page = await exports.default.fetch(`${host}/index`);
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({ served: "plain-http", hits: 1, path: "/index" });
  // RPC through the itx expression: the same instance (the refused upgrade never reached it).
  expect(await stub(ctx).invoke("itx.facets.get('app').hits()")).toBe(1);
});

test("the DO's invoke method refuses the same upgrade, coded, on a facet it has never started", async () => {
  const ctx = "prj_facet_no_upgrade_door";
  const upgrade = new Request("https://facet.internal/live", { headers: { Upgrade: "websocket" } });
  const outcome = await (
    stub(ctx).invoke([
      "itx",
      "facets",
      ["get", "app", APP_FACET_SPEC],
      ["fetch", upgrade],
    ]) as Promise<unknown>
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, code: errorCode(error), message: String(error) }),
  );
  expect(outcome).toMatchObject({ ok: false, code: "FACET_NO_UPGRADE" });
  // Nothing was materialized: a bare-name call finds no facet to address.
  const bare = await (stub(ctx).invoke("itx.facets.get('app').hits()") as Promise<unknown>).then(
    () => "answered",
    (error: unknown) => errorCode(error),
  );
  expect(bare).toBe("NO_FACET");
  // A plain fetch through `FacetHost#callFacet` hosts it and answers — the ordinary method walk.
  const plain = (await stub(ctx).invoke([
    "itx",
    "facets",
    ["get", "app", APP_FACET_SPEC],
    ["fetch", new Request("https://facet.internal/page")],
  ])) as Response;
  expect(plain.status).toBe(200);
  expect(await plain.json()).toMatchObject({ served: "plain-http", path: "/page" });
});
