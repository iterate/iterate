import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { CommitHistory } from "./commit-history.ts";
import { classifyChanges, planPreview } from "./change-plan.ts";

test("a depth-one product checkout decides from head without fetching main or old file contents", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "old product", "docs/unchanged.md": "old docs" });
  const oldBlob = repo.git("rev-parse", "HEAD:apps/os/index.ts");
  repo.git("switch", "-c", "feature");
  const head = repo.commit({ "apps/os/index.ts": "new product" });
  const checkout = repo.shallowCheckout();

  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => {
        throw new Error("Product head needs no old results");
      },
      findPreviewDeployment: async () => {
        throw new Error("Product head needs no old deployment");
      },
    }),
  ).toMatchObject({ action: "deploy", changes: { Product: ["apps/os/index.ts"] } });
  expect(checkout.git("rev-parse", "HEAD")).toBe(head);
  expect(checkout.git("status", "--porcelain")).toBe("");
  expect(checkout.git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main")).toBe("");
  expect(checkout.git("rev-list", "--objects", "--missing=print", "HEAD")).toContain(`?${oldBlob}`);
});

test("a baked parent tree needs no fetch even when checkout marks head as shallow", async () => {
  using repo = repository();
  const parent = repo.commit({ "apps/os/index.ts": "old product" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "new product" });
  const checkout = repo.shallowCheckout();
  checkout.git("fetch", "--depth=1", "--filter=blob:none", "origin", parent);
  checkout.git("remote", "set-url", "origin", join(repo.directory, "missing-remote"));
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "deploy", changes: { Product: ["apps/os/index.ts"] } });
});

test("planning in a complete clone does not truncate its history or require a remote", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  for (let i = 0; i < 5; i++) repo.commit({ "README.md": `main docs ${i}` });
  const base = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-c", "feature");
  repo.commit({ "README.md": "feature docs" });
  const checkout = repo.shallowCheckout();
  checkout.git("fetch", "--unshallow", "origin", "+refs/heads/main:refs/remotes/origin/main");
  checkout.git("remote", "set-url", "origin", join(repo.directory, "missing-remote"));
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async (commit) =>
        commit === base
          ? { commit, conclusion: "success", url: "https://depot.dev/settled-preview" }
          : null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "inherit", result: { commit: base } });
  expect(checkout.git("rev-parse", "--is-shallow-repository")).toBe("false");
});

test("a shallow docs checkout fetches enough metadata to inherit through the merge-base", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "old product" });
  for (let i = 0; i < 2; i++) repo.commit({ "apps/os/index.ts": `product ${i}` });
  const base = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-c", "feature");
  for (let i = 0; i < 7; i++) repo.commit({ "README.md": `docs ${i}` });
  repo.git("switch", "main");
  for (let i = 0; i < 2; i++) repo.commit({ "apps/os/index.ts": `main ${i}` });
  repo.git("switch", "feature");
  const checkout = repo.shallowCheckout();
  const lookedUp: string[] = [];

  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async (commit) => {
        lookedUp.push(commit);
        return commit === base
          ? { commit, conclusion: "failure", url: "https://depot.dev/failed-preview" }
          : null;
      },
      findPreviewDeployment: async () => {
        throw new Error("Docs inherit without deployment lookup");
      },
    }),
  ).toMatchObject({
    action: "inherit",
    changes: { Docs: ["README.md"] },
    result: { commit: base, conclusion: "failure" },
  });
  expect(lookedUp.at(-1)).toBe(base);
  expect(checkout.git("status", "--porcelain")).toBe("");
});

test("a shallow test head can reuse its own deployment without fetching main", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  const head = repo.commit({ "specs/new.spec.ts": "new test" });
  const checkout = repo.shallowCheckout();
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => {
        throw new Error("New tests cannot inherit old outcomes");
      },
      findPreviewDeployment: async (commit) => ({ commit, slot: "preview-2" }),
    }),
  ).toMatchObject({ action: "reuse", deployment: { commit: head, slot: "preview-2" } });
  expect(checkout.git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main")).toBe("");
});

test("a failed metadata fetch remains a planning error", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "README.md": "docs" });
  const checkout = repo.shallowCheckout();
  checkout.git("remote", "set-url", "origin", join(repo.directory, "missing-remote"));
  await expect(
    planPreview(checkout.history, {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).rejects.toThrow(/git fetch/);
});

