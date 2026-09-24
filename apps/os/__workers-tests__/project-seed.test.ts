import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { appConfigOf, atRestKeysOf } from "../src/app-config.ts";
import { decryptSecretMaterial } from "../src/secret-at-rest.ts";
import { EncryptedSecretSeed } from "../scripts/project-seed-format.ts";
import { adminCredentials, openSession, stub } from "./support.ts";

test("operator exports the current encrypted secret outside rewrites; fresh project restores it through set", async () => {
  const oldId = "prj_seed_old";
  const newId = "prj_seed_new";
  // the organization, and the two projects under ids the operator restores
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const organization = await admin.organizations.create({ name: "Seed" });
  for (const [id, slug] of [
    [oldId, "seed-old"],
    [newId, "seed-new"],
  ] as const) {
    using project = await admin.projects.create({
      project: slug,
      orgId: organization.id,
      restoreProjectId: id,
    });
    expect(await project.whoami()).toMatchObject({ projectId: id });
  }
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
  const exported = EncryptedSecretSeed.parse(await admin.exportProjectSecretForSeed(oldId, path));
  expect(JSON.stringify(exported)).not.toContain(material.apiKey);
  expect(exported).toMatchObject({ context: `${oldId}.iterate${path}` });
  const keys = atRestKeysOf(appConfigOf(env));
  const opened = await decryptSecretMaterial(exported.material, exported, keys);
  expect(opened).toEqual({ material, rotated: false });
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
  expect(restored.material).not.toMatchObject({ ciphertext: exported.material.ciphertext });
  expect(await decryptSecretMaterial(restored.material, restored, keys)).toEqual({
    material,
    rotated: false,
  });
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
