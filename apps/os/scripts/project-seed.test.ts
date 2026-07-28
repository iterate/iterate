import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { StreamEvent } from "iterate/processors";
import type { z } from "zod";
import { encryptSecretCellMaterial } from "../src/domains/secrets/crypto.ts";
import {
  check,
  foldCapturedSecretEvents,
  projectWorkerProofUrls,
  ProjectSeedArchive,
  proveProjectWorkerCommit,
  unwrapCiphertextMaterial,
} from "./project-seed.ts";
import {
  compareDependencies,
  parseGitLog,
  preflightConfigRepository,
} from "./project-seed-preflight.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ProjectSeedArchive", () => {
  test("cross-checks organization ownership and config-repo installations", () => {
    const archive = validArchive();
    archive.organizations[0]!.members[0]!.role = "member";
    const configRepo = archive.projects[0]!.configRepo!;
    if (configRepo.source !== "github") throw new Error("Expected GitHub fixture.");
    configRepo.installationId = "different-installation";

    const result = ProjectSeedArchive.safeParse(archive);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Every seeded organization needs at least one owner",
        "/repos/config installationId must match a GitHub integration in this project",
      ]),
    );
  });

  test("requires an exact captured config-repo head", () => {
    const archive = validArchive();
    const configRepo = archive.projects[0]!.configRepo!;
    if (configRepo.source !== "github") throw new Error("Expected GitHub fixture.");
    configRepo.capturedHead.commitOid = "not-a-commit";

    const result = ProjectSeedArchive.safeParse(archive);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["projects", 0, "configRepo", "capturedHead", "commitOid"],
      }),
    );
  });

  test("allows environment references in an ordinary local file", async () => {
    const file = await writeArchive(validArchive(), 0o644);

    await expect(check({ file, project: "iterate" })).resolves.toMatchObject({
      project: {
        id: "prj_iterate",
        organization: "iterate",
        slug: "iterate",
      },
      email: {
        allowedSenders: ["jonas@example.com", "*@iterate.com"],
      },
      secrets: [
        {
          material: "environment:ITERATE_OPENAI_API_KEY",
          path: "/secrets/example/openai",
        },
      ],
      targetEnvironment: "prd",
    });
  });

  test("requires private permissions for inline material and never returns its value", async () => {
    const archive = validArchive();
    const integrations = (archive.projects[0]!.integrations ??= []);
    integrations.push({
      botToken: { source: "inline", value: "xoxb-super-secret" },
      provider: "slack",
      teamId: "T_ITERATE",
    });
    const file = await writeArchive(archive, 0o644);

    await expect(check({ file, project: "iterate" })).rejects.toThrow(/chmod 600/);

    await chmod(file, 0o600);
    const plan = await check({ file, project: "iterate" });
    expect(JSON.stringify(plan)).not.toContain("xoxb-super-secret");
    expect(plan.integrations).toContainEqual(
      expect.objectContaining({
        credential: "inline (local plaintext)",
        externalId: "T_ITERATE",
        provider: "slack",
      }),
    );
  });

  test("captures offset-bound ciphertext and unwraps it only with its source binding and key", async () => {
    const encryptionKey = "stable-production-key";
    const projectId = "prj_iterate";
    const path = "/secrets/integrations/slack/iterate/bot-token";
    const offset = 7;
    const egressUrls = ["https://slack.com/api/auth.test"];
    const encrypted = await encryptSecretCellMaterial(
      JSON.stringify("xoxb-super-secret"),
      encryptionKey,
      {
        projectId,
        path,
        offset,
        egressOrigins: ["https://slack.com"],
      },
    );
    const captured = foldCapturedSecretEvents({
      projectId,
      path,
      events: [
        {
          type: "events.iterate.com/secret/created",
          path,
          offset,
          createdAt: "2026-07-28T00:00:00.000Z",
          payload: {
            config: {
              egress: { urls: egressUrls },
              encryptedMaterial: encrypted,
              refresh: null,
              visibility: "write-only",
            },
          },
        } satisfies StreamEvent,
      ],
    });

    expect(captured.material).toMatchObject({
      source: "ciphertext",
      binding: {
        projectId,
        path,
        offset,
        egressOrigins: ["https://slack.com"],
      },
    });
    await expect(unwrapCiphertextMaterial(captured.material!, encryptionKey)).resolves.toBe(
      "xoxb-super-secret",
    );
    await expect(
      unwrapCiphertextMaterial(captured.material!, "rotated-production-key"),
    ).rejects.toThrow();
  });

  test("requires private permissions for captured ciphertext and hides the envelope", async () => {
    const archive = validArchive();
    const integrations = (archive.projects[0]!.integrations ??= []);
    integrations.push({
      provider: "slack",
      connection: "iterate",
      teamId: "T_ITERATE",
      botToken: {
        source: "ciphertext",
        encrypted: {
          algorithm: "AES-GCM-SHA256+SECRET-CELL-V1",
          ciphertext: "base64-ciphertext",
          iv: "base64-iv",
        },
        binding: {
          projectId: "prj_iterate",
          path: "/secrets/integrations/slack/iterate/bot-token",
          egressOrigins: ["https://slack.com"],
          offset: 12,
        },
      },
    });
    const file = await writeArchive(archive, 0o644);

    await expect(check({ file, project: "iterate" })).rejects.toThrow(/chmod 600/);
    await chmod(file, 0o600);
    const plan = await check({ file, project: "iterate" });
    expect(JSON.stringify(plan)).not.toContain("base64-ciphertext");
    expect(plan.integrations).toContainEqual(
      expect.objectContaining({
        credential: "ciphertext:prj_iterate/secrets/integrations/slack/iterate/bot-token@12",
        provider: "slack",
      }),
    );
  });
});

