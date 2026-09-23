import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { appConfigOf, atRestKeysOf } from "../src/app-config.ts";
import { decryptSecretMaterial } from "../src/secret-at-rest.ts";
import { EncryptedSecretSeed } from "../scripts/project-seed-format.ts";
import { adminCredentials, applyDirectorySchema, openSession, stub } from "./support.ts";

test("operator exports the current encrypted secret outside rewrites; fresh project restores it through set", async () => {
  await applyDirectorySchema();
  const db = (env as unknown as { DB: D1Database }).DB;
  const oldId = "prj_seed_old";
  const newId = "prj_seed_new";
  await db.batch([
    db.prepare("INSERT INTO orgs(id,name) VALUES ('org_seed','Seed')"),
    ...[oldId, newId].map((id) =>
      db.prepare("INSERT INTO projects(id,slug,org_id) VALUES (?,?,?)").bind(id, id, "org_seed"),
    ),
  ]);
  const path = "/secrets/stripe";
  const root = stub(oldId);
  const old = stub(`${oldId}.iterate${path}`);
  const material = { apiKey: "test-sensitive-api-key", refreshToken: "test-sensitive-refresh" };
  await root.invoke([
    "itx",
    "secrets",
    ["set", path, material, { urls: ["https://api.stripe.com"] }],
  ]);
  await old.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.facets", target: null },
      },
    ],
  ]);
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const exported = EncryptedSecretSeed.parse(await admin.exportProjectSecretForSeed(oldId, path));
  expect(JSON.stringify(exported)).not.toContain(material.apiKey);
  expect(exported.context).toBe(`${oldId}.iterate${path}`);
  const keys = atRestKeysOf(appConfigOf(env));
  const opened = await decryptSecretMaterial(exported.material, exported, keys);
  expect(opened.material).toEqual(material);
  await expect(
    decryptSecretMaterial(
      exported.material,
      { ...exported, context: `${newId}.iterate${path}` },
      keys,
    ),
  ).rejects.toThrow();
  await stub(newId).invoke([
    "itx",
    "secrets",
    ["set", path, opened.material, { urls: exported.urls, refresh: exported.refresh }],
  ]);
  const restored = EncryptedSecretSeed.parse(await admin.exportProjectSecretForSeed(newId, path));
  expect(restored.material.ciphertext).not.toBe(exported.material.ciphertext);
  expect((await decryptSecretMaterial(restored.material, restored, keys)).material).toEqual(
    material,
  );
  const user = session.authenticate({ ...adminCredentials(), as: { email: "owner@example.com" } });
  await expect(user.exportProjectSecretForSeed(oldId, path)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const denied = await Promise.resolve(
    stub(`${newId}.iterate${path}`).invoke([
      "itx",
      "facets",
      ["get", "secret"],
      ["exportForProjectSeed", "wrong"],
    ]),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(denied).toMatchObject({ code: "FORBIDDEN" });
  await stub(newId).invoke(["itx", "secrets", ["delete", path]]);
  await expect(admin.exportProjectSecretForSeed(newId, path)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});
