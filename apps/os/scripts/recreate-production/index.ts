import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import type { RpcStub } from "capnweb";

import type {
  BuiltinIntegrationSlug,
  IntegrationConnectionListEntry,
  Project,
  ProjectListEntry,
  SecretDescription,
  Session,
  StreamRecovery,
} from "../../src/itx-api.generated.ts";
import { connectItx } from "../../src/itx-client.ts";
import {
  assertValidStreamRecoveryLog,
  STREAM_RECOVERY_FORMAT,
  STREAM_RECOVERY_VERSION,
  StreamRecoveryRestoreInput,
  type StreamRecoveryExportPage,
} from "../../src/domains/streams/recovery.ts";
import {
  expectedRestoreConfirmation,
  PRODUCTION_RECOVERY_FORMAT,
  PRODUCTION_RECOVERY_VERSION,
  ProductionRecoveryPackage,
  type ProductionRecoveryPackage as ProductionRecoveryPackageType,
} from "./package.ts";

const CONFIG_REPO_PATH = "/repos/config";
const EMAIL_INTEGRATION_PATH = "/integrations/email";
const INTEGRATION_DIRECTORY_PATH = "/integrations/_directory";
const PROJECT_ROOT_PATH = "/";
const PROJECT_WORKER_READY_URL = "https://iterate-project.localhost/__itx_project_ready";
const MAX_RECOVERY_STREAM_BYTES = 8 * 1024 * 1024;
const READY_WAIT_TIMEOUT_MS = 60_000;

type ConnectionOptions = { baseUrl?: string };

type ExportProjectsOptions = ConnectionOptions & {
  /** Comma-separated project slugs or prj_ ids. */
  projects: string;
  /** PR URL/number or other identifier for the breaking change. Stored in the package. */
  breakingChange?: string;
  /** JSON package path. Defaults to a new private temporary directory. */
  out?: string;
};

/**
 * Export the minimum durable production state: every secret stream, every
 * built-in integration connection stream, the minimum project bootstrap
 * facts, and the selected projects' global integration-directory claims.
 * GitHub, rather than the old config stream, is the config repo authority.
 */
export async function exportProjects(options: ExportProjectsOptions) {
  const connection = adminConnection(options);
  using session = connectItx(connection);
  const deploymentProjects = await session.projects.list({ scope: "deployment" });
  const selected = resolveSelectedProjects(options.projects, deploymentProjects);

  const projects: ProductionRecoveryPackageType["projects"] = [];
  for (const identity of selected) {
    using project = (await session.projects.get(identity.id)) as unknown as RpcStub<Project>;
    projects.push(await exportProject(session, project, identity));
  }

  const directory = await exportCompleteStream(
    session.streamRecovery.get({ projectId: null, path: INTEGRATION_DIRECTORY_PATH }),
  );
  const filteredDirectory = StreamRecoveryRestoreInput.parse({
    format: STREAM_RECOVERY_FORMAT,
    version: STREAM_RECOVERY_VERSION,
    stream: directory.stream,
    highestAssignedOffset: directory.highestAssignedOffset,
    events: integrationDirectoryRecoveryEvents(
      directory.events,
      new Set(selected.map((project) => project.id)),
    ),
  });

  const recoveryPackage: ProductionRecoveryPackageType = {
    format: PRODUCTION_RECOVERY_FORMAT,
    version: PRODUCTION_RECOVERY_VERSION,
    exportedAt: new Date().toISOString(),
    ...(options.breakingChange?.trim() ? { breakingChange: options.breakingChange.trim() } : {}),
    source: {
      baseUrl: connection.baseUrl,
      ...(process.env.DOPPLER_CONFIG?.trim()
        ? { dopplerConfig: process.env.DOPPLER_CONFIG.trim() }
        : {}),
    },
    projects,
    globalStreams: [filteredDirectory],
  };
  const parsed = ProductionRecoveryPackage.parse(recoveryPackage);
  assertRecoveryPackageRestorable(parsed, { allowProvidedIntegrations: true });
  const outputPath = await recoveryOutputPath(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);

  return {
    outputPath,
    projects: parsed.projects.map(projectSummary),
    restoreConfirmation: expectedRestoreConfirmation(parsed),
  };
}

