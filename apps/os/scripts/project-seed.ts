/** Semantic project recovery: config Git tree, organization membership and encrypted current
 * secret cells. No streams, offsets, OAuth sessions, files or processor state are archived. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { WebSocket } from "undici";
import { createCli } from "trpc-cli";
import { z } from "zod";
import type { IterateSessionApi, SessionCredentials } from "iterate/next/api";
import type { ItxExpression } from "iterate/next/expression";
import { osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { atRestKeysOf, parseAppConfig } from "../src/app-config.ts";
import {
  EncryptedSecretSeed,
  ProjectSeed,
  configTree,
  openProjectSeed,
} from "./project-seed-format.ts";

type SeedApi = {
  authenticate(credentials: SessionCredentials): Promise<
    IterateSessionApi & {
      exportProjectSecretForSeed(project: string, path: string): Promise<unknown>;
    }
  >;
};
async function target(env: string) {
  const context = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: "project-worker",
    env,
  });
  // Match deploy.ts: only these two secrets are shipped, not legacy Doppler overrides.
  const config = parseAppConfig({
    APP_CONFIG: context.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: context.secrets.APP_CONFIG_SECRETS__KEY,
  });
  return {
    ...context,
    keys: atRestKeysOf(config),
    adminSecret: config.secrets.adminBearer.exposeSecret(),
  };
}
async function withApi<T>(
  context: Awaited<ReturnType<typeof target>>,
  run: (rpc: RpcStub<SeedApi>) => Promise<T>,
) {
  const url = new URL("/api", context.env.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  // Undici implements the WebSocket transport; Workers' ambient type has extra unrelated members.
  using rpc = newWebSocketRpcSession<SeedApi>(socket as unknown as globalThis.WebSocket);
  try {
    return await run(rpc);
  } finally {
    socket.close();
  }
}
const RepoFiles = z.object({ commitOid: z.string().nullable(), paths: z.array(z.string()) });
const repoRef: ItxExpression = ["itx", "repos", ["get", "/repos/config"]];

/** Capture to a NEW private archive. A full Git mirror and working clone are saved beside it.
 * --config-repo supplies a local Git checkout when deliberately replacing/missing the config repo. */
