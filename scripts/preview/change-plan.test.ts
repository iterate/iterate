import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { CommitHistory } from "./commit-history.ts";
import { classifyChanges, planPreview } from "./change-plan.ts";
import CHANGE_TYPES from "./change-types.ts";

test("a docs commit inherits its failed product parent's result", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  const product = repo.commit({ "apps/os/index.ts": "broken" });
  repo.commit({ "README.md": "docs" });
  const plan = await planPreview(repo.history(), {
    findPreviewResult: async (commit) =>
      commit === product
        ? { commit, conclusion: "failure", url: "https://depot.dev/failed-preview" }
        : null,
    findPreviewDeployment: async () => {
      throw new Error("No deployment lookup for inherited results");
    },
  });
  expect(plan).toMatchObject({
    action: "inherit",
    result: { commit: product, conclusion: "failure" },
  });
});

test("Docs is an explicit allowlist; shipped markdown remains product work", () => {
  expect(
    classifyChanges([
      "README.md",
      "packages/iterate/README.md",
      "apps/mobile/README.md",
      "docs/ci.md",
      "tasks/work.md",
      "explainers/ci/index.html",
      "apps/os/prompts/agent.md",
      "configs/template/README.md",
      "specs/readme.md",
      "scripts/ci/status.test.ts",
      "apps/os/widget.test.tsx",
      "pnpm-lock.yaml",
      ".npmrc",
    ]),
  ).toEqual({
    Docs: [
      "README.md",
      "packages/iterate/README.md",
      "apps/mobile/README.md",
      "docs/ci.md",
      "tasks/work.md",
      "explainers/ci/index.html",
    ],
    Product: ["apps/os/prompts/agent.md"],
    Default: ["configs/template/README.md", ".npmrc"],
    Tests: ["specs/readme.md", "apps/os/widget.test.tsx"],
    CI: ["scripts/ci/status.test.ts"],
    Generated: ["pnpm-lock.yaml"],
  });
});

test("os-next owns every path inside it, whatever else that path looks like", () => {
  expect(
    classifyChanges([
      "apps/os-next/scripts/x.ts",
      "apps/os-next/foo.tsx",
      "apps/os-next/e2e/x.e2e.test.ts",
      "apps/os-next/src/components/thing.tsx",
      "apps/os-next/README.md",
      "apps/os-next/src/routes.generated.ts",
      ".depot/workflows/deploy-os-next.yml",
      ".depot/workflows/deploy-notes.yml",
      ".depot/workflows/preview-os-next.yml",
      "apps/dash/src/routes/_auth/home.tsx",
      "apps/agents/__workers-tests__/agent-revive.test.ts",
      "apps/notes/README.md",
      "apps/voice/scripts/deploy.ts",
      "configs-next/with-agents/agents.js",
      "packages/iterate/src/next/api.ts",
      "packages/iterate/src/next-node.ts",
      "apps/os/index.ts",
      ".depot/workflows/preview.yml",
      "envs.ts",
      "packages/shared/src/index.ts",
      "packages/iterate/src/sdk.ts",
      "packages/iterate/src/cli.ts",
      "packages/ui/src/components/button.tsx",
      "configs/default/worker.ts",
      "pnpm-lock.yaml",
      "scripts/lib/thing.ts",
    ]),
  ).toEqual({
    OsNext: [
      "apps/os-next/scripts/x.ts",
      "apps/os-next/foo.tsx",
      "apps/os-next/e2e/x.e2e.test.ts",
      "apps/os-next/src/components/thing.tsx",
      "apps/os-next/README.md",
      "apps/os-next/src/routes.generated.ts",
      ".depot/workflows/deploy-os-next.yml",
      ".depot/workflows/deploy-notes.yml",
      ".depot/workflows/preview-os-next.yml",
      // The apps on top of os-next and its half of packages/iterate: no fleet app imports them.
      "apps/dash/src/routes/_auth/home.tsx",
      "apps/agents/__workers-tests__/agent-revive.test.ts",
      "apps/notes/README.md",
      "apps/voice/scripts/deploy.ts",
      "configs-next/with-agents/agents.js",
      "packages/iterate/src/next/api.ts",
      "packages/iterate/src/next-node.ts",
    ],
    Product: ["apps/os/index.ts"],
    CI: [".depot/workflows/preview.yml"],
    // apps/os depends on these, so they keep deploying and testing the fleet.
    Default: [
      "envs.ts",
      "packages/shared/src/index.ts",
      "packages/iterate/src/sdk.ts",
      "packages/iterate/src/cli.ts",
      "configs/default/worker.ts",
    ],
    Frontend: ["packages/ui/src/components/button.tsx"],
    Generated: ["pnpm-lock.yaml"],
    Scripts: ["scripts/lib/thing.ts"],
  });
});

