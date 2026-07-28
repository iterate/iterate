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
import type { StreamEvent } from "iterate/processors";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { normalizeInboundEmailAllowedSender } from "../src/domains/email/utils.ts";
import { SecretProcessorContract } from "../src/domains/secrets/secret-processor-contract.ts";
import { decryptSecretCellMaterial } from "../src/domains/secrets/crypto.ts";
import {
  WORKER_BUILDING_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_ERROR_HEADER,
  WORKER_SERVE_HEADER,
} from "../src/domains/workers/worker-serve-info.ts";
import { buildProjectWorkerUrl } from "../src/lib/project-host-routing.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";
import { preflightConfigRepository } from "./project-seed-preflight.ts";

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Connection = z.string().regex(/^[a-z0-9_]+(?:[-a-z0-9_]*[a-z0-9_])?$/);
const EnvironmentMaterial = z.object({
  source: z.literal("env"),
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  encoding: z.enum(["json", "string"]).default("string"),
});
const InlineMaterial = z.object({
  source: z.literal("inline"),
  value: z.json(),
});
const CiphertextMaterial = z.object({
  source: z.literal("ciphertext"),
  encrypted: z.object({
    algorithm: z.literal("AES-GCM-SHA256+SECRET-CELL-V1"),
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
  }),
  binding: z.object({
    projectId: z.string().startsWith("prj_"),
    path: z.string().startsWith("/secrets/"),
    egressOrigins: z.array(z.url()),
    offset: z.number().int().positive(),
  }),
});
const MaterialSource = z.discriminatedUnion("source", [
  EnvironmentMaterial,
  InlineMaterial,
  CiphertextMaterial,
]);
const StringMaterialSource = z.discriminatedUnion("source", [
  EnvironmentMaterial,
  z.object({ source: z.literal("inline"), value: z.string().min(1) }),
  CiphertextMaterial,
]);
const GoogleTokenMaterial = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1),
});
const SecretRefresh = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oauth-refresh-token"),
    tokenEndpoint: z.url(),
    clientCreds: z.union([z.literal("material"), z.object({ platform: z.string().min(1) })]),
  }),
  z.object({
    kind: z.literal("github-app-installation"),
    apiBase: z.url(),
    appId: z.string().min(1),
    installationId: z.string().min(1),
    privateKey: z.union([z.literal("material"), z.object({ platform: z.string().min(1) })]),
  }),
  z.object({
    kind: z.literal("waitrose-session"),
    graphqlUrl: z.url(),
  }),
]);
const SeedSecret = z.object({
  path: z
    .string()
    .startsWith("/secrets/")
    .refine(
      (path) => !path.startsWith("/secrets/integrations/") && path !== "/secrets/project-api-key",
      "Built-in integration credentials and the born project API key cannot be generic seed secrets",
    ),
  egressUrls: z.array(z.url()),
  material: MaterialSource,
  refresh: SecretRefresh.nullable().optional(),
  visibility: z.enum(["readable", "write-only"]).default("write-only"),
});
const SeedIntegration = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("slack"),
    teamId: z.string().min(1),
    connection: Connection.optional(),
    botToken: StringMaterialSource,
  }),
  z.object({
    provider: z.literal("github"),
    installationId: z.string().min(1),
    connection: Connection.optional(),
  }),
  z.object({
    provider: z.literal("google"),
    googleUserId: z.string().min(1),
    connection: Connection,
    material: MaterialSource,
  }),
  z.object({
    provider: z.literal("telegram"),
    botToken: StringMaterialSource,
    connection: Connection.optional(),
    allowedUserIds: z.array(z.string().min(1)).default([]),
  }),
]);
const CapturedRepositoryHead = z.object({
  branch: z.literal("main"),
  commitOid: z.string().regex(/^[0-9a-f]{40}$/),
});
const RepositoryFilePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path !== "." &&
      !path.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Repository file paths must be normalized relative paths",
  );
const GithubRepositorySeed = z.object({
  source: z.literal("github"),
  installationId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  capturedHead: CapturedRepositoryHead,
});
const LocalRepositorySeed = z.object({
  source: z.literal("local"),
  capturedHead: CapturedRepositoryHead,
  files: z.array(
    z.object({
      path: RepositoryFilePath,
      contentBase64: z.string(),
    }),
  ),
});
const RepositorySeed = z.discriminatedUnion("source", [GithubRepositorySeed, LocalRepositorySeed]);
const AdditionalRepositorySeed = z.discriminatedUnion("source", [
  GithubRepositorySeed.extend({
    path: z
      .string()
      .startsWith("/repos/")
      .refine((path) => path !== "/repos/config"),
  }),
  LocalRepositorySeed.extend({
    path: z
      .string()
      .startsWith("/repos/")
      .refine((path) => path !== "/repos/config"),
  }),
]);
const SeedProject = z.object({
  id: z.string().startsWith("prj_"),
  slug: Slug,
  organization: Slug,
  directHostnames: z.array(z.string().min(1)).default([]),
  cloudflareHostnames: z.array(z.string().min(1)).default([]),
  email: z
    .object({
      allowedSenders: z
        .array(
          z.string().transform((pattern, context) => {
            try {
              return normalizeInboundEmailAllowedSender(pattern);
            } catch (error) {
              context.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error),
              });
              return z.NEVER;
            }
          }),
        )
        .default([]),
    })
    .default({ allowedSenders: [] }),
  secrets: z.array(SeedSecret).default([]),
  integrations: z.array(SeedIntegration).default([]),
  configRepo: RepositorySeed.optional(),
  repositories: z.array(AdditionalRepositorySeed).default([]),
});

