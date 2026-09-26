// project-host-sign-in.test.ts — a project host's session COOKIE at the edge (src/worker.ts with
// src/project-host-sign-in.ts): the cookie a browser holds for `<routingSlug>--<project>.<base>` stamps the
// member's principal on a read from anywhere and on a write or WebSocket upgrade from the host's own
// origin; a write or upgrade another site drove arrives anonymous. Bearer rows, and the sign-in
// challenge under both routings, are in e2e/ingress-project-host.e2e.test.ts.
import { exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { publishConfigWorker } from "../e2e/support/config-worker.ts";
import { signedInSession, SRC_ECHO_APP } from "./support.ts";

test("a member's session cookie on a project host: a read from anywhere and a write or WebSocket upgrade from the host itself carry the principal; a cross-site write or upgrade arrives anonymous", async () => {
  const { origin, cookie, principal } = await hostCookieSession("cookie-csrf");
  const seen = async (init: { method?: string; headers?: Record<string, string> }) => {
    const response = await exports.default.fetch(`${origin}/`, {
      method: init.method,
      headers: { ...init.headers, cookie },
      redirect: "manual",
    });
    expect(response, await response.clone().text()).toMatchObject({ status: 200 });
    return (await response.json<{ principal: unknown }>()).principal;
  };
  const rows: {
    name: string;
    method?: string;
    headers: Record<string, string>;
    principal?: unknown;
  }[] = [
    { name: "cross-site GET", method: "GET", headers: { origin: "https://evil.test" }, principal },
    { name: "same-origin POST", method: "POST", headers: { origin }, principal },
    { name: "POST with no Origin", method: "POST", headers: {}, principal },
    { name: "cross-site POST", method: "POST", headers: { origin: "https://evil.test" } },
    {
      name: "POST from a sibling project host",
      method: "POST",
      headers: { origin: "https://other--cookie-csrf.projects.test" },
    },
    { name: "same-origin upgrade", headers: { upgrade: "websocket", origin }, principal },
    { name: "cross-site upgrade", headers: { upgrade: "websocket", origin: "https://evil.test" } },
  ];
  for (const row of rows)
    expect({ row: row.name, principal: await seen(row) }).toEqual({
      row: row.name,
      principal: row.principal ?? null,
    });
});

/** A person signed in to the platform, owning project `slug` whose config worker is the echo app, then
 *  signed in on `echo--<slug>.projects.test` through that host's own `/.auth/login`: its client
 *  document, consent to the project, the callback — the host's session cookie. */
async function hostCookieSession(slug: string) {
  const email = `${slug}@example.com`;
  const root = await signedInSession(email);
  const itx = await root.projects.create({ project: slug });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const { projectId } = await itx.whoami();
  const principal = await root.whoami();
  // the issuer fetches the host's client document and the host its token: both are this worker
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    exports.default.fetch(new Request(input, init)),
  );
  const origin = `https://echo--${slug}.projects.test`;
  const start = await exports.default.fetch(`${origin}/.auth/login?next=/`, { redirect: "manual" });
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const approved = await root.consent.approve({
    query: new URL(start.headers.get("location")!).search,
    projects: [projectId],
  });
  if ("error" in approved) throw new Error(approved.error);
  const callback = await exports.default.fetch(approved.redirectTo, {
    redirect: "manual",
    headers: { cookie },
  });
  expect(callback, await callback.clone().text()).toMatchObject({ status: 303 });
  return { origin, cookie, principal };
}