describe("config-repo preflight", () => {
  test("reports commits since capture and runs checks in a disposable clone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iterate-config-preflight-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    const template = join(directory, "template");
    await Promise.all([mkdir(source), mkdir(template)]);
    await Promise.all([
      writeFile(
        join(source, "package.json"),
        JSON.stringify({
          name: "config",
          private: true,
          type: "module",
          scripts: {
            preinstall:
              'node -e "if (process.env.APP_CONFIG_ADMIN_API_SECRET || process.env.GH_TOKEN) process.exit(1)"',
            typecheck:
              'node -e "if (process.env.APP_CONFIG_ADMIN_API_SECRET || process.env.GH_TOKEN) process.exit(1)"',
          },
        }),
      ),
      writeFile(join(source, "worker.ts"), "export default class ProjectWorker {};\n"),
      writeFile(
        join(template, "package.json"),
        JSON.stringify({ name: "template", private: true, type: "module" }),
      ),
      writeFile(join(template, "worker.ts"), "export default class ProjectWorker {};\n"),
    ]);
    runGit(source, ["init", "--initial-branch=main"]);
    runGit(source, ["config", "user.email", "test@example.com"]);
    runGit(source, ["config", "user.name", "Test"]);
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", "working config"]);
    const capturedCommitOid = runGit(source, ["rev-parse", "HEAD"]);
    await writeFile(join(source, "README.md"), "new config\n");
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", "new config change"]);

    const previousAdminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET;
    const previousGithubToken = process.env.GH_TOKEN;
    process.env.APP_CONFIG_ADMIN_API_SECRET = "must-not-reach-repository-scripts";
    process.env.GH_TOKEN = "must-not-reach-repository-scripts";
    let result: Awaited<ReturnType<typeof preflightConfigRepository>>;
    try {
      result = await preflightConfigRepository(
        {
          config: {
            source: "github",
            installationId: "1234",
            capturedHead: { branch: "main", commitOid: capturedCommitOid },
            owner: "iterate",
            repo: "config",
          },
          templateDirectory: template,
        },
        {
          cloneRepository: ({ destination }) => {
            runGit(directory, ["clone", "--no-local", source, destination]);
          },
        },
      );
    } finally {
      if (previousAdminSecret === undefined) {
        delete process.env.APP_CONFIG_ADMIN_API_SECRET;
      } else {
        process.env.APP_CONFIG_ADMIN_API_SECRET = previousAdminSecret;
      }
      if (previousGithubToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previousGithubToken;
      }
    }

    expect(result).toMatchObject({
      ready: true,
      captured: {
        relation: "current-descends-from-capture",
        totalCommitsSinceCapture: 1,
        commitsSinceCapture: [{ subject: "new config change" }],
      },
      checks: [
        { command: expect.stringContaining("pnpm install"), status: "passed" },
        { command: expect.stringContaining("typecheck"), status: "passed" },
        { command: expect.stringContaining("test"), status: "skipped" },
      ],
      template: {
        classification: "informational-not-a-merge-plan",
        worker: "same",
      },
    });
  });

  test("parses git records and treats template dependency drift as informational data", () => {
    expect(
      parseGitLog(
        "a".repeat(40) +
          "\0" +
          "2026-07-28T10:45:09+00:00\0Add task (#1)\0" +
          "b".repeat(40) +
          "\0" +
          "2026-07-27T10:45:09+00:00\0Package app (#2)\0",
      ),
    ).toHaveLength(2);
    expect(
      compareDependencies(
        {
          dependencies: {
            iterate: "@main",
            "@iterate-com/tasks": "@main",
          },
        },
        { dependencies: { iterate: "@main", react: "19" } },
      ),
    ).toEqual({
      additional: ["@iterate-com/tasks"],
      different: [],
      missing: ["react"],
    });
  });
});

