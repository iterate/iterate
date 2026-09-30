import { env } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { appConfigOf, atRestKeysOf } from "../../../core/os/src/app-config.ts";
import { decryptSecretMaterial } from "../../../core/os/src/secret-at-rest.ts";
import {
  EncryptedSecretSeed,
  ProjectSeed,
  captureFetchRoutes,
  captureHostnames,
  capturePrimaryHostname,
  restoreFetchRoutes,
  restoreHostnames,
  restorePrimaryHostname,
} from "../../../core/os/scripts/project-seed-format.ts";
import {
  adminCredentials,
  catalog,
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
  cloudflare.owners["www.seeded.test"] = projectId; // the owner's ownership record
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
      type: "events.iterate.com/project/hostname-add-settled",
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
  expect(await restoreHostnames(project, archived)).toEqual([
    { hostname: "www.seeded.test", asked: true, status: "pending, certificate unknown" },
  ]);
  expect(cloudflare).toMatchObject({ hostnames: ["www.seeded.test"] });
  expect(await catalog().projectByHostname(["www.seeded.test"])).toMatchObject({
    project: { id: projectId },
  });
  expect(await captureHostnames(project)).toEqual(archived);
  // a rerun asks nothing
  const requests = (await hostnameFacts("add-requested")).length;
  expect(await restoreHostnames(project, archived)).toEqual([
    { hostname: "www.seeded.test", asked: false, status: "pending, certificate unknown" },
  ]);
  expect(await hostnameFacts("add-requested")).toHaveLength(requests);
  // a hostname the deployment refuses fails the restore, naming it
  await expect(restoreHostnames(project, ["x.projects.test"])).rejects.toThrow(
    /refused: x\.projects\.test \(.+\)/,
  );
});

