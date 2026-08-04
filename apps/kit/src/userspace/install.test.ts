import { posix } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  formatInstallerResult,
  parseInstallerCliOptions,
  readRuntimeSources,
  writeInstallerResultAndExit,
} from "../../scripts/install-userspace-worker.ts";
import { kitVoiceRootWorkerSource } from "./install-plan.ts";
import { installKitVoiceUserspace } from "./install.ts";

function projectFixture() {
  const operations: string[] = [];
  const worker = {
    kill: vi.fn(async () => {
      operations.push("restart");
      throw new Error("kill requested");
    }),
  };
  const secret = {
    __describe: vi.fn(async () => ({ created: false, hasMaterial: false })),
    create: vi.fn(async () => {
      operations.push("secret");
      return secret;
    }),
    update: vi.fn(),
  };
  const project = {
    kv: {
      set: vi.fn(async () => {
        operations.push("mode");
      }),
    },
    projectId: "prj_test",
    repo: {
      commitFiles: vi.fn(async () => {
        operations.push("source");
        return {
          branch: "main",
          changedPaths: ["worker.ts", "apps/kit-voice/worker.ts"],
          commitOid: "abc123",
          noChanges: false,
        };
      }),
      readFile: vi.fn(async ({ path }: { path: string }) =>
        path === "worker.ts"
          ? {
              commitOid: "old",
              content: "export default class ExistingWorker {}",
              path,
            }
          : null,
      ),
    },
    secrets: { get: vi.fn(() => secret) },
    workers: { get: vi.fn(() => worker) },
  };
  return { operations, project, secret, worker };
}

