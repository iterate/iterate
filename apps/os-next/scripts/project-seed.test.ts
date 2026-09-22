import { expect, test } from "vitest";
import { encryptSecretMaterial } from "../src/secret-at-rest.ts";
import { configTree, openProjectSeed } from "./project-seed-format.ts";

const keys = { current: "seed-encryption-key" };
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
  };
}
test("current encrypted cells open with the deployment key without plaintext in the archive", async () => {
  const seed = await archive();
  expect(JSON.stringify(seed)).not.toContain("sensitive-key");
  expect((await openProjectSeed(seed, keys)).secrets[0]?.material).toEqual({
    apiKey: "sensitive-key",
  });
});
test.each(["key", "context", "path", "urls", "revision", "ciphertext"])(
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