export async function capture(options: {
  env: string;
  project: string;
  file: string;
  configRepo?: string;
}) {
  const context = await target(options.env);
  const file = resolve(options.file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Never truncate an existing recovery archive, including on a failed capture.
  const pending = `${file}.pending`;
  writeFileSync(pending, "capture in progress\n", { mode: 0o600, flag: "wx" });
  const seed = await withApi(context, async (rpc) => {
    const api = rpc.authenticate({ type: "admin-secret", secret: context.adminSecret });
    const project = (await api.projects.list()).find((project) => project.slug === options.project);
    if (!project) throw new Error(`Project ${options.project} does not exist.`);
    const root = await api.projects.get(project.id);
    const query = z
      .array(
        z.object({
          results: z.array(
            z.object({ name: z.string(), email: z.email(), role: z.enum(["owner", "member"]) }),
          ),
        }),
      )
      .parse(
        await context.cf(`/d1/database/${context.env.resources.directoryDbId}/query`, {
          method: "POST",
          body: JSON.stringify({
            sql: "SELECT o.name,u.email,m.role FROM orgs o JOIN org_members m ON m.org_id=o.id JOIN users u ON u.id=m.user_id WHERE o.id=? ORDER BY u.email",
            params: [project.orgId],
          }),
        }),
      );
    const members = query.flatMap((row) => row.results);
    if (!members.length)
      throw new Error(
        "Project organization has no members; supply an owned organization before capturing.",
      );
    let remote = options.configRepo && resolve(options.configRepo);
    let gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_TRACE: "0",
      GIT_TRACE_CURL: "0",
      GIT_CURL_VERBOSE: "0",
    };
    let expectedTip: string | undefined;
    if (!remote) {
      const repos = z
        .array(z.object({ path: z.string() }))
        .parse(await root.invoke(["itx", "repos", ["list"]]));
      if (!repos.some((repo) => repo.path === "/repos/config"))
        throw new Error(
          `${options.project} has no config repo. Pass --config-repo with the intended local Git checkout.`,
        );
      remote = z
        .string()
        .parse(await root.invoke(["itx", "cfArtifacts", ["get", "/repos/config"], ["remote"]]));
      const token = z
        .object({ plaintext: z.string() })
        .parse(
          await root.invoke([
            "itx",
            "cfArtifacts",
            ["get", "/repos/config"],
            ["createToken", "read", 900],
          ]),
        );
      gitEnv = {
        ...gitEnv,
        ...{
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x:${token.plaintext}`).toString("base64")}`,
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1: "",
        },
      };
      expectedTip = z.string().parse(await root.invoke([...repoRef, ["tip"]]));
    }
    const mirror = `${file}.git`;
    mkdirSync(mirror, { mode: 0o700 });
    execFileSync("git", ["clone", "--mirror", "--no-hardlinks", remote, mirror], {
      env: gitEnv,
      stdio: "pipe",
    });
    execFileSync("git", ["-C", mirror, "fsck", "--full"], { stdio: "pipe" });
    const commit = execFileSync("git", ["-C", mirror, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).trim();
    if (expectedTip && expectedTip !== commit)
      throw new Error("Config head changed during capture; retry into a new archive.");
    const tree = execFileSync("git", ["-C", mirror, "rev-parse", `${commit}^{tree}`], {
      encoding: "utf8",
    }).trim();
    const files = execFileSync("git", ["-C", mirror, "ls-tree", "-rz", commit], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const tab = row.indexOf("\t");
        const [mode, type, oid] = row.slice(0, tab).split(" ");
        const path = row.slice(tab + 1);
        if (mode !== "100644" || type !== "blob" || !oid)
          throw new Error(
            `Unsupported Git entry ${path}: only regular UTF-8 config files can be restored by commitFiles.`,
          );
        const bytes = execFileSync("git", ["-C", mirror, "cat-file", "blob", oid], {
          maxBuffer: 64 * 1024 * 1024,
        });
        const content = Buffer.from(bytes).toString("utf8");
        if (!Buffer.from(content).equals(bytes))
          throw new Error(`Non-UTF-8 config file ${path} cannot be restored losslessly.`);
        return { path, content };
      });
    mkdirSync(`${file}.repo`, { mode: 0o700 });
    execFileSync("git", ["clone", "--no-hardlinks", mirror, `${file}.repo`], { stdio: "pipe" });
    const catalog = z
      .array(z.object({ path: z.string() }))
      .parse(await root.invoke(["itx", "secrets", ["list"]]));
    const secrets = [];
    for (const secret of catalog)
      secrets.push(
        EncryptedSecretSeed.parse(await api.exportProjectSecretForSeed(project.id, secret.path)),
      );
    const finalCatalog = z
      .array(z.object({ path: z.string() }))
      .parse(await root.invoke(["itx", "secrets", ["list"]]));
    if (
      JSON.stringify(catalog.map((s) => s.path).sort()) !==
      JSON.stringify(finalCatalog.map((s) => s.path).sort())
    )
      throw new Error("Secret inventory changed during capture; retry into a new archive.");
    if (expectedTip && expectedTip !== (await root.invoke([...repoRef, ["tip"]])))
      throw new Error("Config head changed during capture; retry into a new archive.");
    return ProjectSeed.parse({
      version: 1,
      capturedAt: new Date().toISOString(),
      source: { platform: context.env.baseUrl, projectId: project.id },
      project: project.slug,
      organization: {
        name: members[0]!.name,
        members: members.map(({ email, role }) => ({ email, role })),
      },
      config: { commit, tree, files },
      secrets,
    });
  });
  await openProjectSeed(seed, context.keys);
  writeFileSync(file, JSON.stringify(seed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  // The pending marker is retained as a capture receipt; no archive is overwritten on reruns.
  writeFileSync(
    pending,
    `Verified ${seed.project}: ${seed.config.files.length} files, ${seed.secrets.length} encrypted secrets.\n`,
    { mode: 0o600 },
  );
  console.log(
    `Captured ${seed.project}: ${seed.config.files.length} config files, ${seed.secrets.length} encrypted secrets → ${file}`,
  );
}

/** Local archive and encryption-key verification. Prints counts only, never material. */
export async function check(options: { env: string; file: string }) {
  const context = await target(options.env);
  const { seed } = await openProjectSeed(
    JSON.parse(readFileSync(options.file, "utf8")),
    context.keys,
  );
  console.log(
    `Verified ${seed.project}: Git tree ${seed.config.tree}; ${seed.config.files.length} files; ${seed.secrets.length} decryptable secrets; ${seed.organization.members.length} members.`,
  );
}

/** Restore current configuration through normal project/repository/secret commands. Owners may
 * explicitly replace archived membership. Existing projects must belong to the selected org. */
export async function apply(options: {
  env: string;
  file: string;
  organization?: string;
  owners?: string[];
  yesIMeanPrd?: boolean;
}) {
  if (options.env === "prd" && !options.yesIMeanPrd)
    throw new Error("Production restore requires --yes-i-mean-prd.");
  const context = await target(options.env);
  const { seed, secrets } = await openProjectSeed(
    JSON.parse(readFileSync(options.file, "utf8")),
    context.keys,
  );
  const members = options.owners?.length
    ? options.owners.map((email) => ({
        email: z.email().parse(email).toLowerCase(),
        role: "owner" as const,
      }))
    : seed.organization.members;
  const organization = options.organization || seed.organization.name;
  await withApi(context, async (rpc) => {
    const admin = rpc.authenticate({ type: "admin-secret", secret: context.adminSecret });
    const owner = members.find((member) => member.role === "owner")!;
    const operator = rpc.authenticate({
      type: "admin-secret",
      secret: context.adminSecret,
      as: { email: owner.email },
    });
    // orgs() lists the actor's memberships, even for the platform admin. Query the
    // directory so reruns find existing organizations and reject duplicate names.
    const orgs = z
      .array(z.object({ results: z.array(z.object({ id: z.string() })) }))
      .parse(
        await context.cf(`/d1/database/${context.env.resources.directoryDbId}/query`, {
          method: "POST",
          body: JSON.stringify({
            sql: "SELECT id FROM orgs WHERE name=?",
            params: [organization],
          }),
        }),
      )
      .flatMap((row) => row.results);
    if (orgs.length > 1) throw new Error(`Organization name ${organization} is ambiguous.`);
    const projects = await admin.projects.list();
    const existing = projects.find((project) => project.slug === seed.project);
    if (existing && existing.orgId !== orgs[0]?.id)
      throw new Error("Existing project belongs to another organization; refusing to move it.");
    const idOwner = projects.find((project) => project.id === seed.source.projectId);
    if (idOwner && (idOwner.slug !== seed.project || idOwner.orgId !== orgs[0]?.id))
      throw new Error(
        `Archived project id ${seed.source.projectId} already belongs to ${idOwner.slug} in another project or organization.`,
      );
    if (existing && existing.id !== seed.source.projectId)
      throw new Error(
        `Project ${seed.project} exists with id ${existing.id}, not archived id ${seed.source.projectId}.`,
      );
    const org = orgs[0] || (await operator.createOrg(organization));
    for (const member of members) {
      const user = await rpc
        .authenticate({
          type: "admin-secret",
          secret: context.adminSecret,
          as: { email: member.email },
        })
        .whoami();
      // The directory is authoritative; os-next currently has no public member-management command.
      await context.cf(`/d1/database/${context.env.resources.directoryDbId}/query`, {
        method: "POST",
        body: JSON.stringify({
          sql: "INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET role=excluded.role",
          params: [org.id, user.actor, member.role],
        }),
      });
    }
    if (!existing)
      await admin.projects.create({
        project: seed.project,
        orgId: org.id,
        restoreProjectId: seed.source.projectId,
      });
    const root = await operator.projects.get(seed.source.projectId);
    const identity = z
      .object({ projectId: z.string(), projectSlug: z.string().optional() })
      .parse(await root.whoami());
    if (identity.projectId !== seed.source.projectId || identity.projectSlug !== seed.project)
      throw new Error(`Project identity mismatch after restoring ${seed.project}.`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const snapshot = z
        .object({ state: z.object({ creation: z.object({ status: z.string() }).nullable() }) })
        .parse(await root.invoke(["itx", "facets", ["get", "project"], ["snapshot"]]));
      if (snapshot.state.creation?.status === "created") break;
      if (snapshot.state.creation?.status === "failed")
        throw new Error("Project creation failed; inspect its creation error before rerunning.");
      if (Date.now() > deadline) throw new Error("Timed out waiting for project creation.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Write secrets before publishing the restored worker, which may use them immediately.
    for (const secret of secrets) {
      await root.invoke([
        "itx",
        "secrets",
        ["set", secret.path, secret.material, { urls: secret.urls, refresh: secret.refresh }],
      ]);
      const exported = EncryptedSecretSeed.parse(
        await admin.exportProjectSecretForSeed(seed.project, secret.path),
      );
      const restored = await openProjectSeed(
        {
          ...seed,
          source: { ...seed.source, projectId: exported.context.split(".iterate")[0] },
          secrets: [exported],
        },
        context.keys,
      );
      if (JSON.stringify(restored.secrets[0]) !== JSON.stringify(secret))
        throw new Error(`Secret ${secret.path} failed readback verification.`);
    }
    const current = RepoFiles.parse(await root.invoke([...repoRef, ["listFiles"]]));
    const paths = new Set(seed.config.files.map((file) => file.path));
    const changes = [
      ...seed.config.files,
      ...current.paths.filter((path) => !paths.has(path)).map((path) => ({ path, delete: true })),
    ];
    const committed = z
      .object({ commitOid: z.string() })
      .parse(
        await root.invoke([
          ...repoRef,
          ["commitFiles", { message: `Restore project seed from ${seed.config.commit}`, changes }],
        ]),
      );
    const after = RepoFiles.parse(await root.invoke([...repoRef, ["listFiles"]]));
    const restoredFiles = [];
    for (const path of after.paths)
      restoredFiles.push({
        path,
        content: z.string().parse(await root.invoke([...repoRef, ["readFile", path]])),
      });
    if ((await configTree(restoredFiles)) !== seed.config.tree)
      throw new Error("Restored Git tree differs from the archive.");
    const until = Date.now() + 120_000;
    for (;;) {
      const snapshot = z
        .object({
          state: z.object({ configRepoTip: z.object({ commitOid: z.string() }).nullable() }),
        })
        .parse(await root.invoke(["itx", "facets", ["get", "project"], ["snapshot"]]));
      if (snapshot.state.configRepoTip?.commitOid === committed.commitOid) break;
      if (Date.now() > until)
        throw new Error("Config publication did not catch up to the restored commit.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const member of members) {
      const orgs = await rpc
        .authenticate({
          type: "admin-secret",
          secret: context.adminSecret,
          as: { email: member.email },
        })
        .orgs();
      if (!orgs.some((entry) => entry.id === org.id && entry.role === member.role))
        throw new Error(`Membership readback failed for ${member.email}.`);
    }
    console.log(
      `Restored ${seed.project} (${seed.source.projectId}) into ${organization}: exact Git tree ${seed.config.tree}, ${secrets.length} verified secrets, ${members.length} verified memberships. Commit ${committed.commitOid}.`,
    );
  });
}
if (process.argv[1]?.endsWith("project-seed.ts"))
  void createCli({ ...import.meta, name: "project-seed" }).run();