describe("kit voice userspace install", () => {
  test("ships the transitive relative imports needed by the deployed worker", async () => {
    const sources = await readRuntimeSources();

    /*
     * The production installer uploads an explicit allow-list, not the source
     * directory. A local test/build can therefore be green while a newly
     * committed worker fails its first cold start with `No such module`. Walk
     * each selected module's same-directory imports so adding one dependency
     * cannot silently create that production-only failure again.
     */
    for (const [importer, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/gu)) {
        const imported = posix.normalize(posix.join(posix.dirname(importer), match[1]!));
        /*
         * kitVoiceWorkerRef deliberately snapshots only apps/kit-voice/**.
         * Merely committing an imported file elsewhere in the config repo is
         * therefore insufficient: the repository mutation succeeds, but the
         * production builder cannot see that file and cold-start fails. Keep
         * every relative dependency inside the same deployable app boundary.
         */
        expect(
          imported.startsWith("apps/kit-voice/"),
          `${importer} imports ${imported} outside the worker source mask`,
        ).toBe(true);
        expect(sources, `${importer} imports omitted runtime module ${imported}`).toHaveProperty(
          imported,
        );
      }
    }
  });

  test("dry-run reports the complete preservation plan without mutating the project", async () => {
    const { operations, project, secret } = projectFixture();
    const result = await installKitVoiceUserspace({
      apply: false,
      appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
      mode: "grok",
      project,
      projectId: "prj_test",
    });

    expect(result).toMatchObject({
      applied: false,
      changedPaths: expect.arrayContaining([
        "apps/kit-voice/worker.ts",
        "worker.base.ts",
        "worker.ts",
      ]),
      mode: "grok",
      projectId: "prj_test",
    });
    expect(result.plan.repoChanges).toContainEqual({
      content: kitVoiceRootWorkerSource(),
      path: "worker.ts",
    });
    expect(operations).toEqual([]);
    expect(secret.__describe).not.toHaveBeenCalled();
  });

  test("pins secret and source before selecting the mode, then boots that exact generation", async () => {
    /*
     * A physical install proved that committing source does not evict an
     * already-running stateful worker: pcmMetrics() continued exposing the
     * previous eight-second response reservoir after the new source commit.
     * The installer must therefore use the platform worker lifecycle only
     * after every dependency is durable. Otherwise the following proof can
     * unknowingly exercise stale code, or boot midway through installation.
     */
    const { operations, project, secret, worker } = projectFixture();
    const result = await installKitVoiceUserspace({
      apply: true,
      appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
      mode: "grok",
      project,
      projectId: "prj_test",
      xaiApiKey: "xai-secret",
    });

    expect(operations).toEqual(["secret", "source", "mode", "restart"]);
    expect(secret.create).toHaveBeenCalledWith({
      egress: { urls: ["https://api.x.ai"] },
      material: "xai-secret",
    });
    expect(project.kv.set).toHaveBeenCalledWith("kit-pcm-mode", "grok");
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      applied: true,
      changedPaths: ["worker.ts", "apps/kit-voice/worker.ts"],
      commitOid: "abc123",
    });
  });

  test("reuses an already-populated Grok secret for source-only upgrades", async () => {
    /*
     * Production credentials are deliberately write-only. Requiring operators
     * to replace that credential merely to install a code or VAD-policy change
     * makes safe iteration depend on recovering plaintext that the platform is
     * designed never to reveal. Existing material is already pinned to xAI;
     * preserving it is both the least-privilege and the atomic upgrade path.
     */
    const { operations, project, secret } = projectFixture();
    secret.__describe.mockResolvedValueOnce({ created: true, hasMaterial: true });

    await installKitVoiceUserspace({
      apply: true,
      appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
      mode: "grok",
      project,
      projectId: "prj_test",
    });

    expect(operations).toEqual(["source", "mode", "restart"]);
    expect(secret.create).not.toHaveBeenCalled();
    expect(secret.update).not.toHaveBeenCalled();
  });

  test("refuses Grok mode before source mutation when neither a key nor stored material exists", async () => {
    const { operations, project } = projectFixture();

    await expect(
      installKitVoiceUserspace({
        apply: true,
        appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
        mode: "grok",
        project,
        projectId: "prj_test",
      }),
    ).rejects.toThrow("XAI_API_KEY is required when no populated Grok secret exists");
    expect(operations).toEqual([]);
  });

  test("does not mistake an unexplained worker restart failure for a completed install", async () => {
    const { project, worker } = projectFixture();
    worker.kill.mockRejectedValueOnce(new Error("worker reset permission denied"));

    await expect(
      installKitVoiceUserspace({
        apply: true,
        appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
        mode: "tone",
        project,
        projectId: "prj_test",
      }),
    ).rejects.toThrow("worker reset permission denied");
  });

  test("prints a concise default result and exposes generated source only with --plan", () => {
    const generatedSource = "export class GeneratedWorker {}";
    const result = {
      applied: true,
      changedPaths: ["apps/kit-voice/worker.ts", "worker.ts"],
      commitOid: "abc123",
      mode: "tone" as const,
      plan: {
        mode: "tone" as const,
        repoChanges: [{ content: generatedSource, path: "apps/kit-voice/worker.ts" }],
        requiresGrokSecret: false,
        secretPath: "/secrets/kit/xai-api-key",
      },
      projectId: "prj_test",
    };

    const summary = formatInstallerResult(result, false);
    expect(summary).not.toContain(generatedSource);
    expect(JSON.parse(summary)).toEqual({
      applied: true,
      changedPathCount: 2,
      changedPaths: ["apps/kit-voice/worker.ts", "worker.ts"],
      commitOid: "abc123",
      mode: "tone",
      projectId: "prj_test",
      requiresGrokSecret: false,
      secretPath: "/secrets/kit/xai-api-key",
    });
    expect(formatInstallerResult(result, true)).toContain(generatedSource);

    expect(
      parseInstallerCliOptions(["--plan"], {
        ITERATE_KIT_PROJECT_API_KEY: "itxk_test",
        ITERATE_KIT_PROJECT_ID: "prj_test",
      }),
    ).toMatchObject({ printPlan: true });

    const sourceOnlyUpgrade = parseInstallerCliOptions(["--apply", "--mode", "grok"], {
      ITERATE_KIT_PROJECT_API_KEY: "itxk_test",
      ITERATE_KIT_PROJECT_ID: "prj_test",
    });
    expect(sourceOnlyUpgrade).toMatchObject({ apply: true, mode: "grok" });
    expect(sourceOnlyUpgrade).not.toHaveProperty("xaiApiKey");
  });

  test("forces a successful CLI exit only after its concise output has flushed", () => {
    const order: string[] = [];
    writeInstallerResultAndExit(
      {
        applied: false,
        changedPaths: ["worker.ts"],
        mode: "tone",
        plan: {
          mode: "tone",
          repoChanges: [{ content: "generated source must stay hidden", path: "worker.ts" }],
          requiresGrokSecret: false,
          secretPath: "/secrets/kit/xai-api-key",
        },
        projectId: "prj_test",
      },
      {
        exit: (code) => {
          order.push(`exit:${code}`);
        },
        includePlan: false,
        write: (output, flushed) => {
          order.push("write");
          expect(output).not.toContain("generated source must stay hidden");
          flushed();
          order.push("flushed");
        },
      },
    );

    expect(order).toEqual(["write", "exit:0", "flushed"]);
  });
});