test("every path the planner skips as os-next is one the os-next preview runs for", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../../.depot/workflows/preview-os-next.yml", import.meta.url), "utf8"),
  );
  const previewed: string[] = workflow.on.pull_request.paths;
  const skipped = CHANGE_TYPES.OsNext.map((glob) => glob.replace("**/*", "any/file.ts"));
  expect(skipped.filter((path) => !previewed.some((glob) => matchesGlob(path, glob)))).toEqual([]);
});

test.each([
  ["apps/os-next/src/runtime.ts"],
  ["apps/os-next/e2e/boot.e2e.test.ts"],
  [".depot/workflows/preview-os-next.yml"],
])("an os-next-only head at %s skips the apps/os preview entirely", async (path) => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os-next/src/boot.ts": "os-next work" });
  repo.commit({ [path]: "more os-next work" });
  const plan = await planPreview(repo.history(), {
    findPreviewResult: async () => {
      throw new Error("A skipped preview consults no ancestor result");
    },
    findPreviewDeployment: async () => {
      throw new Error("A skipped preview consults no deployment");
    },
  });
  expect(plan).toMatchObject({ action: "skip", changes: { OsNext: [path] } });
});

test("an os-next branch skips even when the merge-base has no result of its own", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "untested main product" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os-next/src/boot.ts": "os-next work" });
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "skip" });
});

test("a #2828-shaped branch (os-next, dash, agents, its preview workflow) skips the fleet", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  repo.commit({
    "apps/os-next/src/control-plane/durable-object.ts": "control plane",
    "apps/os-next/e2e/session.e2e.test.ts": "e2e",
    "apps/os-next/README.md": "docs",
    "apps/dash/src/lib/projects.ts": "dash",
    "apps/dash/src/components/dash-nav.tsx": "dash component",
    "apps/agents/__workers-tests__/agent-revive.test.ts": "agents test",
    ".depot/workflows/preview-os-next.yml": "workflow",
  });
  repo.commit({ "packages/iterate/src/next/api.ts": "next sdk" });
  const plan = await planPreview(repo.history(), {
    findPreviewResult: async () => {
      throw new Error("A skipped preview consults no ancestor result");
    },
    findPreviewDeployment: async () => {
      throw new Error("A skipped preview consults no deployment");
    },
  });
  expect(plan).toMatchObject({ action: "skip" });
});

test.each([
  ["apps/os/index.ts"],
  ["packages/shared/src/index.ts"],
  ["packages/ui/src/components/button.tsx"],
  ["packages/iterate/src/sdk.ts"],
  ["envs.ts"],
  ["pnpm-lock.yaml"],
])("os-next mixed with %s still deploys the fleet", async (path) => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os-next/src/boot.ts": "os-next work" });
  const head = repo.commit({
    [path]: "shared change",
    "apps/os-next/src/more.ts": "and os-next",
  });
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining(head) });
});

test("an os-next branch carrying an untested apps/os commit deploys, revert or not", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "untested product change" });
  repo.commit({ "apps/os-next/src/boot.ts": "os-next work" });
  const evidence = {
    findPreviewResult: async () => null,
    findPreviewDeployment: async () => null,
  };
  expect(await planPreview(repo.history(), evidence)).toMatchObject({ action: "deploy" });
  // Reverting apps/os leaves main's tree in place, so the branch is os-next again.
  repo.commit({ "apps/os/index.ts": "main" });
  expect(await planPreview(repo.history(), evidence)).toMatchObject({ action: "skip" });
});