export const ProjectSeedArchive = z
  .object({
    version: z.literal(1),
    targetEnvironment: z.string().min(1),
    users: z.array(
      z.object({
        email: z.email(),
        name: z.string().min(1),
        image: z.url().nullable().optional(),
        platformAdmin: z.boolean().default(false),
      }),
    ),
    organizations: z.array(
      z.object({
        slug: Slug,
        name: z.string().min(1),
        members: z
          .array(
            z.object({
              email: z.email(),
              role: z.enum(["admin", "member", "owner"]),
            }),
          )
          .min(1),
      }),
    ),
    projects: z.array(SeedProject).min(1),
  })
  .superRefine((archive, context) => {
    reportDuplicates(
      archive.users.map((user) => user.email.toLowerCase()),
      ["users"],
      "user email",
      context,
    );
    reportDuplicates(
      archive.organizations.map((organization) => organization.slug),
      ["organizations"],
      "organization slug",
      context,
    );
    reportDuplicates(
      archive.projects.map((project) => project.slug),
      ["projects"],
      "project slug",
      context,
    );
    reportDuplicates(
      archive.projects.map((project) => project.id),
      ["projects"],
      "project id",
      context,
    );

    const userEmails = new Set(archive.users.map((user) => user.email.toLowerCase()));
    const organizationSlugs = new Set(
      archive.organizations.map((organization) => organization.slug),
    );
    for (const [organizationIndex, organization] of archive.organizations.entries()) {
      if (!organization.members.some((member) => member.role === "owner")) {
        context.addIssue({
          code: "custom",
          message: "Every seeded organization needs at least one owner",
          path: ["organizations", organizationIndex, "members"],
        });
      }
      reportDuplicates(
        organization.members.map((member) => member.email.toLowerCase()),
        ["organizations", organizationIndex, "members"],
        "member email",
        context,
      );
      for (const [memberIndex, member] of organization.members.entries()) {
        if (!userEmails.has(member.email.toLowerCase())) {
          context.addIssue({
            code: "custom",
            message: `Organization member ${member.email} is missing from users`,
            path: ["organizations", organizationIndex, "members", memberIndex, "email"],
          });
        }
      }
    }
    for (const [projectIndex, project] of archive.projects.entries()) {
      if (!organizationSlugs.has(project.organization)) {
        context.addIssue({
          code: "custom",
          message: `Project organization ${project.organization} is not declared`,
          path: ["projects", projectIndex, "organization"],
        });
      }
      reportDuplicates(
        project.secrets.map((secret) => secret.path),
        ["projects", projectIndex, "secrets"],
        "secret path",
        context,
      );
      reportDuplicates(
        project.directHostnames.map((hostname) => hostname.toLowerCase()),
        ["projects", projectIndex, "directHostnames"],
        "direct hostname",
        context,
      );
      reportDuplicates(
        project.cloudflareHostnames.map((hostname) => hostname.toLowerCase()),
        ["projects", projectIndex, "cloudflareHostnames"],
        "Cloudflare hostname",
        context,
      );
      const directHostnames = new Set(
        project.directHostnames.map((hostname) => hostname.toLowerCase()),
      );
      for (const [hostnameIndex, hostname] of project.cloudflareHostnames.entries()) {
        if (directHostnames.has(hostname.toLowerCase())) {
          context.addIssue({
            code: "custom",
            message: `Hostname ${hostname} cannot be both direct and Cloudflare-managed`,
            path: ["projects", projectIndex, "cloudflareHostnames", hostnameIndex],
          });
        }
      }
      reportDuplicates(
        project.email.allowedSenders,
        ["projects", projectIndex, "email", "allowedSenders"],
        "inbound email sender",
        context,
      );
      for (const [secretIndex, secret] of project.secrets.entries()) {
        reportCiphertextBinding(
          secret.material,
          {
            projectId: project.id,
            path: secret.path,
          },
          ["projects", projectIndex, "secrets", secretIndex, "material"],
          context,
        );
      }
      for (const [integrationIndex, integration] of project.integrations.entries()) {
        if (integration.provider === "github") continue;
        const expectedPath =
          integration.connection === undefined
            ? undefined
            : integration.provider === "slack"
              ? `/secrets/integrations/slack/${integration.connection}/bot-token`
              : integration.provider === "google"
                ? `/secrets/integrations/google/${integration.connection}`
                : `/secrets/integrations/telegram/${integration.connection}/bot-token`;
        reportCiphertextBinding(
          integration.provider === "google" ? integration.material : integration.botToken,
          {
            projectId: project.id,
            ...(expectedPath === undefined ? {} : { path: expectedPath }),
          },
          [
            "projects",
            projectIndex,
            "integrations",
            integrationIndex,
            integration.provider === "google" ? "material" : "botToken",
          ],
          context,
        );
      }
      const repositories = [
        ...(project.configRepo === undefined
          ? []
          : [
              {
                path: "/repos/config",
                repository: project.configRepo,
                schemaPath: ["configRepo"] as PropertyKey[],
              },
            ]),
        ...project.repositories.map((repository, repositoryIndex) => ({
          path: repository.path,
          repository,
          schemaPath: ["repositories", repositoryIndex] as PropertyKey[],
        })),
      ];
      reportDuplicates(
        repositories.map(({ path }) => path),
        ["projects", projectIndex, "repositories"],
        "repository path",
        context,
      );
      for (const { path, repository, schemaPath } of repositories) {
        if (
          repository.source === "github" &&
          !project.integrations.some(
            (integration) =>
              integration.provider === "github" &&
              integration.installationId === repository.installationId,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: `${path} installationId must match a GitHub integration in this project`,
            path: ["projects", projectIndex, ...schemaPath, "installationId"],
          });
        }
        if (repository.source === "local") {
          reportDuplicates(
            repository.files.map((file) => file.path),
            ["projects", projectIndex, ...schemaPath, "files"],
            "repository file path",
            context,
          );
        }
      }
    }
  });

type ProjectSeedArchive = z.infer<typeof ProjectSeedArchive>;
type SeedProject = z.infer<typeof SeedProject>;
type MaterialSource = z.infer<typeof MaterialSource>;
type RepositorySeed = z.infer<typeof RepositorySeed>;
export type CiphertextMaterial = z.infer<typeof CiphertextMaterial>;

type CaptureOptions = {
  /** Exact project slug or prj_* id to capture. */
  project: string;
  /** Doppler environment to read; direct CLI use defaults to prd. */
  environment?: string;
  /** Destination YAML path; defaults to ~/.iterate/project-seeds/<slug>.project-seed.yaml. */
  file?: string;
  /** Replace an existing destination file. */
  force?: boolean;
  /** OS URL; normally supplied by the selected Doppler config. */
  baseUrl?: string;
  /** Auth URL; normally derived from APP_CONFIG_ITERATE_AUTH__ISSUER. */
  authBaseUrl?: string;
};

type SeedOptions = {
  /** Stable local YAML/JSON seed archive. */
  file: string;
  /** Exact project slug or prj_* id from the archive. */
  project: string;
  /** OS URL; normally supplied by the active Doppler config. */
  baseUrl?: string;
  /** Auth URL; normally derived from APP_CONFIG_ITERATE_AUTH__ISSUER. */
  authBaseUrl?: string;
};

/**
 * Capture one project's stable semantic recovery inputs into a mode-0600
 * ciphertext-only YAML archive. Direct CLI invocation enters os/prd unless
 * --environment selects another Doppler config.
 */