/** Validate package completeness before merging the breaking PR. */
export async function preflight(options: { file: string }) {
  const recoveryPackage = await readPackage(options.file);
  const problems = recoveryPackageProblems(recoveryPackage);

  if (problems.length > 0) {
    throw new Error(`Recovery preflight failed:\n- ${problems.join("\n- ")}`);
  }
  return {
    ok: true,
    breakingChange: recoveryPackage.breakingChange ?? null,
    projects: recoveryPackage.projects.map(projectSummary),
    agentReviewRequired:
      "Inspect the breaking-change diff against these event payloads before cutover; transform a copy of the JSON package or stop and consult the user if the target code cannot consume them.",
    restoreConfirmation: expectedRestoreConfirmation(recoveryPackage),
  };
}

type RestoreOptions = ConnectionOptions & {
  file: string;
  /** Exact value printed by export/preflight, e.g. RESTORE:prj_a,prj_b. */
  confirm: string;
  /** Allow overwriting recovery streams in a project already reporting ready. */
  replaceReady?: boolean;
};

/** Restore selected projects, re-link config repos, sync GitHub inward, then verify inventories. */
export async function restore(options: RestoreOptions) {
  const recoveryPackage = await readPackage(options.file);
  assertRecoveryPackageRestorable(recoveryPackage);
  const expectedConfirmation = expectedRestoreConfirmation(recoveryPackage);
  if (options.confirm !== expectedConfirmation) {
    throw new Error(`Refusing restore: --confirm must equal ${expectedConfirmation}`);
  }

  const connection = adminConnection(options);
  using session = connectItx(connection);
  const targetProjects = await session.projects.list({ scope: "deployment" });

  for (const saved of recoveryPackage.projects) {
    const target = targetProjects.find((project) => project.id === saved.identity.id);
    if (!target) {
      throw new Error(
        `Project ${saved.identity.slug} (${saved.identity.id}) is absent from the preserved Auth directory. Refusing to manufacture a replacement identity.`,
      );
    }
    if (target.slug !== saved.identity.slug) {
      throw new Error(
        `Project ${saved.identity.id} is now slugged ${target.slug}, not exported slug ${saved.identity.slug}`,
      );
    }
    if (target?.deploymentStatus === "ready" && !options.replaceReady) {
      throw new Error(
        `Project ${saved.identity.slug} (${saved.identity.id}) is already ready. Pass --replace-ready only after confirming it is the fresh post-reset bootstrap.`,
      );
    }
    if (target?.deploymentStatus === "unknown") {
      throw new Error(
        `Project ${saved.identity.slug} has unknown target status; inspect it before restoring.`,
      );
    }
    for (const stream of [...saved.streams].sort(compareRestoreOrder)) {
      await session.streamRecovery
        .get({ projectId: saved.identity.id, path: stream.stream.path })
        .restoreFromRecovery(stream);
    }
  }

  for (const stream of recoveryPackage.globalStreams) {
    await session.streamRecovery
      .get({ projectId: null, path: stream.stream.path })
      .restoreFromRecovery(stream);
  }

  const readyProjects = await waitForReadyProjects(
    session,
    new Set(recoveryPackage.projects.map((project) => project.identity.id)),
  );
  for (const saved of recoveryPackage.projects) {
    if (
      readyProjects.find((project) => project.id === saved.identity.id)?.deploymentStatus !==
      "ready"
    ) {
      throw new Error(`${saved.identity.slug}: project did not become ready after stream restore`);
    }
  }

  const configRepos = [];
  for (const saved of recoveryPackage.projects) {
    using project = (await session.projects.get(saved.identity.id)) as unknown as RpcStub<Project>;
    const github = saved.configRepo.github;
    const link = await project.repo.linkGithub({
      connection: github.connection,
      owner: github.owner,
      repo: github.repo,
    });
    // GitHub is authoritative. No depth means all history; if that exceeds the
    // DO limit, the command fails and the skill asks the user about a depth.
    const sync = await project.repo.syncFromGithub({ force: true });
    const workerResponse = await project.worker.fetch(new Request(PROJECT_WORKER_READY_URL));
    disposeRpcResult(workerResponse);
    configRepos.push({
      projectId: saved.identity.id,
      github: `${github.owner}/${github.repo}`,
      exportedHead: saved.configRepo.exportedHead,
      restoredHead: sync.commitOid,
      initialPush: link.initialPush,
    });
  }

  const verification = assertVerification(await verifyPackage(session, recoveryPackage));
  return { configRepos, verification };
}