test("apply never takes a hostname another project holds, even with a record naming the restored one: the restore fails naming it, the holder keeps it, and Cloudflare is not asked", async () => {
  const cloudflare = fakeCloudflareCustomHostnames();
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const holder = await admin.projects.create({ project: "seed-hostname-holder" });
  const { projectId: holderId } = await holder.whoami();
  cloudflare.owners["www.held.test"] = holderId;
  const [asked] = await holder.append({
    type: "events.iterate.com/project/hostname-add-requested",
    payload: { hostname: "www.held.test" },
  });
  await holder.waitForEvent({
    type: "events.iterate.com/project/hostname-add-settled",
    afterOffset: asked.offset,
    timeoutMs: 10_000,
  });
  const writes = [...cloudflare.writes];
  const restored = await admin.projects.create({ project: "seed-hostname-restored" });
  cloudflare.owners["www.held.test"] = (await restored.whoami()).projectId;
  await expect(restoreHostnames(restored, ["www.held.test"])).rejects.toThrow(
    /refused: www\.held\.test \(.*belongs to another project/,
  );
  expect(await catalog().projectByHostname(["www.held.test"])).toMatchObject({
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
  cloudflare.owners["kept.erased.test"] = projectId; // the owner's record outlives the erase
  expect(await captureHostnames(project)).toEqual([]);
  expect(await restoreHostnames(project, ["kept.erased.test"])).toEqual([
    { hostname: "kept.erased.test", asked: true, status: "active, certificate active" },
  ]);
  expect(cloudflare).toMatchObject({ writes: [] });
  expect(await catalog().projectByHostname(["kept.erased.test"])).toMatchObject({
    project: { id: projectId },
  });
  expect(await captureHostnames(project)).toEqual(["kept.erased.test"]);
});

test("a project's primary hostname round-trips through a seed: capture records it, apply configures it again after the hostnames, a rerun asks nothing, and a hostname not yet live is not made primary", async () => {
  const cloudflare = fakeCloudflareCustomHostnames({ active: ["www.primary.test"] });
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const project = await admin.projects.create({ project: "seed-primary-hostname" });
  const { projectId } = await project.whoami();
  cloudflare.owners["www.primary.test"] = projectId;
  cloudflare.owners["pending.primary.test"] = projectId;
  const primaryFacts = async () =>
    (
      (await project.invoke(["itx", ["readEvents", 0, 1000]])) as { events: { type: string }[] }
    ).events.filter(
      (event) => event.type === "events.iterate.com/project/primary-hostname-configured",
    );
  // the owner adds a live hostname and a pending one, and makes the live one primary
  for (const hostname of ["www.primary.test", "pending.primary.test"]) {
    const [asked] = await project.append({
      type: "events.iterate.com/project/hostname-add-requested",
      payload: { hostname },
    });
    await project.waitForEvent({
      type: "events.iterate.com/project/hostname-add-settled",
      afterOffset: asked.offset,
      timeoutMs: 10_000,
    });
  }
  const [configured] = await project.append({
    type: "events.iterate.com/project/primary-hostname-configured",
    payload: { hostname: "www.primary.test" },
  });
  await project.invoke([
    "itx",
    "facets",
    ["get", "project"],
    ["waitUntilProcessed", { offset: configured.offset }],
  ]);
  // capture, and the archive's JSON
  const hostnames = await captureHostnames(project);
  const primaryHostname = ProjectSeed.shape.primaryHostname.parse(
    JSON.parse(JSON.stringify(await capturePrimaryHostname(project))),
  );
  expect({ hostnames, primaryHostname }).toEqual({
    hostnames: ["pending.primary.test", "www.primary.test"],
    primaryHostname: "www.primary.test",
  });
  // the erase, as far as the hostnames go
  for (const hostname of hostnames) {
    const [removal] = await project.append({
      type: "events.iterate.com/project/hostname-remove-requested",
      payload: { hostname },
    });
    await project.waitForEvent({
      type: "events.iterate.com/project/hostname-removed",
      afterOffset: removal.offset,
      timeoutMs: 10_000,
    });
  }
  expect(await capturePrimaryHostname(project)).toBeNull();
  // apply: the hostnames first, then the primary
  await restoreHostnames(project, hostnames);
  expect(await restorePrimaryHostname(project, primaryHostname!)).toEqual({
    hostname: "www.primary.test",
    asked: true,
    primary: true,
  });
  expect(await capturePrimaryHostname(project)).toBe("www.primary.test");
  // a rerun asks nothing
  const facts = (await primaryFacts()).length;
  expect(await restorePrimaryHostname(project, primaryHostname!)).toEqual({
    hostname: "www.primary.test",
    asked: false,
    primary: true,
  });
  expect(await primaryFacts()).toHaveLength(facts);
  // a hostname whose certificate is not active is asked for and not made primary; the primary stays
  expect(await restorePrimaryHostname(project, "pending.primary.test")).toEqual({
    hostname: "pending.primary.test",
    asked: true,
    primary: false,
  });
  expect(await capturePrimaryHostname(project)).toBe("www.primary.test");
});

test("a project's fetch routes round-trip through a seed: capture records each but a tunnel's, apply sets each again, a rerun sets nothing, and a changed route of the same name goes back to the archived one", async () => {
  const session = await openSession();
  const admin = session.authenticate(adminCredentials());
  const project = await admin.projects.create({ project: "seed-fetch-routes" });
  // the members-only Docs routes prd's `iterate` project has (scripts/preview-config.ts
  // `proxiedAppRoute`'s shape), on its routing slug and on a hostname of its own
  const docs = {
    requestMatcher: { routingSlug: "docs" },
    target: [
      "itx",
      "workers",
      [
        "get",
        {
          source: {
            "package.json": '{"main":"worker.js"}',
            "worker.js":
              'export default { fetch: () => fetch("https://docs.iterate.workers.dev/") }',
          },
        },
      ],
    ],
    authRequirement: { visitors: "project-members" as const },
  };
  await project.fetchRoutes.set("docs", docs);
  await project.fetchRoutes.set("docs-iterate-com", {
    ...docs,
    requestMatcher: { url: { hostname: "docs.iterate.com" } },
    priority: 1,
  });
  // one whose target reaches nothing, carried as it stands
  await project.fetchRoutes.set("stale", {
    requestMatcher: { routingSlug: "stale" },
    target: "itx.tunnels.gone",
  });
  // and a running `iterate tunnel`'s, which rides its lend (packages/cli/src/tunnel.ts)
  const tunnel = await project.provide("itx.tunnels.blog", new LocalSite(), {
    fetchRoute: { fetchRouteName: "tunnel-blog", requestMatcher: { routingSlug: "blog" } },
  });
  expect(await project.fetchRoutes.list()).toMatchObject([
    { fetchRouteName: "docs-iterate-com" },
    { fetchRouteName: "docs" },
    { fetchRouteName: "stale" },
    { fetchRouteName: "tunnel-blog", target: ["itx", "tunnels", "blog"] },
  ]);

  // capture, and the archive's JSON
  const captured = await captureFetchRoutes(project);
  expect(captured).toMatchObject({ lent: ["tunnel-blog"] });
  const archived = ProjectSeed.shape.fetchRoutes.parse(JSON.parse(JSON.stringify(captured.routes)));
  expect(archived).toEqual([
    {
      fetchRouteName: "docs-iterate-com",
      ...docs,
      requestMatcher: { url: { hostname: "docs.iterate.com" } },
      priority: 1,
    },
    { fetchRouteName: "docs", ...docs, priority: 0 },
    {
      fetchRouteName: "stale",
      requestMatcher: { routingSlug: "stale" },
      target: ["itx", "tunnels", "gone"],
      authRequirement: null,
      priority: 0,
    },
  ]);

  // the erase, as far as the routes go: the tunnel's ends with its lend, the rest are gone
  tunnel[Symbol.dispose]();
  for (const { fetchRouteName } of archived) await project.fetchRoutes.set(fetchRouteName, null);
  await expect.poll(() => project.fetchRoutes.list()).toEqual([]);

  // apply: each set again, and the same capture again
  expect(await restoreFetchRoutes(project, archived)).toEqual([
    { fetchRouteName: "docs-iterate-com", set: true },
    { fetchRouteName: "docs", set: true },
    { fetchRouteName: "stale", set: true },
  ]);
  expect(await captureFetchRoutes(project)).toEqual({ routes: archived, lent: [] });
  expect(
    await project.fetchRoutes.match({ url: "https://docs.iterate.com/some/page", headers: {} }),
  ).toMatchObject({ fetchRouteName: "docs-iterate-com" });

  // a rerun sets nothing
  expect(await restoreFetchRoutes(project, archived)).toEqual([
    { fetchRouteName: "docs-iterate-com", set: false },
    { fetchRouteName: "docs", set: false },
    { fetchRouteName: "stale", set: false },
  ]);

  // a route changed since goes back to the archived one; a route the archive lacks is left alone
  await project.fetchRoutes.set("docs", { ...docs, authRequirement: null });
  await project.fetchRoutes.set("added-since", {
    ...docs,
    requestMatcher: { routingSlug: "added" },
  });
  expect(await restoreFetchRoutes(project, archived)).toEqual([
    { fetchRouteName: "docs-iterate-com", set: false },
    { fetchRouteName: "docs", set: true },
    { fetchRouteName: "stale", set: false },
  ]);
  expect(await captureFetchRoutes(project)).toMatchObject({
    routes: [
      archived[0],
      {
        fetchRouteName: "added-since",
        ...docs,
        requestMatcher: { routingSlug: "added" },
        priority: 0,
      },
      ...archived.slice(1),
    ],
  });
});

class LocalSite extends RpcTarget {
  fetch() {
    return new Response("local site");
  }
}