test("a shallow criss-cross history cannot inherit from either merge-base", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  const left = repo.commit({ "docs/left.md": "left" });
  repo.git("switch", "main");
  const right = repo.commit({ "docs/right.md": "right" });
  repo.git("merge", "--no-ff", left, "-m", "merge left");
  repo.git("switch", "feature");
  repo.git("merge", "--no-ff", right, "-m", "merge right");
  repo.commit({ "docs/head.md": "head" });
  const checkout = repo.shallowCheckout();
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => {
        throw new Error("Neither merge-base is a safe boundary");
      },
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining("no single merge-base") });
});

test("a shallow rename keeps both paths, including newlines", async () => {
  using repo = repository();
  repo.commit({ "apps/os/old\nname.ts": "product" });
  repo.git("switch", "-c", "feature");
  repo.git("mv", "apps/os/old\nname.ts", "README.md");
  repo.commit({});
  const checkout = repo.shallowCheckout();
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => null,
      findPreviewDeployment: async () => null,
    }),
  ).toMatchObject({
    action: "deploy",
    changes: { Product: ["apps/os/old\nname.ts"], Docs: ["README.md"] },
  });
});

test("a real root commit has no missing parent to fetch", async () => {
  using repo = repository();
  repo.commit({ "README.md": "docs" });
  repo.git("switch", "-c", "feature");
  const checkout = repo.shallowCheckout();
  expect(checkout.history.changedFiles(checkout.history.head)).toEqual(["README.md"]);
  expect(checkout.git("config", "--get-regexp", "remote.origin")).not.toContain("promisor");
});

test("a shallow remote that cannot supply the merge-base exhausts a bounded metadata budget", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  for (let i = 0; i < 7; i++) repo.commit({ "README.md": `docs ${i}` });
  const remote = join(repo.directory, "remote.ignoreme");
  repo.git("clone", "--depth=4", "--no-single-branch", `file://${repo.directory}`, remote);
  repo.git("-C", remote, "config", "uploadpack.allowFilter", "true");
  repo.git("-C", remote, "branch", "main", "origin/main");
  const checkout = repo.shallowCheckout();
  checkout.git("remote", "set-url", "origin", `file://${remote}`);
  expect(
    await planPreview(checkout.history, {
      findPreviewResult: async () => {
        throw new Error("Unproven ancestry cannot inherit");
      },
      findPreviewDeployment: async () => {
        throw new Error("Docs do not look up deployments");
      },
    }),
  ).toMatchObject({
    action: "deploy",
    reason: expect.stringContaining("metadata fetch budget exhausted"),
  });
});

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

test.each([false, true])(
  "a side-branch merge-base cannot substitute main for unmerged feature code (shallow=%s)",
  async (shallow) => {
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
      await planPreview(shallow ? repo.shallowCheckout().history : repo.history(), {
        findPreviewResult: async () => null,
        findPreviewDeployment: async (commit) => {
          lookedUp.push(commit);
          return commit === main ? { commit, slot: "preview-1" } : null;
        },
      }),
    ).toMatchObject({ action: "deploy" });
    expect(lookedUp).toEqual([head, merge]);
  },
);

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

test.each([false, true])(
  "docs inherit a tested merge even when main is its second parent (shallow=%s)",
  async (shallow) => {
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
      await planPreview(shallow ? repo.shallowCheckout().history : repo.history(), {
        findPreviewResult: async (commit) =>
          commit === merge
            ? { commit, conclusion: "success", url: "https://depot.dev/merged-preview" }
            : null,
        findPreviewDeployment: async () => null,
      }),
    ).toMatchObject({ action: "inherit", result: { commit: merge } });
  },
);

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
  git("config", "uploadpack.allowFilter", "true");
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
    shallowCheckout() {
      const checkout = join(directory, "checkout.ignoreme");
      git(
        "clone",
        "--depth=1",
        "--single-branch",
        "--branch=feature",
        `file://${directory}`,
        checkout,
      );
      const checkoutGit = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: checkout,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      return { history: new CommitHistory(checkout, "HEAD", "origin/main"), git: checkoutGit };
    },
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
