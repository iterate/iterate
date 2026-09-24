import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { appConfigOf, atRestKeysOf } from "../src/app-config.ts";
import { decryptSecretMaterial } from "../src/secret-at-rest.ts";
import {
  EncryptedSecretSeed,
  ProjectSeed,
  captureHostnames,
  restoreHostnames,
} from "../scripts/project-seed-format.ts";
import {
  adminCredentials,
  controlPlaneStub,
  fakeCloudflareCustomHostnames,
  openSession,
  stub,
} from "./support.ts";

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

test("a project's hostnames round-trip through a seed: capture records the ones it serves, apply asks again for each it lacks and waits for the answers, a rerun asks nothing", async () => {
  const cloudflare = fakeCloudflareCustomHostnames();
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const project = await admin.projects.create({ project: "seed-hostnames" });
  const { projectId } = await project.whoami();
  const hostnameFacts = async (type: string) =>
    (
      (await project.invoke(["itx", ["readEvents", 0, 1000]])) as {
        events: { type: string }[];
      }
    ).events.filter((event) => event.type === `events.iterate.com/project/hostname-${type}`);
  // the owner adds two, as the dash does: one is served; the other, under the deployment's own
  // zone, is refused and was never the project's
  for (const hostname of ["www.seeded.test", "x.projects.test"]) {
    const [asked] = await project.append({
      type: "events.iterate.com/project/hostname-add-requested",
      payload: { hostname },
    });
    await project.waitForEvent({
      type: "events.iterate.com/project/hostname-add-answered",
      afterOffset: asked.offset,
      timeoutMs: 10_000,
    });
  }
  // capture, and the archive's JSON
  const archived = ProjectSeed.shape.hostnames.parse(
    JSON.parse(JSON.stringify(await captureHostnames(project))),
  );
  expect(archived).toEqual(["www.seeded.test"]);
  // the erase, as far as the hostname goes: its custom hostname deleted, its claim released
  const [removal] = await project.append({
    type: "events.iterate.com/project/hostname-remove-requested",
    payload: { hostname: "www.seeded.test" },
  });
  await project.waitForEvent({
    type: "events.iterate.com/project/hostname-removed",
    afterOffset: removal.offset,
    timeoutMs: 10_000,
  });
  expect(cloudflare).toMatchObject({ hostnames: [] });
  expect(await captureHostnames(project)).toEqual([]);
  // apply: asked again, answered, served — the same capture again
  expect(await restoreHostnames(project, archived, { timeoutMs: 10_000 })).toEqual([
    { hostname: "www.seeded.test", asked: true, status: "pending, certificate unknown" },
  ]);
  expect(cloudflare).toMatchObject({ hostnames: ["www.seeded.test"] });
  expect(await controlPlaneStub().projectByHostname(["www.seeded.test"])).toMatchObject({
    project: { id: projectId },
  });
  expect(await captureHostnames(project)).toEqual(archived);
  // a rerun asks nothing
  const requests = (await hostnameFacts("add-requested")).length;
  expect(await restoreHostnames(project, archived, { timeoutMs: 10_000 })).toEqual([
    { hostname: "www.seeded.test", asked: false, status: "pending, certificate unknown" },
  ]);
  expect(await hostnameFacts("add-requested")).toHaveLength(requests);
  // a hostname the deployment refuses fails the restore, naming it
  await expect(
    restoreHostnames(project, ["x.projects.test"], { timeoutMs: 10_000 }),
  ).rejects.toThrow(/refused: x\.projects\.test \(.+\)/);
});

test("apply never takes a hostname another project holds: the restore fails naming it, the holder keeps it, and Cloudflare is not asked", async () => {
  const cloudflare = fakeCloudflareCustomHostnames();
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const holder = await admin.projects.create({ project: "seed-hostname-holder" });
  const { projectId: holderId } = await holder.whoami();
  const [asked] = await holder.append({
    type: "events.iterate.com/project/hostname-add-requested",
    payload: { hostname: "www.held.test" },
  });
  await holder.waitForEvent({
    type: "events.iterate.com/project/hostname-add-answered",
    afterOffset: asked.offset,
    timeoutMs: 10_000,
  });
  const writes = [...cloudflare.writes];
  const restored = await admin.projects.create({ project: "seed-hostname-restored" });
  await expect(
    restoreHostnames(restored, ["www.held.test"], { timeoutMs: 10_000 }),
  ).rejects.toThrow(/refused: www\.held\.test \(.*belongs to another project/);
  expect(await controlPlaneStub().projectByHostname(["www.held.test"])).toMatchObject({
    project: { id: holderId },
  });
  expect(cloudflare).toMatchObject({ writes, hostnames: ["www.held.test"] });
  expect(await captureHostnames(restored)).toEqual([]);
});

test("after a real erase the zone still holds the custom hostname: apply's request finds it active, creates none, and the project serves it", async () => {
  // what erase-data leaves: the Cloudflare custom hostname, validated; no claim, no project events
  const cloudflare = fakeCloudflareCustomHostnames({ active: ["kept.erased.test"] });
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const project = await admin.projects.create({ project: "seed-hostname-erased" });
  const { projectId } = await project.whoami();
  expect(await captureHostnames(project)).toEqual([]);
  expect(await restoreHostnames(project, ["kept.erased.test"], { timeoutMs: 10_000 })).toEqual([
    { hostname: "kept.erased.test", asked: true, status: "active, certificate active" },
  ]);
  expect(cloudflare).toMatchObject({ writes: [] });
  expect(await controlPlaneStub().projectByHostname(["kept.erased.test"])).toMatchObject({
    project: { id: projectId },
  });
  expect(await captureHostnames(project)).toEqual(["kept.erased.test"]);
});