/** Re-run the non-secret inventory and secret-material checks without mutating the deployment. */
export async function verify(options: ConnectionOptions & { file: string }) {
  const recoveryPackage = await readPackage(options.file);
  assertRecoveryPackageRestorable(recoveryPackage);
  using session = connectItx(adminConnection(options));
  return assertVerification(await verifyPackage(session, recoveryPackage));
}

async function exportProject(
  session: RpcStub<Session>,
  project: RpcStub<Project>,
  identity: ProjectListEntry,
): Promise<ProductionRecoveryPackageType["projects"][number]> {
  const [secretList, rawIntegrationInventory, repoSnapshot, repoLog] = await Promise.all([
    project.secrets.list(),
    project.integrations.list(),
    project.repo.processor.snapshot(),
    project.repo.log({ limit: 1 }),
  ]);
  if (repoSnapshot.state.github === null) {
    throw new Error(
      `${identity.slug}: config repo is not linked to GitHub; this MVP requires GitHub as the history source`,
    );
  }
  const exportedHead = repoLog.commits[0]?.oid;
  if (!exportedHead) throw new Error(`${identity.slug}: config repo has no commits`);
  const mirrored = await project.repo.pushToGithub({});
  if (mirrored.commitOid !== exportedHead) {
    throw new Error(
      `${identity.slug}: GitHub mirror confirmed ${mirrored.commitOid}, not exported config head ${exportedHead}`,
    );
  }

  const secretInventory = await Promise.all(
    secretList.map(async ({ path }) => {
      const description = await project.secrets.get(path).__describe();
      return publicSecretInventory(path, description);
    }),
  );
  const integrationInventory = await Promise.all(
    rawIntegrationInventory.map(async (entry) => {
      if (entry.source !== "builtin" || entry.connection === null) {
        return { ...normalizeIntegrationInventory(entry), status: null };
      }
      const status = await project.integrations.getConnection({
        connection: entry.connection,
        provider: integrationProvider(entry.integration),
      });
      return {
        ...normalizeIntegrationInventory(entry),
        status: { connected: status.connected, externalId: status.externalId },
      };
    }),
  );
  const paths = new Set<string>([
    PROJECT_ROOT_PATH,
    EMAIL_INTEGRATION_PATH,
    ...secretList.map((secret) => secret.path),
    ...integrationInventory.filter(integrationHasJournal).map((integration) => integration.path),
  ]);
  const streams: StreamRecoveryRestoreInput[] = [];
  for (const path of [...paths].sort()) {
    const exported = await exportCompleteStream(
      session.streamRecovery.get({ projectId: identity.id, path }),
    );
    const integration = integrationInventory.find((entry) => entry.path === path);
    streams.push(
      StreamRecoveryRestoreInput.parse({
        format: exported.format,
        version: exported.version,
        stream: exported.stream,
        highestAssignedOffset: exported.highestAssignedOffset,
        events:
          path === PROJECT_ROOT_PATH
            ? projectBackboneEvents(exported.events)
            : path === EMAIL_INTEGRATION_PATH
              ? emailRecoveryEvents(exported.events)
              : integration?.source === "builtin"
                ? exported.events.filter(isBuiltinIntegrationControlEvent)
                : exported.events,
      }),
    );
  }

  return {
    identity: {
      id: identity.id,
      slug: identity.slug,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
      organizationSlug: identity.organizationSlug,
    },
    streams,
    integrationInventory,
    secretInventory,
    configRepo: {
      path: CONFIG_REPO_PATH,
      exportedHead,
      github: repoSnapshot.state.github,
    },
  };
}