describe("served config-repo proof", () => {
  test("derives the canonical and direct-hostname worker routes", () => {
    expect(
      projectWorkerProofUrls({
        appBaseUrl: "https://os.iterate.com",
        customHostnames: ["iterate.com", "guestbook.iterate.com"],
        projectHostnameBases: ["*.iterate.app"],
        projectSlug: "iterate",
      }),
    ).toEqual([
      "https://iterate.iterate.app",
      "https://iterate.com",
      "https://guestbook.iterate.com",
    ]);
  });

  test("waits until every route serves the exact reset commit", async () => {
    const expectedCommitOid = "b".repeat(40);
    const requests = new Map<string, number>();
    const fetchWorker = (async (input: string | URL | Request) => {
      const url = input.toString();
      const attempt = (requests.get(url) ?? 0) + 1;
      requests.set(url, attempt);
      const canonicalStillBuilding = url.includes("iterate.iterate.app") && attempt === 1;
      return new Response("", {
        status: canonicalStillBuilding ? 503 : 200,
        headers: canonicalStillBuilding
          ? {
              "x-iterate-worker-building": "1",
            }
          : {
              "x-iterate-worker-serve": expectedCommitOid,
            },
      });
    }) as typeof globalThis.fetch;

    const result = await proveProjectWorkerCommit(
      {
        expectedCommitOid,
        retryIntervalMs: 1,
        timeoutMs: 1_000,
        urls: ["https://iterate.iterate.app", "https://iterate.com"],
      },
      {
        fetch: fetchWorker,
        sleep: async () => {},
      },
    );

    expect(result).toMatchObject([
      {
        attempts: 2,
        commitOid: expectedCommitOid,
        status: 200,
        url: "https://iterate.iterate.app/",
      },
      {
        attempts: 1,
        commitOid: expectedCommitOid,
        status: 200,
        url: "https://iterate.com/",
      },
    ]);
  });

  test("does not hide a platform serve error behind retries", async () => {
    const expectedCommitOid = "b".repeat(40);
    const fetchWorker = (async () => {
      return new Response("", {
        status: 500,
        headers: {
          "cf-ray": "proof-ray",
          "x-iterate-worker-serve-error": "1",
        },
      });
    }) as typeof globalThis.fetch;

    await expect(
      proveProjectWorkerCommit(
        {
          expectedCommitOid,
          timeoutMs: 1_000,
          urls: ["https://iterate.com"],
        },
        {
          fetch: fetchWorker,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/expected healthy.*cfRay.*proof-ray.*serveError.*1/);
  });
});

function validArchive(): z.input<typeof ProjectSeedArchive> {
  return {
    version: 1 as const,
    targetEnvironment: "prd",
    users: [
      {
        email: "jonas@example.com",
        name: "Jonas",
        platformAdmin: true,
      },
    ],
    organizations: [
      {
        slug: "iterate",
        name: "Iterate",
        members: [
          {
            email: "jonas@example.com",
            role: "owner" as const,
          },
        ],
      },
    ],
    projects: [
      {
        id: "prj_iterate",
        slug: "iterate",
        organization: "iterate",
        directHostnames: ["iterate.com"],
        email: {
          allowedSenders: [" Jonas@Example.COM ", "*@Iterate.COM"],
        },
        secrets: [
          {
            path: "/secrets/example/openai",
            egressUrls: ["https://api.openai.com"],
            material: {
              source: "env" as const,
              name: "ITERATE_OPENAI_API_KEY",
            },
          },
        ],
        integrations: [
          {
            provider: "github" as const,
            installationId: "1234",
          },
        ],
        configRepo: {
          source: "github" as const,
          installationId: "1234",
          owner: "iterate",
          repo: "iterate-config",
          capturedHead: {
            branch: "main" as const,
            commitOid: "a".repeat(40),
          },
        },
      },
    ],
  };
}

async function writeArchive(archive: z.input<typeof ProjectSeedArchive>, mode: number) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-project-seed-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "projects.yaml");
  await writeFile(file, stringifyYaml(archive), { mode });
  await chmod(file, mode);
  return file;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
