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
  const secret = {
    __describe: vi.fn(async () => ({ created: false })),
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
  };
  return { operations, project, secret };
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
      for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/gu)) {
        const imported = `apps/kit-voice/${match[1]}`;
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

  test("pins the Grok secret, commits one source generation, then selects that mode", async () => {
    const { operations, project, secret } = projectFixture();
    const result = await installKitVoiceUserspace({
      apply: true,
      appSources: { "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}" },
      mode: "grok",
      project,
      projectId: "prj_test",
      xaiApiKey: "xai-secret",
    });

    expect(operations).toEqual(["secret", "source", "mode"]);
    expect(secret.create).toHaveBeenCalledWith({
      egress: { urls: ["https://api.x.ai"] },
      material: "xai-secret",
    });
    expect(project.kv.set).toHaveBeenCalledWith("kit-pcm-mode", "grok");
    expect(result).toMatchObject({
      applied: true,
      changedPaths: ["worker.ts", "apps/kit-voice/worker.ts"],
      commitOid: "abc123",
    });
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