async function exportCompleteStream(
  stream: RpcStub<StreamRecovery>,
): Promise<StreamRecoveryRestoreInput> {
  const events: StreamRecoveryRestoreInput["events"] = [];
  let afterOffset = 0;
  let throughOffset: number | undefined;
  for (;;) {
    const page: StreamRecoveryExportPage = await stream.exportForRecovery({
      afterOffset,
      limit: 500,
      ...(throughOffset === undefined ? {} : { throughOffset }),
    });
    throughOffset ??= page.throughOffset;
    if (page.throughOffset !== throughOffset) {
      throw new Error("recovery export boundary changed between pages");
    }
    events.push(...page.events);
    const lastOffset = page.events.at(-1)?.offset;
    if (page.complete || lastOffset === undefined) {
      return StreamRecoveryRestoreInput.parse({
        format: page.format,
        version: page.version,
        stream: page.stream,
        highestAssignedOffset: throughOffset,
        events,
      });
    }
    afterOffset = lastOffset;
  }
}

async function verifyPackage(
  session: RpcStub<Session>,
  recoveryPackage: ProductionRecoveryPackageType,
) {
  const deploymentProjects = await waitForReadyProjects(
    session,
    new Set(recoveryPackage.projects.map((project) => project.identity.id)),
  );
  const projects = [];
  const failures: string[] = [];
  for (const saved of recoveryPackage.projects) {
    const deploymentProject = deploymentProjects.find(
      (project) => project.id === saved.identity.id,
    );
    if (deploymentProject?.deploymentStatus !== "ready") {
      failures.push(`${saved.identity.slug}: project did not become ready after restore`);
    }
    using project = (await session.projects.get(saved.identity.id)) as unknown as RpcStub<Project>;
    const secrets = await Promise.all(
      saved.secretInventory.map(async (expected) => {
        const actual = await project.secrets.get(expected.path).__describe();
        const material = await session.streamRecovery
          .get({ projectId: saved.identity.id, path: expected.path })
          .verifySecretMaterial();
        const materialOk = actual.hasMaterial === expected.hasMaterial;
        const decryptable = material.hasMaterial === expected.hasMaterial;
        const egressOk =
          [...actual.egress.urls].sort().join("\0") === [...expected.egressUrls].sort().join("\0");
        const refreshOk = actual.refresh === expected.refresh;
        const ok = materialOk && decryptable && egressOk && refreshOk;
        if (!ok) failures.push(`${saved.identity.slug}: secret ${expected.path} metadata mismatch`);
        return {
          path: expected.path,
          expectedHasMaterial: expected.hasMaterial,
          hasMaterial: actual.hasMaterial,
          decryptable,
          egressOk,
          refreshOk,
          ok,
        };
      }),
    );
    const actualIntegrations = await waitForIntegrationInventory(
      project,
      saved.integrationInventory,
    );
    const actualKeys = new Set(actualIntegrations.map(integrationKey));
    const missingIntegrations = saved.integrationInventory.filter(
      (expected) => !actualKeys.has(integrationKey(expected)),
    );
    for (const missing of missingIntegrations) {
      failures.push(`${saved.identity.slug}: integration ${missing.path} is missing`);
    }
    const integrationStatuses = await Promise.all(
      saved.integrationInventory.flatMap((expected) => {
        if (
          expected.source !== "builtin" ||
          expected.connection === null ||
          expected.status === null
        ) {
          return [];
        }
        const expectedStatus = expected.status;
        return [
          project.integrations
            .getConnection({
              connection: expected.connection,
              provider: integrationProvider(expected.integration),
            })
            .then((actual) => {
              const ok =
                actual.connected === expectedStatus.connected &&
                actual.externalId === expectedStatus.externalId;
              if (!ok) {
                failures.push(
                  `${saved.identity.slug}: integration ${expected.path} status/external id mismatch`,
                );
              }
              return {
                path: expected.path,
                connected: actual.connected,
                externalId: actual.externalId,
                ok,
              };
            }),
        ];
      }),
    );
    const repoLog = await project.repo.log({ limit: 1 });
    const configRepoHead = repoLog.commits[0]?.oid ?? null;
    if (configRepoHead !== saved.configRepo.exportedHead) {
      failures.push(
        `${saved.identity.slug}: config repo head ${configRepoHead ?? "missing"} does not match exported head ${saved.configRepo.exportedHead}`,
      );
    }
    const repoSnapshot = await project.repo.processor.snapshot();
    const restoredGithub = repoSnapshot.state.github;
    const githubOk =
      restoredGithub !== null &&
      restoredGithub.connection === saved.configRepo.github.connection &&
      restoredGithub.owner === saved.configRepo.github.owner &&
      restoredGithub.repo === saved.configRepo.github.repo;
    if (!githubOk) failures.push(`${saved.identity.slug}: config repo GitHub link mismatch`);
    const workerResponse = await project.worker.fetch(new Request(PROJECT_WORKER_READY_URL));
    disposeRpcResult(workerResponse);
    projects.push({
      projectId: saved.identity.id,
      deploymentStatus: deploymentProject?.deploymentStatus ?? "absent",
      slug: saved.identity.slug,
      secrets,
      missingIntegrations,
      integrationStatuses,
      configRepoHead,
      githubLinkOk: githubOk,
      github: `${saved.configRepo.github.owner}/${saved.configRepo.github.repo}`,
    });
  }
  const expectedDirectory = recoveryPackage.globalStreams.find(
    (stream) => stream.stream.path === INTEGRATION_DIRECTORY_PATH,
  );
  if (expectedDirectory === undefined) {
    failures.push("deployment: saved integration directory is absent");
  }
  const actualDirectory = await exportCompleteStream(
    session.streamRecovery.get({ projectId: null, path: INTEGRATION_DIRECTORY_PATH }),
  );
  const expectedClaims = foldActiveIntegrationClaims(expectedDirectory?.events ?? []);
  const actualClaims = foldActiveIntegrationClaims(actualDirectory.events);
  const integrationDirectoryOk = JSON.stringify(actualClaims) === JSON.stringify(expectedClaims);
  if (!integrationDirectoryOk) {
    failures.push("deployment: active integration webhook routing claims differ from the package");
  }
  return {
    ok: failures.length === 0,
    failures,
    projects,
    integrationDirectory: {
      ok: integrationDirectoryOk,
      expectedClaims,
      actualClaims,
    },
  };
}