test("docs alongside os-next keep their existing inherit-or-deploy treatment", async () => {
  using repo = repository();
  const main = repo.commit({ "apps/os/index.ts": "main product" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os-next/src/boot.ts": "os-next work" });
  repo.commit({ "docs/os-next.md": "docs" });
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async (commit) =>
        commit === main
          ? { commit, conclusion: "success" as const, url: "https://depot.dev/main-preview" }
          : null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "inherit", result: { commit: main } });
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining(main) });
});

test.each(["success", "failure"] as const)(
  "docs inherit %s across more docs through the merge-base",
  async (conclusion) => {
    using repo = repository();
    const base = repo.commit({ "apps/os/index.ts": "main" });
    repo.git("switch", "-c", "feature");
    repo.commit({ "README.md": "first doc" });
    repo.commit({ "docs/testing.md": "second doc" });
    const lookedUp: string[] = [];
    const plan = await planPreview(repo.history(), {
      findPreviewResult: async (commit) => {
        lookedUp.push(commit);
        return commit === base
          ? { commit, conclusion, url: "https://depot.dev/main-preview" }
          : null;
      },
      findPreviewDeployment: async () => {
        throw new Error("No deployment lookup");
      },
    });
    expect(plan).toMatchObject({ action: "inherit", result: { commit: base, conclusion } });
    expect(lookedUp.at(-1)).toBe(base);
  },
);

test.each(["apps/os/index.ts", "specs/new.spec.ts"])(
  "docs cannot hide an untested change to %s behind an older green",
  async (path) => {
    using repo = repository();
    const base = repo.commit({ "apps/os/index.ts": "main" });
    repo.git("switch", "-c", "feature");
    const untested = repo.commit({ [path]: "untested" });
    repo.commit({ "README.md": "docs" });
    const resultLookups: string[] = [];
    const plan = await planPreview(repo.history(), {
      findPreviewResult: async (commit) => {
        resultLookups.push(commit);
        return commit === base
          ? { commit, conclusion: "success", url: "https://depot.dev/main-preview" }
          : null;
      },
      findPreviewDeployment: async (commit) =>
        commit === base ? { commit, slot: "preview-3" } : null,
    });
    expect(resultLookups).not.toContain(base);
    expect(resultLookups.at(-1)).toBe(untested);
    expect(plan.action).toBe(path.startsWith("specs/") ? "reuse" : "deploy");
  },
);

test("tests reuse the nearest live deployment before inspecting that commit's product changes", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  const product = repo.commit({ "apps/os/index.ts": "deployed" });
  const docs = repo.commit({ "README.md": "docs" });
  const head = repo.commit({ "specs/new.spec.ts": "head test code" });
  const lookedUp: string[] = [];
  const plan = await planPreview(repo.history(), {
    findPreviewResult: async () => {
      throw new Error("New tests cannot inherit old outcomes");
    },
    findPreviewDeployment: async (commit) => {
      lookedUp.push(commit);
      return commit === product ? { commit, slot: "preview-2" } : null;
    },
  });
  expect(plan).toMatchObject({
    action: "reuse",
    deployment: { commit: product, slot: "preview-2" },
  });
  expect(lookedUp).toEqual([head, docs, product]);
});

test("untested ancestor tests can reuse a newer docs commit's deployment", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "specs/new.spec.ts": "untested tests" });
  const head = repo.commit({ "README.md": "docs" });

  const plan = await planPreview(repo.history(), {
    findPreviewResult: async (commit) =>
      commit === head
        ? { commit, conclusion: "success", url: "https://depot.dev/previous-head-preview" }
        : null,
    findPreviewDeployment: async (commit) =>
      commit === head ? { commit, slot: "preview-2" } : null,
  });

  expect(plan).toMatchObject({
    action: "reuse",
    changes: { Docs: ["README.md"] },
    deployment: { commit: head, slot: "preview-2" },
  });
});

test("tests stop at an undeployed product commit rather than use an older backend", async () => {
  using repo = repository();
  const main = repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  const product = repo.commit({ "apps/os/index.ts": "not deployed" });
  repo.commit({ "specs/new.spec.ts": "head test code" });
  const lookedUp: string[] = [];
  const plan = await planPreview(repo.history(), {
    findPreviewResult: async () => null,
    findPreviewDeployment: async (commit) => {
      lookedUp.push(commit);
      return commit === main ? { commit, slot: "preview-2" } : null;
    },
  });
  expect(plan).toMatchObject({ action: "deploy", reason: expect.stringContaining(product) });
  expect(lookedUp).not.toContain(main);
});

