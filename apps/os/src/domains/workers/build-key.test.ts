import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workerBuildKey, type WorkerBuildInput } from "./build-key.ts";
import { WORKER_BUNDLER_ADAPTER_VERSION, WORKER_BUNDLER_VERSION } from "./build-backend.ts";

const buildSource = (entryPoint: string): WorkerBuildInput["source"] => ({
  createWorker: {
    entryPoint,
    files: { files: {}, type: "inline" },
  },
});

const baseInput: WorkerBuildInput = {
  compatibilityDate: "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],
  files: {
    commitOid: "a".repeat(40),
    exclude: [".git/**", "node_modules/**"],
    include: ["worker.ts", "package.json"],
    repoPath: "/",
    type: "repo",
  },
  source: buildSource("worker.ts"),
};

describe("workerBuildKey", () => {
  it("is deterministic and mask-order-insensitive", async () => {
    const key = await workerBuildKey(baseInput);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(await workerBuildKey(baseInput)).toBe(key);
    expect(
      await workerBuildKey({
        ...baseInput,
        files: {
          ...baseInput.files,
          type: "repo",
          exclude: ["node_modules/**", ".git/**"],
          include: ["package.json", "worker.ts"],
        } as WorkerBuildInput["files"],
      }),
    ).toBe(key);
  });

  it("changes when any build-relevant input changes", async () => {
    const key = await workerBuildKey(baseInput);
    const variants: WorkerBuildInput[] = [
      { ...baseInput, compatibilityDate: "2026-06-01" },
      { ...baseInput, compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"] },
      { ...baseInput, source: buildSource("different.ts") },
      {
        ...baseInput,
        source: {
          createWorker: {
            entryPoint: "worker.ts",
            files: { files: {}, type: "inline" },
            virtualModules: { "iterate/sdk": "user override" },
          },
        },
      },
      {
        ...baseInput,
        files: { commitOid: "b".repeat(40), repoPath: "/", type: "repo" },
      },
      {
        ...baseInput,
        files: { files: { "worker.js": "export default {};" }, type: "inline" },
      },
    ];
    for (const variant of variants) {
      expect(await workerBuildKey(variant)).not.toBe(key);
    }
  });

  it("keys repo sources by content identity when the repo provides one", async () => {
    const withContent = (
      commitOid: string,
      contentHash: string,
      repoPath = "/",
    ): WorkerBuildInput => ({
      ...baseInput,
      files: { commitOid, contentHash, repoPath, type: "repo" },
    });
    // Same source and build options converge on one cached build request even
    // when equivalent content appears under different commits.
    expect(await workerBuildKey(withContent("a".repeat(40), "content-1"))).toBe(
      await workerBuildKey(withContent("b".repeat(40), "content-1")),
    );
    expect(await workerBuildKey(withContent("a".repeat(40), "content-1", "/repos/one"))).toBe(
      await workerBuildKey(withContent("b".repeat(40), "content-1", "/repos/two")),
    );
    // ...while different content never shares a key.
    expect(await workerBuildKey(withContent("a".repeat(40), "content-1"))).not.toBe(
      await workerBuildKey(withContent("a".repeat(40), "content-2")),
    );
  });

  it("hashes inline file contents into the key", async () => {
    const inline = (content: string): WorkerBuildInput => ({
      ...baseInput,
      files: { files: { "worker.js": content }, type: "inline" },
    });
    expect(await workerBuildKey(inline("export default 1;"))).not.toBe(
      await workerBuildKey(inline("export default 2;")),
    );
  });

  it("pins both compiler versions used by the build key", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies["@cloudflare/worker-bundler"]).toBe(WORKER_BUNDLER_VERSION);
    expect(WORKER_BUNDLER_ADAPTER_VERSION).toBe(1);
  });
});