async function waitForIntegrationInventory(
  project: RpcStub<Project>,
  expected: ProductionRecoveryPackageType["projects"][number]["integrationInventory"],
) {
  let latest: IntegrationConnectionListEntry[] = [];
  const expectedKeys = new Set(expected.map(integrationKey));
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  do {
    latest = await project.integrations.list();
    const actualKeys = new Set(latest.map(integrationKey));
    if ([...expectedKeys].every((key) => actualKeys.has(key))) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  } while (Date.now() < deadline);
  return latest;
}

function publicSecretInventory(path: string, description: SecretDescription) {
  return {
    path,
    hasMaterial: description.hasMaterial,
    egressUrls: description.egress.urls,
    refresh: description.refresh,
  };
}

function normalizeIntegrationInventory(entry: IntegrationConnectionListEntry) {
  return {
    connection: entry.connection,
    integration: entry.integration,
    path: entry.path,
    source: entry.source,
  };
}

function integrationProvider(integration: string): BuiltinIntegrationSlug {
  const provider = integration === "gmail" ? "google" : integration;
  if (
    provider !== "github" &&
    provider !== "google" &&
    provider !== "slack" &&
    provider !== "telegram" &&
    provider !== "waitrose"
  ) {
    throw new Error(`Unknown built-in integration provider: ${integration}`);
  }
  return provider;
}

function integrationHasJournal(integration: {
  integration: string;
  source: "builtin" | "provided";
}) {
  return integration.source === "builtin" && integration.integration !== "waitrose";
}

function integrationKey(entry: {
  connection: string | null;
  integration: string;
  path: string;
  source: string;
}) {
  return `${entry.source}:${entry.integration}:${entry.connection ?? "*"}:${entry.path}`;
}

function compareRestoreOrder(left: StreamRecoveryRestoreInput, right: StreamRecoveryRestoreInput) {
  return (
    restoreRank(left.stream.path) - restoreRank(right.stream.path) ||
    left.stream.path.localeCompare(right.stream.path)
  );
}

function restoreRank(path: string) {
  if (path === PROJECT_ROOT_PATH) return 0;
  if (path.startsWith("/secrets/")) return 1;
  if (path.startsWith("/integrations/")) return 2;
  if (path === CONFIG_REPO_PATH) return 3;
  return 4;
}

