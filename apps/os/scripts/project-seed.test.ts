import { expect, test } from "vitest";
import { encryptSecretMaterial } from "../src/secret-at-rest.ts";
import {
  compareStructure,
  configTree,
  openProjectSeed,
  restorableHostnames,
  type DeploymentStructure,
} from "./project-seed-format.ts";

const keys = { current: "seed-encryption-key" };
test("current encrypted cells open with the deployment key without plaintext in the archive", async () => {
  const seed = await archive();
  expect(JSON.stringify(seed)).not.toContain("sensitive-key");
  expect((await openProjectSeed(seed, keys)).secrets[0]?.material).toEqual({
    apiKey: "sensitive-key",
  });
});
test.for(["key", "context", "path", "urls", "revision", "ciphertext"])(
  "wrong %s fails before restore",
  async (field) => {
    const seed = await archive();
    const secret = seed.secrets[0]!;
    if (field === "context") secret.context = "prj_other.iterate/secrets/stripe";
    if (field === "path") secret.path = "/secrets/other";
    if (field === "urls") secret.urls = ["https://evil.example.com"];
    if (field === "revision") secret.revision++;
    if (field === "ciphertext") secret.material.ciphertext = "AAAA";
    await expect(
      openProjectSeed(seed, field === "key" ? { current: "different-key" } : keys),
    ).rejects.toThrow();
  },
);
test("a retained previous key can recover an archive during key rotation", async () => {
  expect(
    (await openProjectSeed(await archive(), { current: "new-key", previous: keys.current }))
      .secrets,
  ).toHaveLength(1);
});
test("modified config files and unsafe file paths cannot be restored", async () => {
  const seed = await archive();
  seed.config.files[0]!.content = "tampered";
  await expect(openProjectSeed(seed, keys)).rejects.toThrow("Git tree");
  seed.config.files[0]!.path = "../outside";
  await expect(openProjectSeed(seed, keys)).rejects.toThrow("safe relative");
});
test("duplicate file or secret paths cannot silently shadow an archived entry", async () => {
  const seed = await archive();
  seed.config.files.push(seed.config.files[0]!);
  await expect(openProjectSeed(seed, keys)).rejects.toThrow("Duplicate config");
  seed.config.files.pop();
  seed.secrets.push(seed.secrets[0]!);
  await expect(openProjectSeed(seed, keys)).rejects.toThrow("Duplicate secret");
});
test("hostnames: a well-formed one is kept; a malformed or repeated one is refused", async () => {
  const seed = await archive();
  expect((await openProjectSeed({ ...seed, hostnames: ["garple.com"] }, keys)).seed).toMatchObject({
    hostnames: ["garple.com"],
  });
  // the processor's own rule (src/project/custom-hostnames.ts HOSTNAME): two labels or more, no empty one
  for (const hostname of ["https://garple.com/", "a..b", "localhost", "-garple.com"])
    await expect(openProjectSeed({ ...seed, hostnames: [hostname] }, keys)).rejects.toThrow();
  await expect(
    openProjectSeed({ ...seed, hostnames: ["garple.com", "garple.com"] }, keys),
  ).rejects.toThrow("Duplicate hostname: garple.com");
});
test("the primary hostname: one of the hostnames, or null", async () => {
  const seed = { ...(await archive()), hostnames: ["garple.com"] };
  expect((await openProjectSeed(seed, keys)).seed).toMatchObject({ primaryHostname: null });
  const { primaryHostname: _, ...withoutPrimary } = seed;
  await expect(openProjectSeed(withoutPrimary, keys)).rejects.toThrow();
  expect(
    (await openProjectSeed({ ...seed, primaryHostname: "garple.com" }, keys)).seed,
  ).toMatchObject({ primaryHostname: "garple.com" });
  await expect(openProjectSeed({ ...seed, primaryHostname: "other.com" }, keys)).rejects.toThrow(
    "Primary hostname other.com is not one of the hostnames.",
  );
});
test("hostnames are restored only onto the deployment the seed was captured on", async () => {
  const { seed } = await openProjectSeed({ ...(await archive()), hostnames: ["garple.com"] }, keys);
  expect(restorableHostnames(seed, seed.source.platform)).toEqual(["garple.com"]);
  expect(restorableHostnames(seed, `${seed.source.platform.replace(/\/$/, "")}/`)).toEqual([
    "garple.com",
  ]);
  expect(restorableHostnames(seed, "https://os-pr3045.preview.example.test")).toEqual([]);
});
test("a recreation with fresh user and organization IDs matches; the empty admin org is a note", () => {
  expect(compareStructure(captured, recreated())).toEqual({
    problems: [],
    notes: ['empty organization "admin" was not recreated'],
  });
});
test("a missing member, a changed role, a project in another org and a missing org are problems", () => {
  const live = recreated();
  live.memberships.new_org_g = [
    { userId: "new_user_a", email: "jonas@nustom.com", role: "member" },
  ];
  live.projects[0]!.orgId = "new_org_l";
  expect(compareStructure(captured, live)).toMatchObject({
    problems: [
      'organization "garple" lacks member jonas@nustom.com owner',
      'organization "garple" lacks member misha@nustom.com owner',
      'project garple is in "Lupa\'s Organization", not "garple"',
    ],
  });
  live.organizations = live.organizations.filter((org) => org.name !== "Lupa's Organization");
  live.projects = live.projects.filter((project) => project.slug !== "lupa-s-organization");
  expect(compareStructure(captured, live)).toMatchObject({
    problems: expect.arrayContaining([
      `organization "Lupa's Organization" is missing`,
      "project lupa-s-organization (prj_l) is missing",
    ]),
  });
});
test("two organizations of one name are a problem; uncaptured rows and a user not back yet are notes", () => {
  const live = recreated();
  live.organizations.push({ id: "org_dupe", name: "garple", projects: 0 });
  live.users = live.users.filter((user) => user.email !== "lupa@example.com");
  live.users.push({ id: "user_new", email: "new@example.com" });
  const { problems, notes } = compareStructure(captured, live);
  expect(problems).toEqual(['organization "garple" exists 2 times']);
  expect(notes).toEqual(
    expect.arrayContaining([
      "user lupa@example.com has not signed in again yet",
      "user new@example.com was not captured",
    ]),
  );
});