test("new tests cannot inherit an older green when no deployment remains usable", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  const main = repo.commit({ "README.md": "tested documentation change" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "specs/new.spec.ts": "new tests" });

  const plan = await planPreview(repo.history(), {
    findPreviewResult: async (commit) =>
      commit === main
        ? { commit, conclusion: "success", url: "https://depot.dev/older-green-preview" }
        : null,
    findPreviewDeployment: async () => null,
  });

  expect(plan).toMatchObject({ action: "deploy" });
});

test.each([true, false])(
  "the merge-base is the last deployment candidate (available=%s)",
  async (available) => {
    using repo = repository();
    repo.commit({ "README.md": "older" });
    const main = repo.commit({ "README.md": "main" });
    repo.git("switch", "-c", "feature");
    const head = repo.commit({ "specs/new.spec.ts": "test" });
    const lookedUp: string[] = [];
    const plan = await planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async (commit) => {
        lookedUp.push(commit);
        return available && commit === main ? { commit, slot: "preview-2" } : null;
      },
    });
    expect(plan.action).toBe(available ? "reuse" : "deploy");
    expect(lookedUp).toEqual([head, main]);
  },
);

test("an empty head inherits, while a product-to-doc rename still deploys", async () => {
  using repo = repository();
  const main = repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  repo.commit({});
  const evidence = {
    findPreviewResult: async (commit: string) =>
      commit === main
        ? { commit, conclusion: "failure" as const, url: "https://depot.dev/failed-preview" }
        : null,
    findPreviewDeployment: async () => null,
  };
  expect(await planPreview(repo.history(), evidence)).toMatchObject({
    action: "inherit",
    result: { conclusion: "failure" },
  });
  repo.git("mv", "apps/os/index.ts", "README.md");
  repo.commit({});
  expect(await planPreview(repo.history(), evidence)).toMatchObject({
    action: "deploy",
    changes: { Product: ["apps/os/index.ts"], Docs: ["README.md"] },
  });
});

test("a side-branch merge-base cannot substitute main for unmerged feature code", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "feature product" });
  repo.git("switch", "main");
  const main = repo.commit({ "docs/main.md": "main documentation" });
  repo.git("switch", "feature");
  repo.git("merge", "--no-ff", "main", "-m", "merge main");
  const merge = repo.git("rev-parse", "HEAD");
  const head = repo.commit({ "specs/new.spec.ts": "test" });
  const lookedUp: string[] = [];
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async (commit) => {
        lookedUp.push(commit);
        return commit === main ? { commit, slot: "preview-1" } : null;
      },
    }),
  ).toMatchObject({ action: "deploy" });
  expect(lookedUp).toEqual([head, merge]);
});

test("lookup errors are not missing deployments", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "specs/new.spec.ts": "test" });
  await expect(
    planPreview(repo.history(), {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => {
        throw new Error("Inventory unavailable");
      },
    }),
  ).rejects.toThrow("Inventory unavailable");
});

test("docs inherit a tested merge even when main is its second parent", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "feature product" });
  repo.git("switch", "main");
  repo.commit({ "docs/main.md": "main doc" });
  repo.git("switch", "feature");
  repo.git("merge", "--no-ff", "main", "-m", "merge main");
  const merge = repo.git("rev-parse", "HEAD");
  repo.commit({ "docs/review.md": "docs after green merge" });
  expect(
    await planPreview(repo.history(), {
      findPreviewResult: async (commit) =>
        commit === merge
          ? { commit, conclusion: "success", url: "https://depot.dev/merged-preview" }
          : null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "inherit", result: { commit: merge } });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "preview-change-plan-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "ci-test@iterate.com");
  git("config", "user.name", "CI planner test");
  git("config", "commit.gpgsign", "false");
  return {
    directory,
    git,
    commit(files: Record<string, string>) {
      for (const [path, content] of Object.entries(files)) {
        const absolute = join(directory, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
      }
      git("add", ".");
      git("commit", "--allow-empty", "-m", "change");
      return git("rev-parse", "HEAD");
    },
    history: () => new CommitHistory(directory, "HEAD", "main"),
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