export function projectBackboneEvents(events: StreamRecoveryRestoreInput["events"]) {
  const projectWorkerOffset = events.findLast(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      event.payload?.subscriptionKey === "project-worker",
  )?.offset;
  const projectProcessorOffset = events.findLast(isProjectProcessorSubscription)?.offset;
  return events
    .filter((event) => {
      if (event.type === "events.iterate.com/stream/created") return true;
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        if (event.offset === projectWorkerOffset || event.offset === projectProcessorOffset)
          return true;
      }
      if (
        event.type === "events.iterate.com/project/egress-rules-configured" ||
        event.type === "events.iterate.com/project/human-approval-key-added" ||
        event.type === "events.iterate.com/project/human-approval-key-revoked"
      ) {
        return true;
      }
      // Deliberately discard the old project/created completion. Replaying
      // create-requested through the retained ProjectProcessor subscription
      // must exercise fresh config-repo creation and append a new completion.
      return event.type === "events.iterate.com/project/create-requested";
    })
    .map((event) =>
      event.type === "events.iterate.com/project/create-requested"
        ? {
            ...event,
            payload: {
              projectId: event.payload?.projectId,
              slug: event.payload?.slug,
            },
          }
        : event,
    );
}

export function emailRecoveryEvents(events: StreamRecoveryRestoreInput["events"]) {
  return events.filter(
    (event) =>
      event.type === "events.iterate.com/stream/created" ||
      event.type === "events.iterate.com/stream/subscription-configured" ||
      event.type === "events.iterate.com/stream/subscription-removed" ||
      event.type === "events.iterate.com/email/sender-allowed",
  );
}

type ActiveIntegrationClaim = {
  connection: string;
  externalId: string;
  projectId: string;
  slug: string;
};

export function foldActiveIntegrationClaims(
  events: StreamRecoveryRestoreInput["events"],
): ActiveIntegrationClaim[] {
  const claims = new Map<string, ActiveIntegrationClaim>();
  for (const event of events) {
    const connection = event.payload?.connection;
    const externalId = event.payload?.externalId;
    const projectId = event.payload?.projectId;
    const slug = event.payload?.slug;
    if (
      typeof connection !== "string" ||
      typeof externalId !== "string" ||
      typeof projectId !== "string" ||
      typeof slug !== "string"
    ) {
      continue;
    }
    const key = `${slug}\0${externalId}`;
    const existing = claims.get(key);
    if (event.type === "events.iterate.com/integration/connection-claimed") {
      if (existing === undefined || existing.projectId === projectId) {
        claims.set(key, { connection, externalId, projectId, slug });
      }
    } else if (
      event.type === "events.iterate.com/integration/connection-unclaimed" &&
      existing?.projectId === projectId &&
      existing.connection === connection
    ) {
      claims.delete(key);
    }
  }
  return [...claims.values()].sort(
    (left, right) =>
      left.slug.localeCompare(right.slug) || left.externalId.localeCompare(right.externalId),
  );
}

export function integrationDirectoryRecoveryEvents(
  events: StreamRecoveryRestoreInput["events"],
  selectedProjectIds: Set<string>,
) {
  const latestOffsets = new Set<number>();
  for (const claim of foldActiveIntegrationClaims(events)) {
    if (!selectedProjectIds.has(claim.projectId)) continue;
    const latest = events.findLast(
      (event) =>
        event.type === "events.iterate.com/integration/connection-claimed" &&
        integrationClaimKey(event.payload) === integrationClaimKey(claim),
    );
    if (latest !== undefined) latestOffsets.add(latest.offset);
  }
  return events.filter(
    (event) =>
      event.type === "events.iterate.com/stream/created" || latestOffsets.has(event.offset),
  );
}

function integrationClaimKey(value: Record<string, unknown> | ActiveIntegrationClaim | undefined) {
  return `${String(value?.slug)}\0${String(value?.externalId)}\0${String(value?.projectId)}\0${String(value?.connection)}`;
}

function isProjectProcessorSubscription(event: StreamRecoveryRestoreInput["events"][number]) {
  const delivery = event.payload?.delivery;
  if (delivery === null || typeof delivery !== "object" || Array.isArray(delivery)) return false;
  const candidate = delivery as Record<string, unknown>;
  return (
    candidate.mode === "wake" &&
    candidate.processorSlug === "project" &&
    JSON.stringify(candidate.expression) === JSON.stringify(["processor", "wakeStreamSubscriber"])
  );
}