export async function capture(options: CaptureOptions) {
  const projectSelector = options.project?.trim();
  if (!projectSelector) throw new Error("--project is required.");
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
  const project = await session.projects.get(projectSelector);
  const identity = await project.identity();
  const authSnapshotOverride = parseCaptureAuthSnapshotOverride();
  const [authSnapshot, projectSnapshot, emailSnapshot, integrationEntries] = await Promise.all([
    authSnapshotOverride ?? auth.internal.project.seedSnapshot({ projectSlug: identity.slug }),
    project.processor.snapshot(),
    project.email.processor.snapshot(),
    project.integrations.list(),
  ]);
  if (
    authSnapshot.project.id !== identity.projectId ||
    authSnapshot.project.organizationId !== identity.organizationId
  ) {
    throw new Error(
      `Auth and OS disagree about project ${identity.slug}: ${JSON.stringify({
        auth: authSnapshot.project,
        os: identity,
      })}`,
    );
  }
  if (authSnapshot.project.archivedAt !== null) {
    throw new Error(`Project ${identity.slug} is archived and cannot be captured for recreation.`);
  }

  const unsettledCloudflareHostnames = projectSnapshot.state.customDomains
    .filter((domain) => domain.kind === "cloudflare" && domain.status !== "active")
    .map((domain) => domain.hostname);
  if (unsettledCloudflareHostnames.length > 0) {
    throw new Error(
      `Project ${identity.slug} has Cloudflare-managed custom hostnames that are not active: ${unsettledCloudflareHostnames.join(", ")}.`,
    );
  }
  if (projectSnapshot.state.egressRules.length > 0) {
    throw new Error(
      `Project ${identity.slug} has egress approval rules that schema v1 cannot restore.`,
    );
  }
  if (projectSnapshot.state.humanApprovalKeys.some((key) => key.revokedAt === null)) {
    throw new Error(
      `Project ${identity.slug} has active human-approval keys that schema v1 cannot restore.`,
    );
  }

  const builtinConnections = await Promise.all(
    integrationEntries
      .filter((entry) => entry.source === "builtin")
      .map(async (entry) => {
        const provider = entry.integration === "gmail" ? "google" : entry.integration;
        const status = await project.integrations.getConnection({
          connection: entry.connection,
          provider,
        });
        return { connection: entry.connection, provider, status };
      }),
  );
  const connected = builtinConnections.filter((entry) => entry.status.connected);
  const unsupportedConnections = connected.filter((entry) => entry.provider === "waitrose");
  if (unsupportedConnections.length > 0) {
    throw new Error(
      `Project ${identity.slug} has connected integrations that schema v1 cannot restore: ${unsupportedConnections
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
    genericSecretPaths.map(async (path) => {
      const captured = await captureSecretState(project, identity.projectId, path);
      return {
        path,
        egressUrls: captured.egressUrls,
        material: captured.material,
        refresh: captured.refresh,
        visibility: captured.visibility,
      };
    }),
  );

  const integrations = await Promise.all(
    connected.map(async (entry) => {
      if (entry.provider === "github") {
        const installationId = requireCapturedExternalId(entry);
        return {
          provider: "github" as const,
          installationId,
          connection: entry.connection,
        };
      }
      if (entry.provider === "slack") {
        const teamId = requireCapturedExternalId(entry);
        const token = await captureSecretState(
          project,
          identity.projectId,
          `/secrets/integrations/slack/${entry.connection}/bot-token`,
        );
        return {
          provider: "slack" as const,
          teamId,
          connection: entry.connection,
          botToken: token.material,
        };
      }
      if (entry.provider === "google") {
        const googleUserId = requireCapturedExternalId(entry);
        const token = await captureSecretState(
          project,
          identity.projectId,
          `/secrets/integrations/google/${entry.connection}`,
        );
        return {
          provider: "google" as const,
          googleUserId,
          connection: entry.connection,
          material: token.material,
        };
      }
      if (entry.provider === "telegram") {
        const [token, access] = await Promise.all([
          captureSecretState(
            project,
            identity.projectId,
            `/secrets/integrations/telegram/${entry.connection}/bot-token`,
          ),
          project.integrations.getTelegramAccess({ connection: entry.connection }),
        ]);
        return {
          provider: "telegram" as const,
          connection: entry.connection,
          botToken: token.material,
          allowedUserIds: access.allowedUserIds,
        };
      }
      throw new Error(`Unsupported captured integration provider: ${entry.provider}`);
    }),
  );
  integrations.sort((left, right) => {
    const leftKey = `${left.provider}/${left.connection ?? ""}`;
    const rightKey = `${right.provider}/${right.connection ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });

  const repositoryPaths = [
    ...new Set([
      "/repos/config",
      ...projectSnapshot.state.repos.map((repository) => repository.path),
    ]),
  ].sort();
  const capturedRepositories = await Promise.all(
    repositoryPaths.map(async (path) => ({
      path,
      repository: await captureRepositorySeed({ connected, path, project }),
    })),
  );
  const configRepo = capturedRepositories.find(({ path }) => path === "/repos/config")!.repository;
  const repositories = capturedRepositories
    .filter(({ path }) => path !== "/repos/config")
    .map(({ path, repository }) => ({ path, ...repository }));
  const capturedMembers = [...authSnapshot.members].sort((left, right) =>
    left.user.email.localeCompare(right.user.email),
  );
  const archive = ProjectSeedArchive.parse({
    version: 1,
    targetEnvironment,
    users: capturedMembers.map((member) => ({
      email: member.user.email,
      name: member.user.name,
      image: member.user.image,
      platformAdmin: member.user.role === "admin",
    })),
    organizations: [
      {
        slug: authSnapshot.organization.slug,
        name: authSnapshot.organization.name,
        members: capturedMembers.map((member) => ({
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
        email: {
          allowedSenders: [...emailSnapshot.state.allowedSenders].sort(),
        },
        secrets,
        integrations,
        configRepo,
        repositories,
      },
    ],
  });
  const explicitFile = options.file?.trim();
  const file =
    explicitFile === undefined || explicitFile === ""
      ? await defaultCaptureFile(identity.slug)
      : resolve(explicitFile);
  if (options.force === true) {
    try {
      await chmod(file, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  try {
    await writeFile(file, stringifyYaml(archive), {
      encoding: "utf8",
      flag: options.force === true ? "w" : "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      options.force !== true
    ) {
      throw new Error(`${file} already exists; pass --force to replace it.`);
    }
    throw error;
  }
  await chmod(file, 0o600);

  return {
    file,
    targetEnvironment,
    project: {
      id: identity.projectId,
      slug: identity.slug,
      organization: authSnapshot.organization.slug,
    },
    users: archive.users.length,
    directHostnames: archive.projects[0]!.directHostnames.length,
    cloudflareHostnames: archive.projects[0]!.cloudflareHostnames.length,
    secrets: archive.projects[0]!.secrets.length,
    integrations: archive.projects[0]!.integrations.map((integration) => integration.provider),
    configRepo: repositorySummary(archive.projects[0]!.configRepo),
    repositories: archive.projects[0]!.repositories.map((repository) => ({
      path: repository.path,
      repository: repositorySummary(repository),
    })),
  };
}

function parseCaptureAuthSnapshotOverride():
  | Awaited<
      ReturnType<ReturnType<typeof createAuthContractClient>["internal"]["project"]["seedSnapshot"]>
    >
  | undefined {
  const encoded = process.env.ITERATE_PROJECT_SEED_AUTH_SNAPSHOT_JSON?.trim();
  if (!encoded) return undefined;
  return JSON.parse(encoded) as Awaited<
    ReturnType<ReturnType<typeof createAuthContractClient>["internal"]["project"]["seedSnapshot"]>
  >;
}

async function defaultCaptureFile(projectSlug: string) {
  const directory = join(homedir(), ".iterate", "project-seeds");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return join(directory, `${projectSlug}.project-seed.yaml`);
}

/** Parse, cross-check, and summarize a project seed without making network calls. */
export async function check(options: SeedOptions) {
  const selected = await loadSelectedProject(options);
  return projectSeedPlan(selected.archive, selected.project);
}

/**
 * Read-only GitHub compatibility gate: clone the authoritative config repo,
 * compare it with the captured working head, and run fresh install/typecheck/tests.
 */
export async function preflight(options: SeedOptions) {
  const selected = await loadSelectedProject(options);
  const config = selected.project.configRepo;
  if (config === undefined) {
    throw new Error(`Project ${selected.project.slug} has no config repo in the archive.`);
  }
  return await preflightConfigRepository({
    config,
    templateDirectory: resolve(import.meta.dirname, "../config-repo-template"),
  });
}

/**
 * Convergently restore one project from a semantic seed. This never reads or
 * replays an old stream and never pushes project state back to GitHub.
 */
export async function apply(options: SeedOptions) {
  const selected = await loadSelectedProject(options);
  assertTargetEnvironment(selected.archive.targetEnvironment);
  const archive = selected.archive;
  const seed = selected.project;
  const configPreflight =
    seed.configRepo === undefined
      ? null
      : await preflightConfigRepository({
          config: seed.configRepo,
          templateDirectory: resolve(import.meta.dirname, "../config-repo-template"),
        });
  if (configPreflight !== null && !configPreflight.ready) {
    throw new Error(
      `Config repository needs these migrations before restore: ${configPreflight.requiredMigrations
        .map((migration) => migration.id)
        .join(", ")}.`,
    );
  }
  const organization = archive.organizations.find(
    (candidate) => candidate.slug === seed.organization,
  )!;
  const usersByEmail = new Map(
    archive.users.map((user) => [user.email.toLowerCase(), user] as const),
  );

  const baseUrl = resolveOsBaseUrl(options.baseUrl);
  const authBaseUrl = resolveAuthBaseUrl(options.authBaseUrl);
  const workerProofUrls =
    seed.configRepo === undefined
      ? null
      : projectWorkerProofUrls({
          appBaseUrl: baseUrl,
          customHostnames: [...seed.directHostnames, ...seed.cloudflareHostnames],
          projectHostnameBases: projectHostnameBases(),
          projectSlug: seed.slug,
        });
  const auth = createAuthContractClient({
    baseUrl: authBaseUrl,
    serviceToken: resolveAuthServiceToken(archive.targetEnvironment),
  });
  const seededUsers = new Map<string, { id: string }>();
  for (const member of organization.members) {
    const user = usersByEmail.get(member.email.toLowerCase())!;
    const record = await auth.internal.user.upsertVerifiedEmail({
      email: user.email,
      name: user.name,
      ...(user.image === undefined ? {} : { image: user.image }),
      platformAdmin: user.platformAdmin,
    });
    if (user.platformAdmin && record.role !== "admin") {
      throw new Error(`Auth platform-admin proof failed for ${user.email}.`);
    }
    seededUsers.set(member.email.toLowerCase(), record);
  }
  const organizationRecord = await auth.internal.organization.ensure({
    name: organization.name,
    slug: organization.slug,
    members: organization.members.map((member) => ({
      userId: seededUsers.get(member.email.toLowerCase())!.id,
      role: member.role,
    })),
  });
  const actualMembers = await auth.internal.organization.members({
    organizationSlug: organization.slug,
  });
  for (const expected of organization.members) {
    const actual = actualMembers.find(
      (member) => member.user.email.toLowerCase() === expected.email.toLowerCase(),
    );
    if (!actual || actual.role !== expected.role) {
      throw new Error(
        `Auth membership proof failed for ${expected.email}: expected ${expected.role}.`,
      );
    }
  }

  const adminSecret = requireEnvironment("APP_CONFIG_ADMIN_API_SECRET");
  using session = await connectItxReady({
    auth: { type: "admin-secret", secret: adminSecret },
    baseUrl,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  const project = await session.projects.get(seed.slug).create({
    organizationSlug: seed.organization,
    projectId: seed.id,
  });
  const identity = await project.identity();
  if (
    identity.projectId !== seed.id ||
    identity.slug !== seed.slug ||
    identity.organizationId !== organizationRecord.id
  ) {
    throw new Error(
      `Project identity mismatch after create: ${JSON.stringify(identity)}; expected ${seed.id}/${seed.slug}/${organizationRecord.id}.`,
    );
  }

  const restoredDirectHostnames: string[] = [];
  for (const hostname of seed.directHostnames) {
    const restored = await project.restoreDirectHostname({ hostname });
    restoredDirectHostnames.push(restored.hostname);
  }
  const restoredCloudflareHostnames: string[] = [];
  for (const hostname of seed.cloudflareHostnames) {
    const restored = await project.restoreCloudflareHostname({ hostname });
    restoredCloudflareHostnames.push(restored.hostname);
  }
  const restoredEmail = await project.email.restoreAllowedSenders({
    patterns: seed.email.allowedSenders,
  });

  const restoredSecrets: string[] = [];
  for (const item of seed.secrets) {
    const target = project.secrets.get(item.path);
    const description = await target.__describe();
    const material = await resolveMaterial(item.material);
    const secretInput = {
      egress: { urls: item.egressUrls },
      material,
      refresh: item.refresh ?? null,
    };
    if (description.created) {
      if (description.visibility !== item.visibility) {
        throw new Error(
          `Secret ${item.path} has immutable visibility ${description.visibility}, expected ${item.visibility}.`,
        );
      }
      await target.update(secretInput);
    } else {
      await target.create({ ...secretInput, visibility: item.visibility });
    }
    const proof = await target.__describe();
    if (
      !proof.created ||
      !proof.hasMaterial ||
      proof.visibility !== item.visibility ||
      proof.refresh !== (item.refresh?.kind ?? null) ||
      !sameStringSet(proof.egress.urls, item.egressUrls)
    ) {
      throw new Error(`Secret ${item.path} failed its public metadata proof.`);
    }
    restoredSecrets.push(item.path);
  }

  const restoredIntegrations: Array<{
    connection: string;
    externalId: string;
    provider: string;
  }> = [];
  for (const integration of seed.integrations) {
    if (integration.provider === "slack") {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "slack",
          teamId: integration.teamId,
          botToken: await resolveStringMaterial(integration.botToken),
          ...(integration.connection === undefined ? {} : { connection: integration.connection }),
        }),
      );
      continue;
    }
    if (integration.provider === "github") {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "github",
          installationId: integration.installationId,
          ...(integration.connection === undefined ? {} : { connection: integration.connection }),
        }),
      );
      continue;
    }
    if (integration.provider === "google") {
      restoredIntegrations.push(
        await project.integrations.restoreConnection({
          provider: "google",
          connection: integration.connection,
          googleUserId: integration.googleUserId,
          material: GoogleTokenMaterial.parse(await resolveMaterial(integration.material)),
        }),
      );
      continue;
    }
    const telegram = await project.integrations.connectTelegram({
      botToken: await resolveStringMaterial(integration.botToken),
    });
    if (!telegram.ok) {
      throw new Error(
        `Telegram bot ${telegram.botUsername ?? "(unnamed)"} is claimed by another project; project seeds never steal integrations.`,
      );
    }
    if (integration.connection !== undefined && telegram.connection !== integration.connection) {
      throw new Error(
        `Telegram restored as ${telegram.connection}, expected archived connection ${integration.connection}.`,
      );
    }
    await project.integrations.setTelegramAccess({
      connection: telegram.connection,
      allowedUserIds: integration.allowedUserIds,
    });
    restoredIntegrations.push({
      provider: "telegram",
      connection: telegram.connection,
      externalId: telegram.botId,
    });
  }

  const configRepo =
    seed.configRepo === undefined
      ? null
      : seed.configRepo.source === "github"
        ? await restoreConfigRepoFromGithub({
            project,
            config: seed.configRepo,
            integrations: restoredIntegrations,
            expectedHead: configPreflight!.repository,
            workerUrls: workerProofUrls!,
          })
        : await restoreLocalRepository({
            captured: seed.configRepo,
            path: "/repos/config",
            project,
            workerUrls: workerProofUrls!,
          });
  const repositories = await Promise.all(
    seed.repositories.map((repository) =>
      restoreAdditionalRepository({
        project,
        repository,
        integrations: restoredIntegrations,
      }),
    ),
  );

  return {
    targetEnvironment: archive.targetEnvironment,
    project: identity,
    organization: {
      id: organizationRecord.id,
      slug: organizationRecord.slug,
      members: organization.members.map(({ email, role }) => ({ email, role })),
    },
    directHostnames: restoredDirectHostnames,
    cloudflareHostnames: restoredCloudflareHostnames,
    email: restoredEmail,
    secrets: restoredSecrets,
    integrations: restoredIntegrations,
    configPreflight,
    configRepo,
    repositories,
  };
}

type ProjectRpc = Awaited<ReturnType<ReturnType<RpcStub<Session>["projects"]["get"]>["create"]>>;

type RestoredIntegration = {
  connection: string;
  externalId: string;
  provider: string;
};

async function captureRepositorySeed(input: {
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
    const connection = input.connected.find(
      (entry) => entry.provider === "github" && entry.connection === github.connection,
    );
    if (!connection || requireCapturedExternalId(connection) !== github.installationId) {
      throw new Error(
        `Linked repository ${input.path} (${github.owner}/${github.repo}) does not have a matching connected GitHub installation.`,
      );
    }
    const capturedHead = await readGithubHead(
      input.project.integrations.github.get(github.connection).octokit,
      github,
    );
    if (capturedHead.branch !== "main") {
      throw new Error(
        `Repository ${input.path} (${github.owner}/${github.repo}) uses default branch ${capturedHead.branch}; project seed restore requires main.`,
      );
    }
    if (local.commitOid !== capturedHead.commitOid) {
      throw new Error(
        `Repository ${input.path} is not synchronized at capture time: GitHub ${capturedHead.branch}@${capturedHead.commitOid}, local main@${local.commitOid}.`,
      );
    }
    return {
      source: "github",
      installationId: github.installationId,
      owner: github.owner,
      repo: github.repo,
      capturedHead: { ...capturedHead, branch: "main" },
    };
  }

  const files = await Promise.all(
    [...local.paths].sort().map(async (path) => {
      const file = await repository.readFile({
        path,
        encoding: "base64",
        commitOid: local.commitOid,
      });
      if (file === null || file.commitOid !== local.commitOid) {
        throw new Error(
          `Repository ${input.path} changed or lost ${path} while its local snapshot was captured.`,
        );
      }
      return { path, contentBase64: file.content };
    }),
  );
  const after = await repository.listFiles();
  if (after.commitOid !== local.commitOid || !sameStringSet(after.paths, local.paths)) {
    throw new Error(`Repository ${input.path} changed while its local snapshot was captured.`);
  }
  return {
    source: "local",
    capturedHead: { branch: "main", commitOid: local.commitOid },
    files,
  };
}

async function restoreAdditionalRepository(input: {
  integrations: readonly RestoredIntegration[];
  project: ProjectRpc;
  repository: SeedProject["repositories"][number];
}) {
  if (input.repository.source === "local") {
    const repository = input.project.repos.get(input.repository.path);
    await repository.create({ type: "empty" });
    return await restoreLocalRepository({
      captured: input.repository,
      path: input.repository.path,
      project: input.project,
    });
  }

  const connection = requireRestoredGithubConnection({
    installationId: input.repository.installationId,
    integrations: input.integrations,
  });
  const github = input.project.integrations.github.get(connection).octokit;
  const before = await readGithubHead(github, input.repository);
  if (before.branch !== "main") {
    throw new Error(
      `Repository ${input.repository.owner}/${input.repository.repo} uses ${before.branch}; project seed restore requires main.`,
    );
  }
  const repository = input.project.repos.get(input.repository.path);
  await repository.create({
    type: "github-private",
    connection,
    owner: input.repository.owner,
    repo: input.repository.repo,
  });
  const [after, local, snapshot] = await Promise.all([
    readGithubHead(github, input.repository),
    repository.listFiles(),
    repository.processor.snapshot(),
  ]);
  if (
    after.branch !== before.branch ||
    after.commitOid !== before.commitOid ||
    local.commitOid !== before.commitOid
  ) {
    throw new Error(
      `Repository ${input.repository.path} proof failed: expected ${before.branch}@${before.commitOid}, got local ${local.commitOid} and remote ${after.branch}@${after.commitOid}.`,
    );
  }
  const link = snapshot.state.github;
  if (
    link?.connection !== connection ||
    link.installationId !== input.repository.installationId ||
    link.owner !== input.repository.owner ||
    link.repo !== input.repository.repo
  ) {
    throw new Error(`Repository ${input.repository.path} did not restore its GitHub link exactly.`);
  }
  return {
    path: input.repository.path,
    source: "github" as const,
    connection,
    owner: input.repository.owner,
    repo: input.repository.repo,
    captured: input.repository.capturedHead,
    remote: after,
    local: { branch: "main", commitOid: local.commitOid },
  };
}

async function restoreLocalRepository(input: {
  captured: z.infer<typeof LocalRepositorySeed>;
  path: string;
  project: ProjectRpc;
  workerUrls?: readonly string[];
}) {
  const repository = input.project.repos.get(input.path);
  const before = await repository.listFiles();
  const desiredPaths = new Set(input.captured.files.map((file) => file.path));
  const changes = [
    ...input.captured.files.map((file) => ({
      path: file.path,
      contentBase64: file.contentBase64,
    })),
    ...before.paths
      .filter((path) => !desiredPaths.has(path))
      .map((path) => ({ path, delete: true as const })),
  ];
  const committed =
    changes.length === 0
      ? {
          branch: "main",
          changedPaths: [] as string[],
          commitOid: before.commitOid,
          noChanges: true,
        }
      : await repository.commitFiles({
          branch: "main",
          changes,
          message: "Restore declarative project seed",
        });
  const local = await proveRepositoryFiles(repository, input.captured.files);
  if (local.commitOid !== committed.commitOid) {
    throw new Error(
      `Repository ${input.path} moved after restore (${committed.commitOid} -> ${local.commitOid}).`,
    );
  }
  const served =
    input.workerUrls === undefined
      ? null
      : await proveProjectWorkerCommit({
          expectedCommitOid: local.commitOid,
          urls: input.workerUrls,
        });
  return {
    path: input.path,
    source: "local" as const,
    captured: input.captured.capturedHead,
    local: {
      branch: committed.branch,
      changedPaths: committed.changedPaths,
      commitOid: local.commitOid,
      noChanges: committed.noChanges,
    },
    served,
  };
}

async function proveRepositoryFiles(
  repository: ReturnType<ProjectRpc["repos"]["get"]>,
  expectedFiles: readonly { contentBase64: string; path: string }[],
) {
  const listed = await repository.listFiles();
  const expectedPaths = expectedFiles.map((file) => file.path);
  if (!sameStringSet(listed.paths, expectedPaths)) {
    throw new Error(
      `Repository file proof failed: expected ${JSON.stringify([...expectedPaths].sort())}, got ${JSON.stringify([...listed.paths].sort())}.`,
    );
  }
  await Promise.all(
    expectedFiles.map(async (expected) => {
      const actual = await repository.readFile({
        path: expected.path,
        encoding: "base64",
        commitOid: listed.commitOid,
      });
      if (
        actual === null ||
        actual.commitOid !== listed.commitOid ||
        actual.content !== expected.contentBase64
      ) {
        throw new Error(`Repository file proof failed for ${expected.path}.`);
      }
    }),
  );
  const after = await repository.listFiles();
  if (after.commitOid !== listed.commitOid || !sameStringSet(after.paths, listed.paths)) {
    throw new Error("Repository changed while its restored file tree was being proved.");
  }
  return after;
}

function requireRestoredGithubConnection(input: {
  installationId: string;
  integrations: readonly RestoredIntegration[];
}) {
  const connection = input.integrations.find(
    (integration) =>
      integration.provider === "github" && integration.externalId === input.installationId,
  )?.connection;
  if (!connection) {
    throw new Error(`No restored GitHub connection for installation ${input.installationId}.`);
  }
  return connection;
}

async function captureSecretState(project: ProjectRpc, projectId: string, path: string) {
  const secretSnapshot = await project.secrets.get(path).processor.snapshot();
  if (!secretSnapshot.state.created) {
    throw new Error(`Secret ${path} has no creation fact at offset ${secretSnapshot.offset}.`);
  }
  const events: StreamEvent[] = [];
  const stream = project.streams.get(path);
  let afterOffset = 0;
  for (;;) {
    const page = await stream.getEvents({
      afterOffset,
      beforeOffset: secretSnapshot.offset + 1,
      eventTypes: ["events.iterate.com/secret/created", "events.iterate.com/secret/updated"],
      limit: 500,
    });
    if (page.length === 0) break;
    const lastOffset = page.at(-1)!.offset;
    if (lastOffset <= afterOffset) {
      throw new Error(`Secret stream ${path} did not advance while capture was paging it.`);
    }
    events.push(...page);
    afterOffset = lastOffset;
  }
  const captured = foldCapturedSecretEvents({ events, path, projectId });
  const mismatch = {
    egress: !sameStringSet(captured.egressUrls, secretSnapshot.state.egress.urls),
    hasMaterial: (captured.material !== null) !== secretSnapshot.state.hasMaterial,
    refresh: (captured.refresh?.kind ?? null) !== secretSnapshot.state.refresh,
    visibility: captured.visibility !== secretSnapshot.state.visibility,
  };
  if (Object.values(mismatch).some(Boolean)) {
    throw new Error(
      `Secret ${path} lifecycle facts disagree with its processor snapshot at offset ${secretSnapshot.offset}: ${JSON.stringify(mismatch)}.`,
    );
  }
  if (captured.material === null) {
    throw new Error(
      `Secret ${path} has no current material. Schema v1 refuses to write an archive that cannot recreate it exactly.`,
    );
  }
  return { ...captured, material: captured.material };
}

export function foldCapturedSecretEvents(input: {
  events: readonly StreamEvent[];
  path: string;
  projectId: string;
}): {
  egressUrls: string[];
  material: CiphertextMaterial | null;
  refresh: SeedProject["secrets"][number]["refresh"];
  visibility: SeedProject["secrets"][number]["visibility"];
} {
  let egressUrls: string[] | null = null;
  let material: CiphertextMaterial | null = null;
  let refresh: SeedProject["secrets"][number]["refresh"] = null;
  let visibility: SeedProject["secrets"][number]["visibility"] | null = null;

  for (const event of [...input.events].sort((left, right) => left.offset - right.offset)) {
    if (event.path !== input.path) {
      throw new Error(
        `Secret capture expected events from ${input.path}, received ${event.path}:${event.offset}.`,
      );
    }
    if (event.type === "events.iterate.com/secret/created") {
      if (visibility !== null) continue;
      const created = SecretProcessorContract.events[
        "events.iterate.com/secret/created"
      ].payloadSchema.parse(event.payload);
      egressUrls = [...created.config.egress.urls];
      refresh = created.config.refresh;
      visibility = created.config.visibility;
      material =
        created.config.encryptedMaterial === undefined
          ? null
          : ciphertextMaterial({
              encrypted: created.config.encryptedMaterial,
              egressUrls,
              offset: event.offset,
              path: input.path,
              projectId: input.projectId,
            });
      continue;
    }
    if (event.type === "events.iterate.com/secret/updated") {
      if (egressUrls === null || visibility === null) {
        throw new Error(`Secret ${input.path} has an update before its creation fact.`);
      }
      const updated = SecretProcessorContract.events[
        "events.iterate.com/secret/updated"
      ].payloadSchema.parse(event.payload);
      if (updated.egress !== undefined) egressUrls = [...updated.egress.urls];
      material =
        updated.encryptedMaterial === undefined
          ? null
          : ciphertextMaterial({
              encrypted: updated.encryptedMaterial,
              egressUrls,
              offset: event.offset,
              path: input.path,
              projectId: input.projectId,
            });
      if (updated.refresh !== undefined) refresh = updated.refresh;
    }
  }
  if (egressUrls === null || visibility === null) {
    throw new Error(`Secret ${input.path} has no creation fact.`);
  }
  return { egressUrls, material, refresh, visibility };
}

function ciphertextMaterial(input: {
  encrypted: CiphertextMaterial["encrypted"];
  egressUrls: readonly string[];
  offset: number;
  path: string;
  projectId: string;
}): CiphertextMaterial {
  return {
    source: "ciphertext",
    encrypted: input.encrypted,
    binding: {
      projectId: input.projectId,
      path: input.path,
      egressOrigins: [...new Set(input.egressUrls.map((url) => new URL(url).origin))].sort(),
      offset: input.offset,
    },
  };
}

function requireCapturedExternalId(input: {
  connection: string;
  provider: string;
  status: { externalId: string | null };
}) {
  const externalId = input.status.externalId?.trim();
  if (!externalId) {
    throw new Error(`Connected ${input.provider}/${input.connection} has no provider external ID.`);
  }
  return externalId;
}

async function restoreConfigRepoFromGithub(input: {
  project: ProjectRpc;
  config: z.infer<typeof GithubRepositorySeed>;
  integrations: readonly RestoredIntegration[];
  expectedHead: { branch: string; commitOid: string };
  workerUrls: readonly string[];
}) {
  const githubConnection = requireRestoredGithubConnection({
    installationId: input.config.installationId,
    integrations: input.integrations,
  });
  const github = input.project.integrations.github.get(githubConnection).octokit;
  const before = await readGithubHead(github, input.config);
  if (
    before.branch !== input.expectedHead.branch ||
    before.commitOid !== input.expectedHead.commitOid
  ) {
    throw new Error(
      `Config repository changed after preflight: expected ${input.expectedHead.branch}@${input.expectedHead.commitOid}, found ${before.branch}@${before.commitOid}. Run preflight again.`,
    );
  }
  const link = await input.project.repo.linkGithub({
    connection: githubConnection,
    createIfMissing: false,
    initialPush: false,
    owner: input.config.owner,
    repo: input.config.repo,
  });
  if (link.created) {
    throw new Error(
      `Config repository ${input.config.owner}/${input.config.repo} did not exist; project seeds refuse to create their GitHub authority.`,
    );
  }
  const afterLink = await readGithubHead(github, input.config);
  if (afterLink.commitOid !== before.commitOid) {
    throw new Error(
      `Config repository head changed while linking (${before.commitOid} -> ${afterLink.commitOid}).`,
    );
  }
  const reset = await input.project.repo.resetFromGithub({});
  const afterReset = await readGithubHead(github, input.config);
  if (
    reset.commitOid !== before.commitOid ||
    afterReset.commitOid !== before.commitOid ||
    reset.branch !== before.branch
  ) {
    throw new Error(
      `Config repo proof failed: expected ${before.branch}@${before.commitOid}, got local ${reset.branch}@${reset.commitOid} and remote ${afterReset.branch}@${afterReset.commitOid}.`,
    );
  }
  const served = await proveProjectWorkerCommit({
    expectedCommitOid: reset.commitOid,
    urls: input.workerUrls,
  });
  const [finalRemote, finalLocal] = await Promise.all([
    readGithubHead(github, input.config),
    input.project.repo.listFiles(),
  ]);
  if (
    finalRemote.branch !== reset.branch ||
    finalRemote.commitOid !== reset.commitOid ||
    finalLocal.commitOid !== reset.commitOid
  ) {
    throw new Error(
      `Config repo moved during served-worker proof: expected ${reset.branch}@${reset.commitOid}, got local ${finalLocal.commitOid} and remote ${finalRemote.branch}@${finalRemote.commitOid}. Run preflight again.`,
    );
  }
  return {
    connection: githubConnection,
    owner: input.config.owner,
    repo: input.config.repo,
    captured: input.config.capturedHead,
    remote: finalRemote,
    local: {
      artifactReplaced: reset.artifactReplaced,
      branch: reset.branch,
      commitOid: reset.commitOid,
    },
    served,
  };
}

export function projectWorkerProofUrls(input: {
  appBaseUrl: string;
  customHostnames: readonly string[];
  projectHostnameBases: readonly string[];
  projectSlug: string;
}) {
  const canonical = buildProjectWorkerUrl({
    appBaseUrl: input.appBaseUrl,
    projectHostnameBases: input.projectHostnameBases,
    projectSlug: input.projectSlug,
  });
  if (canonical === null) {
    throw new Error(
      `Could not derive a canonical worker URL for project ${input.projectSlug}; check APP_CONFIG_PROJECT_HOSTNAME_BASES.`,
    );
  }
  const custom = input.customHostnames.map((customHostname) => {
    const url = buildProjectWorkerUrl({
      appBaseUrl: input.appBaseUrl,
      customHostname,
      projectHostnameBases: input.projectHostnameBases,
      projectSlug: input.projectSlug,
    });
    if (url === null) {
      throw new Error(`Could not derive a worker URL for direct hostname ${customHostname}.`);
    }
    return url;
  });
  return [...new Set([canonical, ...custom])];
}

type WorkerCommitObservation = {
  attempts: number;
  buildFailed: string | null;
  building: string | null;
  cfRay: string | null;
  commitOid: string | null;
  serveError: string | null;
  status: number | null;
  url: string;
};

/**
 * Prove that every route is executing the exact repository commit adopted by
 * resetFromGithub. Worker builds are lazy, so poll with one bounded deadline
 * and retain the last non-secret observation for a useful terminal error.
 */
export async function proveProjectWorkerCommit(
  input: {
    expectedCommitOid: string;
    retryIntervalMs?: number;
    timeoutMs?: number;
    urls: readonly string[];
  },
  dependencies: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const expectedCommitOid = z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(input.expectedCommitOid);
  const urls = [...new Set(input.urls)].map((url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Worker proof URL must use HTTP(S): ${url}`);
    }
    return parsed.toString();
  });
  if (urls.length === 0) throw new Error("Worker commit proof needs at least one URL.");

  const fetchWorker = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = input.timeoutMs ?? 240_000;
  const retryIntervalMs = input.retryIntervalMs ?? 2_000;
  const deadline = now() + timeoutMs;
  const pending = new Map<string, WorkerCommitObservation>(
    urls.map((url) => [
      url,
      {
        attempts: 0,
        buildFailed: null,
        building: null,
        cfRay: null,
        commitOid: null,
        serveError: null,
        status: null,
        url,
      } satisfies WorkerCommitObservation,
    ]),
  );
  const completed = new Map<string, WorkerCommitObservation & { observedAt: string }>();

  for (;;) {
    await Promise.all(
      [...pending].map(async ([url, previous]) => {
        let observation: WorkerCommitObservation;
        try {
          const response = await fetchWorker(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          observation = {
            attempts: previous.attempts + 1,
            buildFailed: response.headers.get(WORKER_BUILD_FAILED_HEADER),
            building: response.headers.get(WORKER_BUILDING_HEADER),
            cfRay: response.headers.get("cf-ray"),
            commitOid: response.headers.get(WORKER_SERVE_HEADER),
            serveError: response.headers.get(WORKER_SERVE_ERROR_HEADER),
            status: response.status,
            url,
          };
          await response.body?.cancel();
        } catch (error) {
          throw new Error(
            `Worker commit proof request failed for ${url}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        pending.set(url, observation);
        if (
          observation.commitOid === expectedCommitOid &&
          observation.status !== null &&
          observation.status < 500 &&
          observation.buildFailed === null &&
          observation.serveError === null
        ) {
          completed.set(url, { ...observation, observedAt: new Date(now()).toISOString() });
          pending.delete(url);
          return;
        }
        if (
          observation.status === 503 &&
          observation.building === "1" &&
          observation.buildFailed === null &&
          observation.serveError === null
        ) {
          return;
        }
        throw new Error(
          `Worker commit proof failed for ${url}: expected healthy ${expectedCommitOid}, observed ${JSON.stringify(observation)}.`,
        );
      }),
    );

    if (pending.size === 0) return urls.map((url) => completed.get(url)!);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Worker commit proof timed out: expected ${expectedCommitOid}; last observations ${JSON.stringify([...pending.values()])}.`,
      );
    }
    await sleep(Math.min(retryIntervalMs, remainingMs));
  }
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
  input: { owner: string; repo: string },
) {
  let repository: { data: { default_branch: string | null } };
  try {
    repository = await github.rest.repos.get(input);
  } catch (error) {
    throw new Error(
      `Config repository ${input.owner}/${input.repo} must already exist and be accessible before restore: ${String(error)}`,
    );
  }
  const branch = repository.data.default_branch;
  if (!branch) {
    throw new Error(`Config repository ${input.owner}/${input.repo} has no default branch.`);
  }
  const ref = await github.rest.git.getRef({
    ...input,
    ref: `heads/${branch}`,
  });
  const commitOid = ref.data.object.sha;
  if (!commitOid) {
    throw new Error(`GitHub returned no head commit for ${input.owner}/${input.repo}.`);
  }
  return { branch, commitOid };
}

async function loadSelectedProject(options: SeedOptions) {
  const file = options.file?.trim();
  const projectSelector = options.project?.trim();
  if (!file || !projectSelector) {
    throw new Error("--file and --project are required.");
  }
  const raw = await readFile(file, "utf8");
  const archive = ProjectSeedArchive.parse(parseYaml(raw) as unknown);
  const project = archive.projects.find(
    (candidate) => candidate.slug === projectSelector || candidate.id === projectSelector,
  );
  if (!project) {
    throw new Error(`Project ${JSON.stringify(projectSelector)} is not in ${file}.`);
  }
  if (projectHasLocalMaterial(project)) {
    const permissions = (await stat(file)).mode & 0o777;
    if ((permissions & 0o077) !== 0) {
      throw new Error(
        `${file} contains locally stored secret material and must not be readable by group/other (current mode ${permissions.toString(8)}; use chmod 600).`,
      );
    }
  }
  return { archive, project };
}

function projectSeedPlan(archive: ProjectSeedArchive, project: SeedProject) {
  const organization = archive.organizations.find(
    (candidate) => candidate.slug === project.organization,
  )!;
  return {
    targetEnvironment: archive.targetEnvironment,
    project: {
      id: project.id,
      slug: project.slug,
      organization: project.organization,
    },
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
    secrets: project.secrets.map((secret) => ({
      path: secret.path,
      material: materialSourceLabel(secret.material),
    })),
    integrations: project.integrations.map((integration) => ({
      provider: integration.provider,
      externalId:
        integration.provider === "slack"
          ? integration.teamId
          : integration.provider === "github"
            ? integration.installationId
            : integration.provider === "google"
              ? integration.googleUserId
              : "validated from token",
      credential:
        integration.provider === "github"
          ? "deployment GitHub App"
          : materialSourceLabel(
              integration.provider === "google" ? integration.material : integration.botToken,
            ),
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
        source: repository.source,
        fullName: `${repository.owner}/${repository.repo}`,
        installationId: repository.installationId,
        capturedHead: repository.capturedHead,
      }
    : {
        source: repository.source,
        files: repository.files.length,
        capturedHead: repository.capturedHead,
      };
}

async function resolveMaterial(source: MaterialSource): Promise<unknown> {
  if (source.source === "inline") return source.value;
  if (source.source === "ciphertext") {
    try {
      return await unwrapCiphertextMaterial(source, requireEnvironment("SECRET_ENCRYPTION_KEY"));
    } catch (error) {
      throw new Error(
        `Could not unwrap ${materialSourceLabel(source)}. The archive binding, ciphertext, and target environment's SECRET_ENCRYPTION_KEY must match.`,
        { cause: error },
      );
    }
  }
  const value = requireEnvironment(source.name);
  if (source.encoding === "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Environment variable ${source.name} is not valid JSON: ${String(error)}`);
  }
}

