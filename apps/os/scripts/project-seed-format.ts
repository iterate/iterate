import { z } from "zod";
import { hashObject, treeObjectsOf } from "@iterate-com/shared/git-wire";
import type { ItxExpression } from "iterate/expression";
import { HOSTNAME } from "../src/project/custom-hostnames.ts";
import { decryptSecretMaterial, type MaterialKeys } from "../src/secret-at-rest.ts";
import { normalizeSecretRecord } from "../src/secrets.ts";

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
  /** The project's own hostnames (`project/hostname-*`, src/project/custom-hostnames.ts): each one
   *  it served at capture. */
  hostnames: z.array(z.string().regex(HOSTNAME)),
});
export type ProjectSeed = z.infer<typeof ProjectSeed>;

/** The archived hostnames `apply` restores onto the deployment at `baseUrl`: every one on the
 *  deployment the seed was captured from, none on another — a custom hostname lives on its
 *  deployment's SaaS zone, and a preview must never ask for prd's. */
export const restorableHostnames = (seed: ProjectSeed, baseUrl: string) =>
  new URL(seed.source.platform).origin === new URL(baseUrl).origin ? seed.hostnames : [];

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
  const duplicateHostname = seed.hostnames.find(
    (hostname, index) => seed.hostnames.indexOf(hostname) !== index,
  );
  if (duplicateHostname) throw new Error(`Duplicate hostname: ${duplicateHostname}`);
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

/** A deployment's users, organizations, memberships and projects (`project-seed structure`): what no
 * one project seed carries — an organization's other members, a user with no project, the
 * deployment's own organization. Identifiers are recorded but not restored: a project keeps its ID
 * (`restoreProjectId`), while users and organizations are minted afresh by sign-in and `apply`. */
export const DeploymentStructure = z.object({
  capturedAt: z.iso.datetime(),
  platform: z.url(),
  users: z.array(z.object({ id: z.string(), email: z.email() })),
  organizations: z.array(z.object({ id: z.string(), name: z.string(), projects: z.number() })),
  memberships: z.record(
    z.string(),
    z.array(z.object({ userId: z.string(), email: z.email(), role: z.enum(["owner", "member"]) })),
  ),
  projects: z.array(z.object({ id: z.string(), slug: z.string(), orgId: z.string() })),
});
export type DeploymentStructure = z.infer<typeof DeploymentStructure>;

/** How a live deployment differs from a captured structure, by what survives a recreation: users
 * by email, organizations by name, memberships by (email, role), projects by ID and slug and their
 * organization's name. `problems` fail `verify-structure`; `notes` are what a restore does not
 * promise — a captured user or an empty organization nobody has recreated yet (sign-in recreates a
 * user; an empty organization has nothing to restore), and anything live that was not captured. */
export function compareStructure(captured: DeploymentStructure, live: DeploymentStructure) {
  const problems: string[] = [];
  const notes: string[] = [];
  const orgName = (structure: DeploymentStructure, orgId: string) =>
    structure.organizations.find((org) => org.id === orgId)?.name;
  const members = (structure: DeploymentStructure, orgId: string) =>
    (structure.memberships[orgId] || []).map(({ email, role }) => `${email} ${role}`).sort();
  for (const org of captured.organizations) {
    const matches = live.organizations.filter((entry) => entry.name === org.name);
    const want = members(captured, org.id);
    if (matches.length > 1)
      problems.push(`organization "${org.name}" exists ${matches.length} times`);
    else if (!matches.length && (want.length || org.projects))
      problems.push(`organization "${org.name}" is missing`);
    else if (!matches.length) notes.push(`empty organization "${org.name}" was not recreated`);
    else {
      const have = members(live, matches[0]!.id);
      for (const member of want)
        if (!have.includes(member))
          problems.push(`organization "${org.name}" lacks member ${member}`);
      for (const member of have)
        if (!want.includes(member))
          notes.push(`organization "${org.name}" has an uncaptured member ${member}`);
    }
  }
  for (const project of captured.projects) {
    const restored = live.projects.find((entry) => entry.id === project.id);
    const where = orgName(captured, project.orgId);
    if (!restored) problems.push(`project ${project.slug} (${project.id}) is missing`);
    else if (restored.slug !== project.slug)
      problems.push(`project ${project.id} is ${restored.slug}, not ${project.slug}`);
    else if (orgName(live, restored.orgId) !== where)
      problems.push(
        `project ${project.slug} is in "${orgName(live, restored.orgId)}", not "${where}"`,
      );
  }
  const liveEmails = new Set(live.users.map((user) => user.email));
  for (const user of captured.users)
    if (!liveEmails.has(user.email)) notes.push(`user ${user.email} has not signed in again yet`);
  const capturedEmails = new Set(captured.users.map((user) => user.email));
  for (const user of live.users)
    if (!capturedEmails.has(user.email)) notes.push(`user ${user.email} was not captured`);
  const capturedNames = new Set(captured.organizations.map((org) => org.name));
  for (const org of live.organizations)
    if (!capturedNames.has(org.name)) notes.push(`organization "${org.name}" was not captured`);
  const capturedProjects = new Set(captured.projects.map((project) => project.id));
  for (const project of live.projects)
    if (!capturedProjects.has(project.id))
      notes.push(`project ${project.slug} (${project.id}) was not captured`);
  return { problems, notes };
}

