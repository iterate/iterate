import { z } from "zod";
import { decryptSecretMaterial, type MaterialKeys } from "../src/secret-at-rest.ts";
import { normalizeSecretRecord } from "../src/secrets.ts";
import { hashObject, treeObjectsOf } from "../src/repo/git-wire.ts";

const Path = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "Config files must have safe relative Git paths",
  );
export const EncryptedSecretSeed = z.object({
  path: z.string().regex(/^\/secrets\/[a-zA-Z0-9._-]+$/),
  context: z.string().min(1),
  revision: z.number().int().positive(),
  urls: z.array(z.url()).min(1),
  refresh: z.unknown(),
  material: z.object({
    algorithm: z.literal("AES-256-GCM+SECRET-V1"),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  }),
});
export const ProjectSeed = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  source: z.object({ platform: z.url(), projectId: z.string().regex(/^prj_[a-zA-Z0-9_-]+$/) }),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  organization: z.object({
    name: z.string().trim().min(1),
    members: z.array(z.object({ email: z.email(), role: z.enum(["owner", "member"]) })).min(1),
  }),
  config: z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    tree: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.array(z.object({ path: Path, content: z.string() })).min(1),
  }),
  secrets: z.array(EncryptedSecretSeed),
});
export type ProjectSeed = z.infer<typeof ProjectSeed>;

export async function configTree(files: ProjectSeed["config"]["files"]) {
  const manifest = new Map<string, { oid: string; mode: string }>();
  for (const file of files) {
    if (manifest.has(file.path)) throw new Error(`Duplicate config path: ${file.path}`);
    for (const path of manifest.keys())
      if (path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`))
        throw new Error(`Conflicting config paths: ${path} and ${file.path}`);
    manifest.set(file.path, {
      mode: "100644",
      oid: await hashObject("blob", new TextEncoder().encode(file.content)),
    });
  }
  return (await treeObjectsOf(manifest)).rootOid;
}

/** All local validation/decryption happens before apply contacts the target. Keep returned
 * plaintext in memory only; the archive always contains the original encrypted cells. */
export async function openProjectSeed(raw: unknown, keys: MaterialKeys) {
  const seed = ProjectSeed.parse(raw);
  if (!seed.organization.members.some((member) => member.role === "owner"))
    throw new Error("The restored organization must have an owner.");
  if (
    new Set(seed.organization.members.map((member) => member.email.toLowerCase())).size !==
    seed.organization.members.length
  )
    throw new Error("Duplicate organization members.");
  if ((await configTree(seed.config.files)) !== seed.config.tree)
    throw new Error("Config tree does not match the archive's Git tree hash.");
  if (!seed.config.files.some((file) => file.path === "worker.ts"))
    throw new Error("Config archive has no worker.ts.");
  const paths = new Set<string>();
  const secrets = [];
  for (const secret of seed.secrets) {
    if (paths.has(secret.path)) throw new Error(`Duplicate secret path: ${secret.path}`);
    paths.add(secret.path);
    if (secret.context !== `${seed.source.projectId}.iterate${secret.path}`)
      throw new Error(`Secret ${secret.path} is bound to another project or path.`);
    let material;
    try {
      ({ material } = await decryptSecretMaterial(secret.material, secret, keys));
    } catch {
      throw new Error(
        `Cannot decrypt ${secret.path}: the encryption key or authenticated binding does not match. Nothing has been restored.`,
      );
    }
    secrets.push({ path: secret.path, ...normalizeSecretRecord(material, secret) });
  }
  return { seed, secrets };
}
