import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectWorkerBuildKey, workerBuildKey, type WorkerBuildInput } from "./build-key.ts";
import { PNPM_VERSION, WRANGLER_VERSION } from "./build-recipe.ts";

const baseInput: WorkerBuildInput = {
  compatibilityDate: "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],
  options: { entryPoint: "worker.ts" },
  source: {
    commitOid: "a".repeat(40),
    exclude: [".git/**", "node_modules/**"],
    include: ["worker.ts", "package.json"],
    repoPath: "/",
    type: "repo",
  },
};

describe("workerBuildKey", () => {
  it("is deterministic and mask-order-insensitive", async () => {
    const key = await workerBuildKey(baseInput);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(await workerBuildKey(baseInput)).toBe(key);
    expect(
      await workerBuildKey({
        ...baseInput,
        source: {
          ...baseInput.source,
          type: "repo",
          exclude: ["node_modules/**", ".git/**"],
          include: ["package.json", "worker.ts"],
        } as WorkerBuildInput["source"],
      }),
    ).toBe(key);
  });

  it("changes when any build-relevant input changes", async () => {
    const key = await workerBuildKey(baseInput);
    const variants: WorkerBuildInput[] = [
      { ...baseInput, compatibilityDate: "2026-06-01" },
      { ...baseInput, compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"] },
      { ...baseInput, options: { entryPoint: "worker.ts", minify: true } },
      {
        ...baseInput,
        source: { commitOid: "b".repeat(40), repoPath: "/", type: "repo" },
      },
      {
        ...baseInput,
        source: { files: { "worker.js": "export default {};" }, type: "inline" },
      },
    ];
    for (const variant of variants) {
      expect(await workerBuildKey(variant)).not.toBe(key);
    }
  });

  it("keys repo sources by content identity when the repo provides one", async () => {
    const withContent = (commitOid: string, contentHash: string): WorkerBuildInput => ({
      ...baseInput,
      source: { commitOid, contentHash, repoPath: "/", type: "repo" },
    });
    // Same content under different commits (e.g. two freshly seeded project
    // repos) must converge on one artifact...
    expect(await workerBuildKey(withContent("a".repeat(40), "content-1"))).toBe(
      await workerBuildKey(withContent("b".repeat(40), "content-1")),
    );
    // ...while different content never shares a key.
    expect(await workerBuildKey(withContent("a".repeat(40), "content-1"))).not.toBe(
      await workerBuildKey(withContent("a".repeat(40), "content-2")),
    );
  });

  it("hashes inline file contents into the key", async () => {
    const inline = (content: string): WorkerBuildInput => ({
      ...baseInput,
      source: { files: { "worker.js": content }, type: "inline" },
    });
    expect(await workerBuildKey(inline("export default 1;"))).not.toBe(
      await workerBuildKey(inline("export default 2;")),
    );
  });

  it("scopes the project tier by project without losing determinism", async () => {
    const sharedKey = await workerBuildKey(baseInput);
    const projectKey = await projectWorkerBuildKey("prj_one", sharedKey);
    expect(projectKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await projectWorkerBuildKey("prj_one", sharedKey)).toBe(projectKey);
    // Runtime builds consume project-controlled source (and potentially
    // mutable lockless registry state), so their artifacts never cross
    // project trust boundaries.
    expect(await projectWorkerBuildKey("prj_two", sharedKey)).not.toBe(projectKey);
    expect(projectKey).not.toBe(sharedKey);
  });

  it("pins the build toolchain constants to the repo's own package-manager pins", () => {
    // The toolchain version participates in every build key; the constant and
    // the workspace override backing apps/os's wrangler devDependency (what
    // the host/dev runner and the deploy seeder execute) must agree or two
    // runners build different bytes under one key. The container adapter
    // imports these same constants; nub's internal pin has no workspace
    // counterpart and is carried directly in BUILD_TOOLCHAIN_VERSION.
    const workspaceYaml = readFileSync(
      new URL("../../../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    expect(workspaceYaml).toMatch(new RegExp(`^  wrangler: ${WRANGLER_VERSION}$`, "m"));
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"),
    ) as { packageManager?: string };
    expect(rootPackage.packageManager).toBe(`pnpm@${PNPM_VERSION}`);
  });
});