async function archive() {
  const files = [
    { path: "worker.ts", content: "export default {fetch(){return new Response('restored')}}" },
  ];
  const binding = {
    context: "prj_old.iterate/secrets/stripe",
    urls: ["https://api.stripe.com"],
    revision: 7,
  };
  return {
    version: 1,
    capturedAt: "2026-09-22T12:00:00.000Z",
    source: { platform: "https://os.example.com", projectId: "prj_old" },
    project: "garple",
    organization: { name: "garple", members: [{ email: "jonas@nustom.com", role: "owner" }] },
    config: { files, commit: "a".repeat(40), tree: await configTree(files) },
    secrets: [
      {
        path: "/secrets/stripe",
        ...binding,
        refresh: null,
        material: await encryptSecretMaterial({ apiKey: "sensitive-key" }, binding, keys),
      },
    ],
    hostnames: [],
    primaryHostname: null,
  };
}

/** prd on 2026-09-24, cut down: two owners of garple, an org of one, the empty admin org. */
const captured: DeploymentStructure = {
  capturedAt: "2026-09-24T05:21:06.954Z",
  platform: "https://os.iterate.com",
  users: [
    { id: "user_a", email: "jonas@nustom.com" },
    { id: "user_b", email: "misha@nustom.com" },
    { id: "user_c", email: "lupa@example.com" },
  ],
  organizations: [
    { id: "org_admin", name: "admin", projects: 0 },
    { id: "org_g", name: "garple", projects: 1 },
    { id: "org_l", name: "Lupa's Organization", projects: 1 },
  ],
  memberships: {
    org_admin: [],
    org_g: [
      { userId: "user_a", email: "jonas@nustom.com", role: "owner" },
      { userId: "user_b", email: "misha@nustom.com", role: "owner" },
    ],
    org_l: [{ userId: "user_c", email: "lupa@example.com", role: "owner" }],
  },
  projects: [
    { id: "prj_g", slug: "garple", orgId: "org_g" },
    { id: "prj_l", slug: "lupa-s-organization", orgId: "org_l" },
  ],
};
/** The same people, organizations and projects after a recreation: every user and organization
 *  ID minted afresh, the project IDs kept, the admin org not yet created. */
const recreated = (): DeploymentStructure => ({
  ...captured,
  users: captured.users.map((user) => ({ ...user, id: `new_${user.id}` })),
  organizations: captured.organizations
    .filter((org) => org.id !== "org_admin")
    .map((org) => ({ ...org, id: `new_${org.id}` })),
  memberships: Object.fromEntries(
    Object.entries(captured.memberships)
      .filter(([orgId]) => orgId !== "org_admin")
      .map(([orgId, members]) => [
        `new_${orgId}`,
        members.map((member) => ({ ...member, userId: `new_${member.userId}` })),
      ]),
  ),
  projects: captured.projects.map((project) => ({ ...project, orgId: `new_${project.orgId}` })),
});
