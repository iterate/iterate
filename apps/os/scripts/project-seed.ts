import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { createAuthContractClient } from "@iterate-com/auth-contract";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import type { RpcStub } from "capnweb";
import type { Session } from "iterate/client";
import { connectItxReady } from "iterate/node";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decryptSecretCellMaterial } from "../src/domains/secrets/crypto.ts";
import type { SecretRefresh, SecretVisibility } from "../src/domains/secrets/types.ts";
import {
  WORKER_BUILDING_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_ERROR_HEADER,
  WORKER_SERVE_HEADER,
} from "../src/domains/workers/worker-serve-info.ts";
import { buildProjectWorkerUrl } from "../src/lib/project-host-routing.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

type CiphertextMaterial = {
  source: "ciphertext";
  encrypted: {
    algorithm: "AES-GCM-SHA256+SECRET-CELL-V1";
    ciphertext: string;
    iv: string;
  };
  binding: {
    projectId: string;
    path: string;
    egressOrigins: string[];
    offset: number;
  };
};

type SeedSecret = {
  path: string;
  egressUrls: string[];
  material: CiphertextMaterial;
  refresh?: SecretRefresh | null;
  visibility: SecretVisibility;
};

type SeedIntegration =
  | {
      provider: "slack";
      teamId: string;
      connection?: string;
      botToken: CiphertextMaterial;
    }
  | {
      provider: "github";
      installationId: string;
      connection?: string;
    }
  | {
      provider: "google";
      googleUserId: string;
      connection: string;
      material: CiphertextMaterial;
    };

type GithubRepositorySeed = {
  source: "github";
  installationId: string;
  owner: string;
  repo: string;
  capturedHead?: { branch: string; commitOid: string };
};

type LocalRepositorySeed = {
  source: "local";
  capturedHead?: { branch: string; commitOid: string };
  files: Array<{ path: string; contentBase64: string }>;
};

type RepositorySeed = GithubRepositorySeed | LocalRepositorySeed;

type SeedProject = {
  id: string;
  slug: string;
  organization: string;
  directHostnames: string[];
  cloudflareHostnames: string[];
  email: { allowedSenders: string[] };
  secrets: SeedSecret[];
  integrations: SeedIntegration[];
  configRepo?: RepositorySeed;
  repositories: Array<RepositorySeed & { path: string }>;
};

type ProjectSeedArchive = {
  version: 1;
  targetEnvironment: string;
  users: Array<{
    email: string;
    name: string;
    image?: string | null;
    platformAdmin: boolean;
  }>;
  organizations: Array<{
    slug: string;
    name: string;
    members: Array<{ email: string; role: "admin" | "member" | "owner" }>;
  }>;
  projects: SeedProject[];
};

type CaptureOptions = {
  project: string;
  environment?: string;
  file?: string;
  force?: boolean;
  baseUrl?: string;
  authBaseUrl?: string;
};

type SeedOptions = {
  file: string;
  project: string;
  baseUrl?: string;
  authBaseUrl?: string;
};

type ProjectRpc = Awaited<ReturnType<ReturnType<RpcStub<Session>["projects"]["get"]>["create"]>>;

type RestoredIntegration = {
  connection: string;
  externalId: string;
  provider: string;
};