export async function unwrapCiphertextMaterial(
  source: CiphertextMaterial,
  encryptionKey: string,
): Promise<unknown> {
  const serialized = await decryptSecretCellMaterial(
    source.encrypted,
    encryptionKey,
    source.binding,
  );
  return JSON.parse(serialized) as unknown;
}

async function resolveStringMaterial(
  source: z.infer<typeof StringMaterialSource>,
): Promise<string> {
  const material = await resolveMaterial(source);
  if (typeof material !== "string" || material.trim() === "") {
    throw new Error(`${materialSourceLabel(source)} must resolve to a non-empty string.`);
  }
  return material;
}

function materialSourceLabel(source: MaterialSource) {
  if (source.source === "inline") return "inline (local plaintext)";
  if (source.source === "ciphertext") {
    return `ciphertext:${source.binding.projectId}${source.binding.path}@${source.binding.offset}`;
  }
  return `environment:${source.name}`;
}

function projectHasLocalMaterial(project: SeedProject) {
  return (
    project.secrets.some((secret) => secret.material.source !== "env") ||
    project.integrations.some(
      (integration) =>
        integration.provider !== "github" &&
        (integration.provider === "google" ? integration.material : integration.botToken).source !==
          "env",
    ) ||
    project.configRepo?.source === "local" ||
    project.repositories.some((repository) => repository.source === "local")
  );
}

