// The directory schema (src/control-plane.sql) is applied by the worker itself, at boot — once per
// isolate, idempotent — so a fresh deployment (`wrangler deploy` into an empty D1) serves without a
// deploy-time migration step. This file deliberately does NOT run support.ts's applyDirectorySchema:
// its D1 is empty until the worker's first request.
import { env, SELF } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { Env } from "../src/control-plane.ts";

const db = (env as unknown as Env).DB;
const tables = async () =>
  (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);

test("the first request applies the directory schema; the next finds it there (idempotent), and the directory then works", async () => {
  expect(await tables()).not.toContain("users");
  const first = await SELF.fetch("https://control.test/version");
  expect(first.status).toBe(200);
  const applied = await tables();
  expect(applied).toEqual(expect.arrayContaining(["users", "orgs", "org_members", "projects"]));
  const second = await SELF.fetch("https://control.test/version");
  expect(second.status).toBe(200);
  expect(await tables()).toEqual(applied);
  // the directory is usable straight away: a sign-in creates its user row (the issuer's own OAuth
  // client fetches its metadata from this very origin: route that fetch back into the worker)
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    SELF.fetch(new Request(input, init)),
  );
  const login = await SELF.fetch("https://control.test/login", {
    method: "POST",
    redirect: "manual",
    headers: { Origin: "https://control.test" },
    body: new URLSearchParams({
      email: "boot@directory.test",
      password: (env as unknown as Env).APP_CONFIG_LOGIN__PASSWORD!,
      next: "/",
    }),
  });
  expect(login.status).toBe(302);
  expect(
    await db.prepare("SELECT email FROM users WHERE email = ?").bind("boot@directory.test").first(),
  ).toEqual({ email: "boot@directory.test" });
});