/** A project's root context as the seed commands reach it: capnweb's stub over `/api`. */
type SeedRoot = { invoke(expression: ItxExpression): Promise<unknown> };

/** The project facet's hostnames (src/project/contract.ts `hostnames`), the fields read here. */
const ProjectHostnames = z.object({
  state: z.object({
    hostnames: z.record(
      z.string(),
      z.object({
        requested: z.object({ verb: z.enum(["add", "remove"]) }).nullable(),
        cloudflare: z.object({ status: z.string(), sslStatus: z.string() }).nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
});
type ProjectHostnames = z.infer<typeof ProjectHostnames>["state"]["hostnames"];
async function projectHostnames(root: SeedRoot): Promise<ProjectHostnames> {
  return ProjectHostnames.parse(
    await root.invoke(["itx", "facets", ["get", "project"], ["snapshot"]]),
  ).state.hostnames;
}
/** Served: Cloudflare has provisioned it for the project, and no removal is pending. */
const serves = (entry: ProjectHostnames[string] | undefined) =>
  !!entry?.cloudflare && entry.requested?.verb !== "remove";

/** What `capture` records: every hostname the project serves. A first add still in flight, or one
 *  refused, was never the project's; a hostname being removed is on its way out. */
export async function captureHostnames(root: SeedRoot): Promise<string[]> {
  return Object.entries(await projectHostnames(root))
    .filter(([, entry]) => serves(entry))
    .map(([hostname]) => hostname)
    .sort();
}

/** What `apply` does with the archived hostnames: ask again for each one the project does not
 *  serve — absent (an erase), refused, or being removed — with the same `hostname-add-requested` the
 *  dash appends, then wait for the processor's answer to it (and to an add already in flight). A
 *  hostname the project serves is left alone, so a rerun asks for nothing. Answers each hostname's
 *  outcome; throws when one is refused, or when they are not all answered within `timeoutMs`
 *  (one limit for the whole list). */
export async function restoreHostnames(
  root: SeedRoot,
  hostnames: string[],
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<{ hostname: string; asked: boolean; status: string }[]> {
  if (!hostnames.length) return [];
  const before = await projectHostnames(root);
  const ask = hostnames.filter(
    (hostname) => !serves(before[hostname]) && before[hostname]?.requested?.verb !== "add",
  );
  if (ask.length)
    await root.invoke([
      "itx",
      [
        "append",
        ...ask.map((hostname) => ({
          type: "events.iterate.com/project/hostname-add-requested",
          payload: { hostname },
        })),
      ],
    ]);
  const deadline = Date.now() + timeoutMs;
  let now = await projectHostnames(root);
  while (hostnames.some((hostname) => !now[hostname] || now[hostname].requested)) {
    if (Date.now() > deadline)
      throw new Error(
        `No answer within ${timeoutMs / 1000} s for hostnames ${hostnames.filter((hostname) => !now[hostname] || now[hostname].requested).join(", ")}; rerun apply to wait again.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
    now = await projectHostnames(root);
  }
  const refused = hostnames.filter((hostname) => !now[hostname]!.cloudflare);
  if (refused.length)
    throw new Error(
      `Hostnames refused: ${refused.map((hostname) => `${hostname} (${now[hostname]!.error})`).join("; ")}.`,
    );
  return hostnames.map((hostname) => {
    const { status, sslStatus } = now[hostname]!.cloudflare!;
    return {
      hostname,
      asked: ask.includes(hostname),
      status: `${status}, certificate ${sslStatus}`,
    };
  });
}