function projectHostnameBases() {
  const raw = requireEnvironment("APP_CONFIG_PROJECT_HOSTNAME_BASES");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `APP_CONFIG_PROJECT_HOSTNAME_BASES is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return z.array(z.string().trim().min(1)).min(1).parse(parsed);
}

function resolveOsBaseUrl(explicit: string | undefined) {
  const value =
    explicit?.trim() ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readDevServerInfo(new URL("..", import.meta.url).pathname, { requireLive: true })?.baseUrl;
  if (!value) {
    throw new Error(
      "No OS base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start local dev.",
    );
  }
  return value.replace(/\/+$/, "");
}

function resolveAuthBaseUrl(explicit: string | undefined) {
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, "");
  const issuer = requireEnvironment("APP_CONFIG_ITERATE_AUTH__ISSUER");
  const url = new URL(issuer);
  if (!url.pathname.endsWith("/api/auth")) {
    throw new Error(
      `Cannot derive Auth base URL from issuer ${issuer}; pass --auth-base-url explicitly.`,
    );
  }
  url.pathname = url.pathname.slice(0, -"/api/auth".length) || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function resolveAuthServiceToken(targetEnvironment: string) {
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
      targetEnvironment,
      "--plain",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const token = result.stdout?.trim();
  if (result.status !== 0 || !token) {
    throw new Error(
      `Could not read Auth's service token from Doppler auth/${targetEnvironment}. Set PROJECT_SEED_AUTH_SERVICE_TOKEN or fix Doppler access. ${result.stderr?.trim() ?? ""}`.trim(),
    );
  }
  return token;
}