/** Download the current semantic state for one project into a mode-0600 YAML file. */
export async function capture(options: CaptureOptions) {
  const selector = requiredOption(options.project, "--project");
  const targetEnvironment =
    options.environment?.trim() || process.env.DOPPLER_CONFIG?.trim() || "prd";
  assertTargetEnvironment(targetEnvironment);

  const auth = createAuthContractClient({
    baseUrl: resolveAuthBaseUrl(options.authBaseUrl),
    serviceToken: resolveAuthServiceToken(targetEnvironment),
  });
  using session = await connectItxReady({
    auth: {
      type: "admin-secret",
      secret: requireEnvironment("APP_CONFIG_ADMIN_API_SECRET"),
    },
    baseUrl: resolveOsBaseUrl(options.baseUrl),
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  const project = await session.projects.get(selector);
  const identity = await project.identity();
  const [authSnapshot, projectSnapshot, emailSnapshot, listedConnections] = await Promise.all([
    auth.internal.project.seedSnapshot({ projectSlug: identity.slug }),
    project.processor.snapshot(),
    project.email.processor.snapshot(),
    project.integrations.list(),
  ]);
  if (
    authSnapshot.project.id !== identity.projectId ||
    authSnapshot.project.organizationId !== identity.organizationId
  ) {
    throw new Error(`Auth and OS disagree about project ${identity.slug}.`);
  }
  if (authSnapshot.project.archivedAt !== null) {
    throw new Error(`Project ${identity.slug} is archived.`);
  }

  const connections = await Promise.all(
    listedConnections
      .filter((entry) => entry.source === "builtin")
      .map(async (entry) => {
        const provider = entry.integration === "gmail" ? "google" : entry.integration;
        return {
          provider,
          connection: entry.connection,
          status: await project.integrations.getConnection({
            connection: entry.connection,
            provider,
          }),
        };
      }),
  );
  const connected = connections.filter((entry) => entry.status.connected);
  const unsupported = connected.filter(
    (entry) => !["github", "google", "slack"].includes(entry.provider),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Capture does not support ${unsupported
        .map((entry) => `${entry.provider}/${entry.connection}`)
        .join(", ")}.`,
    );
  }

  const genericSecretPaths = projectSnapshot.state.secrets
    .map((secret) => secret.path)
    .filter(
      (path) => path !== "/secrets/project-api-key" && !path.startsWith("/secrets/integrations/"),
    )
    .sort();
  const secrets = await Promise.all(
    genericSecretPaths.map(async (path) => ({
      path,
      ...(await captureSecret(project, identity.projectId, path)),
    })),
  );
  const integrations = await Promise.all(
    connected.map(async (entry): Promise<SeedIntegration> => {
      const externalId = entry.status.externalId?.trim();
      if (!externalId) {
        throw new Error(`${entry.provider}/${entry.connection} has no external ID.`);
      }
      if (entry.provider === "github") {
        return {
          provider: "github",
          installationId: externalId,
          connection: entry.connection,
        };
      }
      if (entry.provider === "slack") {
        return {
          provider: "slack",
          teamId: externalId,
          connection: entry.connection,
          botToken: (
            await captureSecret(
              project,
              identity.projectId,
              `/secrets/integrations/slack/${entry.connection}/bot-token`,
            )
          ).material,
        };
      }
      if (entry.provider === "google") {
        return {
          provider: "google",
          googleUserId: externalId,
          connection: entry.connection,
          material: (
            await captureSecret(
              project,
              identity.projectId,
              `/secrets/integrations/google/${entry.connection}`,
            )
          ).material,
        };
      }
      throw new Error(`Unsupported integration ${entry.provider}.`);
    }),
  );
  integrations.sort((left, right) =>
    `${left.provider}/${left.connection ?? ""}`.localeCompare(
      `${right.provider}/${right.connection ?? ""}`,
    ),
  );

  const repositoryPaths = [
    ...new Set([
      "/repos/config",
      ...projectSnapshot.state.repos.map((repository) => repository.path),
    ]),
  ].sort();
  const repositories = await Promise.all(
    repositoryPaths.map(async (path) => ({
      path,
      seed: await captureRepository({ connected, path, project }),
    })),
  );
  const configRepo = repositories.find(({ path }) => path === "/repos/config")!.seed;
  const additionalRepositories = repositories
    .filter(({ path }) => path !== "/repos/config")
    .map(({ path, seed }) => ({ path, ...seed }));
  const members = [...authSnapshot.members].sort((left, right) =>
    left.user.email.localeCompare(right.user.email),
  );
  const archive: ProjectSeedArchive = {
    version: 1,
    targetEnvironment,
    users: members.map((member) => ({
      email: member.user.email,
      name: member.user.name,
      image: member.user.image,
      platformAdmin: member.user.role === "admin",
    })),
    organizations: [
      {
        slug: authSnapshot.organization.slug,
        name: authSnapshot.organization.name,
        members: members.map((member) => ({
          email: member.user.email,
          role: member.role,
        })),
      },
    ],
    projects: [
      {
        id: identity.projectId,
        slug: identity.slug,
        organization: authSnapshot.organization.slug,
        directHostnames: projectSnapshot.state.customDomains
          .filter((domain) => domain.kind === "direct" && domain.status === "active")
          .map((domain) => domain.hostname)
          .sort(),
        cloudflareHostnames: projectSnapshot.state.customDomains
          .filter((domain) => domain.kind === "cloudflare" && domain.status === "active")
          .map((domain) => domain.hostname)
          .sort(),
        email: { allowedSenders: [...emailSnapshot.state.allowedSenders].sort() },
        secrets,
        integrations,
        configRepo,
        repositories: additionalRepositories,
      },
    ],
  };
  const file = options.file?.trim()
    ? resolve(options.file)
    : await defaultCaptureFile(identity.slug);
  if (options.force) {
    await chmod(file, 0o600).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
  try {
    await writeFile(file, stringifyYaml(archive), {
      encoding: "utf8",
      flag: options.force ? "w" : "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`${file} already exists; pass --force to replace it.`);
    }
    throw error;
  }
  await chmod(file, 0o600);
  return { file, ...projectSeedPlan(archive, archive.projects[0]!) };
}

/** Parse and print a non-secret summary. */
export async function check(options: SeedOptions) {
  const selected = await loadSelectedProject(options);
  return projectSeedPlan(selected.archive, selected.project);
}

/** Recreate one project through current Auth and OS commands. */
export async function apply(options: SeedOptions) {
  const { archive, project: seed } = await loadSelectedProject(options);
  assertTargetEnvironment(archive.targetEnvironment);
  const organization = archive.organizations.find(
    (candidate) => candidate.slug === seed.organization,
  );
  if (!organization) throw new Error(`Organization ${seed.organization} is missing from the seed.`);
  const users = new Map(archive.users.map((user) => [user.email.toLowerCase(), user]));

  const auth = createAuthContractClient({
    baseUrl: resolveAuthBaseUrl(options.authBaseUrl),
    serviceToken: resolveAuthServiceToken(archive.targetEnvironment),
  });
  const userIds = new Map<string, string>();
  for (const member of organization.members) {
    const user = users.get(member.email.toLowerCase());
    if (!user) throw new Error(`User ${member.email} is missing from the seed.`);
    const restored = await auth.internal.user.upsertVerifiedEmail({
      email: user.email,
      name: user.name,
      image: user.image,
      platformAdmin: user.platformAdmin,
    });
    userIds.set(member.email.toLowerCase(), restored.id);
  }
  const restoredOrganization = await auth.internal.organization.ensure({
    slug: organization.slug,
    name: organization.name,
    members: organization.members.map((member) => ({
      userId: userIds.get(member.email.toLowerCase())!,
      role: member.role,
    })),
  });

  using session = await connectItxReady({
    auth: {
      type: "admin-secret",
      secret: requireEnvironment("APP_CONFIG_ADMIN_API_SECRET"),
    },
    baseUrl: resolveOsBaseUrl(options.baseUrl),
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  const project = await session.projects.get(seed.slug).create({
    projectId: seed.id,
    organizationSlug: seed.organization,
  });
  const identity = await project.identity();
  if (
    identity.projectId !== seed.id ||
    identity.organizationId !== restoredOrganization.id ||
    identity.slug !== seed.slug
  ) {
    throw new Error(`Project identity mismatch after restoring ${seed.slug}.`);
  }

  for (const hostname of seed.directHostnames) {
    await project.restoreDirectHostname({ hostname });
  }
  for (const hostname of seed.cloudflareHostnames) {
    await project.restoreCloudflareHostname({ hostname });
  }
  await project.email.restoreAllowedSenders({ patterns: seed.email.allowedSenders });

  for (const secret of seed.secrets) {
    const handle = project.secrets.get(secret.path);
    const before = await handle.__describe();
    const input = {
      egress: { urls: secret.egressUrls },
      material: await unwrap(secret.material),
      refresh: secret.refresh ?? null,
    };
    if (before.created) {
      await handle.update(input);
    } else {
      await handle.create({ ...input, visibility: secret.visibility });
    }
  }

  const restoredIntegrations: RestoredIntegration[] = [];
  for (const integration of seed.integrations) {
    if (integration.provider === "github") {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "github",
          installationId: integration.installationId,
          connection: integration.connection,
        }),
      );
    } else if (integration.provider === "slack") {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "slack",
          teamId: integration.teamId,
          connection: integration.connection,
          botToken: asString(await unwrap(integration.botToken), "Slack bot token"),
        }),
      );
    } else {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "google",
          googleUserId: integration.googleUserId,
          connection: integration.connection,
          material: asGoogleToken(await unwrap(integration.material)),
        }),
      );
    }
  }

  const workerUrls = projectWorkerUrls({
    baseUrl: resolveOsBaseUrl(options.baseUrl),
    hostnames: [...seed.directHostnames, ...seed.cloudflareHostnames],
    slug: seed.slug,
  });
  const configRepo =
    seed.configRepo === undefined
      ? null
      : await restoreRepository({
          project,
          path: "/repos/config",
          seed: seed.configRepo,
          integrations: restoredIntegrations,
          workerUrls,
        });
  const repositories = [];
  for (const repository of seed.repositories) {
    repositories.push(
      await restoreRepository({
        project,
        path: repository.path,
        seed: repository,
        integrations: restoredIntegrations,
      }),
    );
  }

  return {
    targetEnvironment: archive.targetEnvironment,
    project: identity,
    organization: {
      id: restoredOrganization.id,
      slug: restoredOrganization.slug,
      members: organization.members,
    },
    directHostnames: seed.directHostnames,
    cloudflareHostnames: seed.cloudflareHostnames,
    email: seed.email,
    secrets: seed.secrets.map((secret) => secret.path),
    integrations: restoredIntegrations,
    configRepo,
    repositories,
  };
}

async function captureSecret(project: ProjectRpc, projectId: string, path: string) {
  const exported = await project.secrets.get(path).exportForProjectSeed();
  if (exported.encrypted.algorithm !== "AES-GCM-SHA256+SECRET-CELL-V1") {
    throw new Error(`Secret ${path} uses an unsupported encryption envelope.`);
  }
  return {
    egressUrls: exported.egressUrls,
    material: {
      source: "ciphertext" as const,
      encrypted: {
        ...exported.encrypted,
        algorithm: "AES-GCM-SHA256+SECRET-CELL-V1" as const,
      },
      binding: {
        projectId,
        path,
        egressOrigins: [...new Set(exported.egressUrls.map((url) => new URL(url).origin))].sort(),
        offset: exported.offset,
      },
    },
    refresh: exported.refresh,
    visibility: exported.visibility,
  };
}

async function captureRepository(input: {
  connected: readonly {
    connection: string;
    provider: string;
    status: { externalId: string | null };
  }[];
  path: string;
  project: ProjectRpc;
}): Promise<RepositorySeed> {
  const repository = input.project.repos.get(input.path);
  const [snapshot, local] = await Promise.all([
    repository.processor.snapshot(),
    repository.listFiles(),
  ]);
  const github = snapshot.state.github;
  if (github !== null) {
    const installation = input.connected.find(
      (entry) =>
        entry.provider === "github" &&
        entry.connection === github.connection &&
        entry.status.externalId === github.installationId,
    );
    if (!installation) {
      throw new Error(`${input.path} has no matching GitHub connection.`);
    }
    const remote = await readGithubHead(
      input.project.integrations.github.get(github.connection).octokit,
      github,
    );
    if (remote.commitOid !== local.commitOid) {
      throw new Error(`${input.path} is not synchronized with GitHub.`);
    }
    return {
      source: "github",
      installationId: github.installationId,
      owner: github.owner,
      repo: github.repo,
      capturedHead: remote,
    };
  }
  const files = await Promise.all(
    [...local.paths].sort().map(async (path) => {
      const file = await repository.readFile({
        path,
        encoding: "base64",
        commitOid: local.commitOid,
      });
      if (file === null) throw new Error(`${input.path}/${path} disappeared during capture.`);
      return { path, contentBase64: file.content };
    }),
  );
  return {
    source: "local",
    files,
    capturedHead: { branch: "main", commitOid: local.commitOid },
  };
}

async function restoreRepository(input: {
  project: ProjectRpc;
  path: string;
  seed: RepositorySeed;
  integrations: readonly RestoredIntegration[];
  workerUrls?: readonly string[];
}) {
  const repository = input.project.repos.get(input.path);
  if (input.path !== "/repos/config") await repository.create({ type: "empty" });
  if (input.seed.source === "local") {
    const before = await repository.listFiles();
    const wanted = new Set(input.seed.files.map((file) => file.path));
    const changes = [
      ...input.seed.files.map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64,
      })),
      ...before.paths
        .filter((path) => !wanted.has(path))
        .map((path) => ({ path, delete: true as const })),
    ];
    const commit =
      changes.length === 0
        ? before
        : await repository.commitFiles({
            branch: "main",
            changes,
            message: "Restore project seed",
          });
    const after = await repository.listFiles();
    if (!sameStrings(after.paths, [...wanted])) {
      throw new Error(`${input.path} file-tree proof failed.`);
    }
    const served =
      input.workerUrls === undefined ? null : await proveWorkers(input.workerUrls, after.commitOid);
    return {
      path: input.path,
      source: "local" as const,
      commitOid: after.commitOid,
      changedPaths: "changedPaths" in commit ? commit.changedPaths : [],
      served,
    };
  }

  const githubSeed = input.seed;
  const connection = input.integrations.find(
    (entry) => entry.provider === "github" && entry.externalId === githubSeed.installationId,
  )?.connection;
  if (!connection) {
    throw new Error(`No GitHub connection for installation ${githubSeed.installationId}.`);
  }
  const github = input.project.integrations.github.get(connection).octokit;
  const before = await readGithubHead(github, githubSeed);
  const link = await repository.linkGithub({
    connection,
    createIfMissing: false,
    initialPush: false,
    owner: githubSeed.owner,
    repo: githubSeed.repo,
  });
  if (link.created) throw new Error(`${githubSeed.owner}/${githubSeed.repo} did not exist.`);
  const reset = await repository.resetFromGithub({ depth: 1 });
  const after = await readGithubHead(github, githubSeed);
  if (
    before.commitOid !== reset.commitOid ||
    after.commitOid !== reset.commitOid ||
    before.branch !== reset.branch
  ) {
    throw new Error(`${input.path} changed while it was restored from GitHub.`);
  }
  const served =
    input.workerUrls === undefined ? null : await proveWorkers(input.workerUrls, reset.commitOid);
  return {
    path: input.path,
    source: "github" as const,
    connection,
    owner: githubSeed.owner,
    repo: githubSeed.repo,
    branch: reset.branch,
    commitOid: reset.commitOid,
    served,
  };
}

async function proveWorkers(urls: readonly string[], expectedCommitOid: string) {
  const results = [];
  for (const url of urls) {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const observed = {
        url,
        status: response.status,
        commitOid: response.headers.get(WORKER_SERVE_HEADER),
        building: response.headers.get(WORKER_BUILDING_HEADER),
        buildFailed: response.headers.get(WORKER_BUILD_FAILED_HEADER),
        serveError: response.headers.get(WORKER_SERVE_ERROR_HEADER),
        cfRay: response.headers.get("cf-ray"),
      };
      await response.body?.cancel();
      if (
        observed.commitOid === expectedCommitOid &&
        observed.status < 500 &&
        observed.buildFailed === null &&
        observed.serveError === null
      ) {
        results.push(observed);
        break;
      }
      if (
        observed.status !== 503 ||
        observed.building !== "1" ||
        observed.buildFailed !== null ||
        observed.serveError !== null ||
        Date.now() >= deadline
      ) {
        throw new Error(
          `Worker proof failed for ${url}: expected ${expectedCommitOid}, got ${JSON.stringify(observed)}.`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
  }
  return results;
}

function projectWorkerUrls(input: { baseUrl: string; hostnames: readonly string[]; slug: string }) {
  const hostnameBases = parseStringArrayEnvironment("APP_CONFIG_PROJECT_HOSTNAME_BASES");
  const canonical = buildProjectWorkerUrl({
    appBaseUrl: input.baseUrl,
    projectHostnameBases: hostnameBases,
    projectSlug: input.slug,
  });
  if (canonical === null) throw new Error(`Cannot derive the ${input.slug} project URL.`);
  return [
    ...new Set([
      canonical,
      ...input.hostnames.map((customHostname) => {
        const url = buildProjectWorkerUrl({
          appBaseUrl: input.baseUrl,
          customHostname,
          projectHostnameBases: hostnameBases,
          projectSlug: input.slug,
        });
        if (url === null) throw new Error(`Cannot derive the ${customHostname} project URL.`);
        return url;
      }),
    ]),
  ];
}

async function readGithubHead(
  github: {
    rest: {
      git: {
        getRef(input: {
          owner: string;
          ref: string;
          repo: string;
        }): Promise<{ data: { object: { sha: string } } }>;
      };
      repos: {
        get(input: {
          owner: string;
          repo: string;
        }): Promise<{ data: { default_branch: string | null } }>;
      };
    };
  },
  repository: { owner: string; repo: string },
) {
  const details = await github.rest.repos.get(repository);
  const branch = details.data.default_branch;
  if (!branch) throw new Error(`${repository.owner}/${repository.repo} has no default branch.`);
  const ref = await github.rest.git.getRef({
    ...repository,
    ref: `heads/${branch}`,
  });
  return { branch, commitOid: ref.data.object.sha };
}

async function loadSelectedProject(options: SeedOptions) {
  const file = requiredOption(options.file, "--file");
  const selector = requiredOption(options.project, "--project");
  const permissions = (await stat(file)).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new Error(`${file} must be mode 0600; current mode is ${permissions.toString(8)}.`);
  }
  const parsed = parseYaml(await readFile(file, "utf8")) as unknown;
  assertArchive(parsed);
  const project = parsed.projects.find(
    (candidate) => candidate.slug === selector || candidate.id === selector,
  );
  if (!project) throw new Error(`Project ${selector} is not in ${file}.`);
  validateSelectedProject(parsed, project);
  return { archive: parsed, project };
}

function assertArchive(value: unknown): asserts value is ProjectSeedArchive {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.targetEnvironment !== "string" ||
    !Array.isArray(value.users) ||
    !Array.isArray(value.organizations) ||
    !Array.isArray(value.projects)
  ) {
    throw new Error("Not a version-1 project seed archive.");
  }
}

function validateSelectedProject(archive: ProjectSeedArchive, project: SeedProject) {
  if (
    typeof project.id !== "string" ||
    !project.id.startsWith("prj_") ||
    typeof project.slug !== "string" ||
    typeof project.organization !== "string" ||
    !Array.isArray(project.directHostnames) ||
    !Array.isArray(project.cloudflareHostnames) ||
    !Array.isArray(project.secrets) ||
    !Array.isArray(project.integrations) ||
    !Array.isArray(project.repositories) ||
    !Array.isArray(project.email?.allowedSenders)
  ) {
    throw new Error(`Project ${String(project.slug)} has an invalid seed shape.`);
  }
  if (!archive.organizations.some((organization) => organization.slug === project.organization)) {
    throw new Error(`Project organization ${project.organization} is missing.`);
  }
  for (const secret of project.secrets) {
    validateMaterial(secret.material, project.id, secret.path);
  }
  for (const integration of project.integrations) {
    if (integration.provider === "slack") {
      if (!integration.connection) throw new Error("Slack seed needs its connection slug.");
      validateMaterial(
        integration.botToken,
        project.id,
        `/secrets/integrations/slack/${integration.connection}/bot-token`,
      );
    } else if (integration.provider === "google") {
      validateMaterial(
        integration.material,
        project.id,
        `/secrets/integrations/google/${integration.connection}`,
      );
    } else if (integration.provider !== "github") {
      throw new Error(
        `Unsupported integration ${(integration as { provider?: unknown }).provider}.`,
      );
    }
  }
}

function validateMaterial(material: CiphertextMaterial, projectId: string, path: string) {
  if (
    material?.source !== "ciphertext" ||
    material.binding?.projectId !== projectId ||
    material.binding?.path !== path ||
    material.encrypted?.algorithm !== "AES-GCM-SHA256+SECRET-CELL-V1"
  ) {
    throw new Error(`Invalid ciphertext binding for ${path}.`);
  }
}

function projectSeedPlan(archive: ProjectSeedArchive, project: SeedProject) {
  const organization = archive.organizations.find(
    (candidate) => candidate.slug === project.organization,
  )!;
  return {
    targetEnvironment: archive.targetEnvironment,
    project: { id: project.id, slug: project.slug, organization: project.organization },
    users: organization.members.map((member) => ({
      email: member.email,
      role: member.role,
      platformAdmin:
        archive.users.find((user) => user.email.toLowerCase() === member.email.toLowerCase())
          ?.platformAdmin ?? false,
    })),
    directHostnames: project.directHostnames,
    cloudflareHostnames: project.cloudflareHostnames,
    email: project.email,
    secrets: project.secrets.map((secret) => secret.path),
    integrations: project.integrations.map((integration) => ({
      provider: integration.provider,
      externalId:
        integration.provider === "slack"
          ? integration.teamId
          : integration.provider === "github"
            ? integration.installationId
            : integration.googleUserId,
    })),
    configRepo: repositorySummary(project.configRepo),
    repositories: project.repositories.map((repository) => ({
      path: repository.path,
      repository: repositorySummary(repository),
    })),
  };
}

function repositorySummary(repository: RepositorySeed | undefined) {
  if (repository === undefined) return null;
  return repository.source === "github"
    ? {
        source: "github",
        fullName: `${repository.owner}/${repository.repo}`,
        installationId: repository.installationId,
      }
    : { source: "local", files: repository.files.length };
}

async function unwrap(material: CiphertextMaterial) {
  try {
    const serialized = await decryptSecretCellMaterial(
      material.encrypted,
      requireEnvironment("SECRET_ENCRYPTION_KEY"),
      material.binding,
    );
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(
      `Could not decrypt ${material.binding.path}; the archive binding and production encryption key must match.`,
      { cause: error },
    );
  }
}

function asString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string.`);
  }
  return value;
}

function asGoogleToken(value: unknown) {
  if (!isRecord(value) || typeof value.refreshToken !== "string") {
    throw new Error("Google material has no refreshToken.");
  }
  return {
    refreshToken: value.refreshToken,
    ...(typeof value.accessToken === "string" ? { accessToken: value.accessToken } : {}),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredOption(value: string | undefined, name: string) {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

async function defaultCaptureFile(slug: string) {
  const directory = join(homedir(), ".iterate", "project-seeds");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return join(directory, `${slug}.project-seed.yaml`);
}

function resolveOsBaseUrl(explicit: string | undefined) {
  const value =
    explicit?.trim() ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readDevServerInfo(new URL("..", import.meta.url).pathname, { requireLive: true })?.baseUrl;
  if (!value) throw new Error("No OS base URL is configured.");
  return value.replace(/\/+$/, "");
}

function resolveAuthBaseUrl(explicit: string | undefined) {
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, "");
  const issuer = new URL(requireEnvironment("APP_CONFIG_ITERATE_AUTH__ISSUER"));
  if (!issuer.pathname.endsWith("/api/auth")) {
    throw new Error(`Cannot derive the Auth base URL from ${issuer}.`);
  }
  issuer.pathname = issuer.pathname.slice(0, -"/api/auth".length) || "/";
  return issuer.toString().replace(/\/$/, "");
}

function resolveAuthServiceToken(environment: string) {
  const supplied =
    process.env.PROJECT_SEED_AUTH_SERVICE_TOKEN?.trim() ||
    process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
  if (supplied) return supplied;
  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "get",
      "APP_CONFIG_SERVICE_AUTH_TOKEN",
      "--project",
      "auth",
      "--config",
      environment,
      "--plain",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const token = result.stdout?.trim();
  if (result.status !== 0 || !token) {
    throw new Error(`Could not read Auth service credentials for ${environment}.`);
  }
  return token;
}

function parseStringArrayEnvironment(name: string) {
  const parsed = JSON.parse(requireEnvironment(name)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed as string[];
}

function assertTargetEnvironment(expected: string) {
  const actual = process.env.DOPPLER_CONFIG?.trim();
  if (!actual || actual !== expected) {
    throw new Error(`Seed targets ${expected}; active Doppler config is ${actual || "missing"}.`);
  }
}

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Required environment variable ${name} is missing.`);
  return value;
}