function isBuiltinIntegrationControlEvent(event: StreamRecoveryRestoreInput["events"][number]) {
  return (
    event.type === "events.iterate.com/stream/created" ||
    event.type === "events.iterate.com/stream/subscription-configured" ||
    event.type === "events.iterate.com/stream/subscription-removed" ||
    event.type === "events.iterate.com/slack/connected" ||
    event.type === "events.iterate.com/slack/disconnected" ||
    event.type === "events.iterate.com/google/connected" ||
    event.type === "events.iterate.com/google/disconnected" ||
    event.type === "events.iterate.com/github/connected" ||
    event.type === "events.iterate.com/github/disconnected" ||
    event.type === "events.iterate.com/telegram/connected" ||
    event.type === "events.iterate.com/telegram/disconnected"
  );
}

async function waitForReadyProjects(session: RpcStub<Session>, expectedIds: Set<string>) {
  let latest: ProjectListEntry[] = [];
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  do {
    latest = await session.projects.list({ scope: "deployment" });
    if (
      [...expectedIds].every(
        (id) => latest.find((project) => project.id === id)?.deploymentStatus === "ready",
      )
    ) {
      return latest;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  } while (Date.now() < deadline);
  return latest;
}

function assertVerification<T extends { failures: string[]; ok: boolean }>(verification: T): T {
  if (!verification.ok) {
    throw new Error(
      `Production recovery verification failed:\n- ${verification.failures.join("\n- ")}`,
    );
  }
  return verification;
}

function assertRecoveryPackageRestorable(
  recoveryPackage: ProductionRecoveryPackageType,
  options: { allowProvidedIntegrations?: boolean } = {},
): void {
  const problems = recoveryPackageProblems(recoveryPackage, options);
  if (problems.length > 0) {
    throw new Error(`Recovery package cannot be restored:\n- ${problems.join("\n- ")}`);
  }
}

function recoveryPackageProblems(
  recoveryPackage: ProductionRecoveryPackageType,
  options: { allowProvidedIntegrations?: boolean } = {},
): string[] {
  const problems: string[] = [];

  for (const project of recoveryPackage.projects) {
    const streamPaths = new Set(project.streams.map((stream) => stream.stream.path));
    if (!streamPaths.has(PROJECT_ROOT_PATH)) {
      problems.push(`${project.identity.slug}: minimal project-root stream is absent`);
    }
    if (!streamPaths.has(EMAIL_INTEGRATION_PATH)) {
      problems.push(`${project.identity.slug}: email sender-policy stream is absent`);
    }
    const duplicatePaths = duplicateValues(project.streams.map((stream) => stream.stream.path));
    if (duplicatePaths.length > 0) {
      problems.push(
        `${project.identity.slug}: duplicate stream paths: ${duplicatePaths.join(", ")}`,
      );
    }
    const rootStream = project.streams.find((stream) => stream.stream.path === PROJECT_ROOT_PATH);
    if (rootStream !== undefined) {
      const hasProjectWorker = rootStream.events.some(
        (event) =>
          event.type === "events.iterate.com/stream/subscription-configured" &&
          event.payload?.subscriptionKey === "project-worker",
      );
      const hasProjectProcessor = rootStream.events.some(isProjectProcessorSubscription);
      const createRequests = rootStream.events.filter(
        (event) => event.type === "events.iterate.com/project/create-requested",
      );
      if (!hasProjectWorker) {
        problems.push(`${project.identity.slug}: project-worker root subscription is absent`);
      }
      if (!hasProjectProcessor) {
        problems.push(`${project.identity.slug}: ProjectProcessor root subscription is absent`);
      }
      if (createRequests.length !== 1) {
        problems.push(
          `${project.identity.slug}: minimal root must contain exactly one project/create-requested event`,
        );
      }
      if (rootStream.events.some((event) => event.type === "events.iterate.com/project/created")) {
        problems.push(
          `${project.identity.slug}: old project/created completion would bypass fresh bootstrap`,
        );
      }
    }
    for (const stream of project.streams) {
      collectRecoveryStreamProblems(
        problems,
        stream,
        { projectId: project.identity.id, path: stream.stream.path },
        `${project.identity.slug}:${stream.stream.path}`,
      );
    }
    for (const secret of project.secretInventory) {
      if (!streamPaths.has(secret.path)) {
        problems.push(`${project.identity.slug}: secret stream ${secret.path} is absent`);
      }
    }
    for (const integration of project.integrationInventory) {
      if (integrationHasJournal(integration) && !streamPaths.has(integration.path)) {
        problems.push(
          `${project.identity.slug}: integration connection stream ${integration.path} is absent`,
        );
      }
      if (integration.source === "builtin" && integration.status === null) {
        problems.push(
          `${project.identity.slug}: integration ${integration.path} has no saved status`,
        );
      }
      if (integration.source === "provided" && !options.allowProvidedIntegrations) {
        problems.push(
          `${project.identity.slug}: provided integration ${integration.path} is outside this narrow MVP; the breaking PR needs an explicit rehydrator or the user must remove it from the recovery scope`,
        );
      }
    }
    if (project.configRepo.github.connection.trim() === "") {
      problems.push(`${project.identity.slug}: config repo has no GitHub connection`);
    }
  }

  const duplicateProjectIds = duplicateValues(
    recoveryPackage.projects.map((project) => project.identity.id),
  );
  if (duplicateProjectIds.length > 0) {
    problems.push(`duplicate project ids: ${duplicateProjectIds.join(", ")}`);
  }
  const duplicateGlobalPaths = duplicateValues(
    recoveryPackage.globalStreams.map((stream) => stream.stream.path),
  );
  if (duplicateGlobalPaths.length > 0) {
    problems.push(`duplicate global stream paths: ${duplicateGlobalPaths.join(", ")}`);
  }
  if (
    !recoveryPackage.globalStreams.some(
      (stream) =>
        stream.stream.projectId === null && stream.stream.path === INTEGRATION_DIRECTORY_PATH,
    )
  ) {
    problems.push("global integration directory stream is absent");
  }
  for (const stream of recoveryPackage.globalStreams) {
    collectRecoveryStreamProblems(
      problems,
      stream,
      { projectId: null, path: stream.stream.path },
      `deployment:${stream.stream.path}`,
    );
  }

  return problems;
}

function collectRecoveryStreamProblems(
  problems: string[],
  stream: StreamRecoveryRestoreInput,
  expected: { projectId: string | null; path: string },
  label: string,
): void {
  try {
    assertValidStreamRecoveryLog(stream, expected);
  } catch (error) {
    problems.push(`${label}: ${String(error)}`);
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(stream)).byteLength;
  if (serializedBytes > MAX_RECOVERY_STREAM_BYTES) {
    problems.push(
      `${label}: ${serializedBytes} serialized bytes exceed the MVP limit of ${MAX_RECOVERY_STREAM_BYTES}`,
    );
  }
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}

function resolveSelectedProjects(raw: string, deployment: ProjectListEntry[]) {
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) throw new Error("--projects must name at least one project");
  const selected = requested.map((requestedProject) => {
    const matches = deployment.filter(
      (project) => project.id === requestedProject || project.slug === requestedProject,
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No production project matches ${requestedProject}`
          : `Project slug ${requestedProject} is ambiguous; use its prj_ id`,
      );
    }
    return matches[0]!;
  });
  const unique = new Map(selected.map((project) => [project.id, project]));
  return [...unique.values()];
}

function projectSummary(project: ProductionRecoveryPackageType["projects"][number]) {
  return {
    id: project.identity.id,
    slug: project.identity.slug,
    streams: project.streams.length,
    events: project.streams.reduce((sum, stream) => sum + stream.events.length, 0),
    integrations: project.integrationInventory.length,
    secrets: project.secretInventory.length,
    configRepo: `${project.configRepo.github.owner}/${project.configRepo.github.repo}`,
  };
}

async function readPackage(path: string) {
  const raw = await readFile(resolve(path), "utf8");
  return ProductionRecoveryPackage.parse(JSON.parse(raw) as unknown);
}

async function recoveryOutputPath(explicit: string | undefined) {
  if (explicit?.trim()) return resolve(explicit);
  const directory = await mkdtemp(join(tmpdir(), "iterate-recreate-production-"));
  return join(directory, "recovery.json");
}

function adminConnection(options: ConnectionOptions) {
  const baseUrl = options.baseUrl?.trim() || process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) throw new Error("APP_CONFIG_BASE_URL is required (or pass --base-url)");
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    auth: { type: "admin-secret" as const, secret },
  };
}