function assertTargetEnvironment(expected: string) {
  const actual = process.env.DOPPLER_CONFIG?.trim();
  if (!actual) {
    throw new Error("DOPPLER_CONFIG is missing; run project-seed through pnpm cli.");
  }
  if (actual !== expected) {
    throw new Error(
      `Seed operation targets ${expected}, but the active Doppler config is ${actual}. Refusing a cross-environment operation.`,
    );
  }
}

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function reportDuplicates(
  values: readonly string[],
  path: PropertyKey[],
  label: string,
  context: z.core.$RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label}: ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

function reportCiphertextBinding(
  source: MaterialSource,
  expected: { path?: string; projectId: string },
  path: PropertyKey[],
  context: z.core.$RefinementCtx,
) {
  if (source.source !== "ciphertext") return;
  if (source.binding.projectId !== expected.projectId) {
    context.addIssue({
      code: "custom",
      message: `Ciphertext is bound to project ${source.binding.projectId}, expected ${expected.projectId}`,
      path: [...path, "binding", "projectId"],
    });
  }
  if (expected.path !== undefined && source.binding.path !== expected.path) {
    context.addIssue({
      code: "custom",
      message: `Ciphertext is bound to secret ${source.binding.path}, expected ${expected.path}`,
      path: [...path, "binding", "path"],
    });
  }
}
