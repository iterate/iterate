import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { CommitHistory } from "./commit-history.ts";
import { classifyChanges, planPreview } from "./change-plan.ts";

test("the last matching type wins for each path, including tests, docs, and generated files", () => {
  expect(
    classifyChanges([
      "apps/os/src/index.ts",
      "apps/os/src/components/chat.tsx",
      "apps/os/src/components/chat.test.tsx",
      "apps/mobile/README.md",
      "apps/mobile/view.tsx",
      "apps/os/scripts/rebuild.ts",
      "scripts/ci/status.ts",
      "scripts/ci/status.test.ts",
      "specs/readme.md",
      "apps/os/src/components/catalog.generated.tsx",
      "pnpm-lock.yaml",
      ".npmrc",
    ]),
  ).toEqual({
    Product: ["apps/os/src/index.ts"],
    Frontend: ["apps/os/src/components/chat.tsx"],
    Tests: ["apps/os/src/components/chat.test.tsx"],
    Docs: ["apps/mobile/README.md", "specs/readme.md"],
    Mobile: ["apps/mobile/view.tsx"],
    Scripts: ["apps/os/scripts/rebuild.ts"],
    CI: ["scripts/ci/status.ts", "scripts/ci/status.test.ts"],
    Generated: ["apps/os/src/components/catalog.generated.tsx", "pnpm-lock.yaml"],
    Default: [".npmrc"],
  });
});

test("docs-only heads skip preview work, even when the PR contains earlier product changes", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "changed" });
  repo.commit({ "README.md": "docs" });

  const plan = await planPreview(repo.history(), async () => {
    throw new Error("Docs-only work must not look up a deployment");
  });
  expect(plan).toMatchObject({ action: "skip", changes: { Docs: ["README.md"] } });
});

test("tests use the nearest deployed ancestor before classifying its product changes", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "main" });
  repo.git("switch", "-c", "feature");
  const product = repo.commit({ "apps/os/index.ts": "candidate backend" });
  const docs = repo.commit({ "README.md": "docs" });
  const head = repo.commit({ "specs/example.spec.ts": "new test" });
  const lookedUp: string[] = [];

  const plan = await planPreview(repo.history(), async (commit) => {
    lookedUp.push(commit);
    return commit === product ? { commit, slot: "preview-6" } : null;
  });
  expect(plan).toMatchObject({
    action: "reuse",
    deployment: { commit: product, slot: "preview-6" },
    changes: { Tests: ["specs/example.spec.ts"] },
  });
  expect(lookedUp).toEqual([head, docs, product]);
});

test("an undeployed product commit blocks an older preview", async () => {
  using repo = repository();
  const main = repo.commit({ "apps/os/index.ts": "base" });
  repo.git("switch", "-c", "feature");
  const barrier = repo.commit({ "apps/os/index.ts": "undeployed change" });
  const head = repo.commit({ "specs/example.spec.ts": "test" });
  const lookedUp: string[] = [];
  const plan = await planPreview(repo.history(), async (commit) => {
    lookedUp.push(commit);
    return commit === main ? { commit, slot: "preview-1" } : null;
  });
  expect(plan).toMatchObject({ action: "deploy", reason: expect.stringContaining(barrier) });
  expect(lookedUp).toEqual([head, barrier]);
});

test.each([true, false])(
  "the merge-base is the final candidate (deployed=%s)",
  async (deployed) => {
    using repo = repository();
    repo.commit({ "README.md": "older than boundary" });
    const main = repo.commit({ "README.md": "boundary" });
    repo.git("switch", "-c", "feature");
    const head = repo.commit({ "specs/example.spec.ts": "test" });
    const lookedUp: string[] = [];
    const plan = await planPreview(repo.history(), async (commit) => {
      lookedUp.push(commit);
      return deployed && commit === main ? { commit, slot: "preview-1" } : null;
    });
    expect(plan.action).toBe(deployed ? "reuse" : "deploy");
    expect(lookedUp).toEqual([head, main]);
  },
);

test("mixed product and test changes deploy without searching; empty heads skip", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "product", "specs/example.spec.ts": "test" });
  const noLookup = async () => {
    throw new Error("No history lookup expected");
  };
  expect(await planPreview(repo.history(), noLookup)).toMatchObject({ action: "deploy" });
  repo.commit({});
  expect(await planPreview(repo.history(), noLookup)).toMatchObject({
    action: "skip",
    changes: {},
  });
});

test("a lookup error is not absence of a deployment", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "specs/example.spec.ts": "test" });
  await expect(
    planPreview(repo.history(), async () => {
      throw new Error("Deployment inventory unavailable");
    }),
  ).rejects.toThrow("Deployment inventory unavailable");
});

test("renaming product code to a doc still requires deployment", async () => {
  using repo = repository();
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature");
  repo.git("mv", "apps/os/index.ts", "README.md");
  repo.commit({});
  expect(await planPreview(repo.history(), async () => null)).toMatchObject({
    action: "deploy",
    changes: { Docs: ["README.md"], Product: ["apps/os/index.ts"] },
  });
});

test("a merge commit classifies the product changes it introduces", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "product");
  repo.commit({ "apps/os/index.ts": "product" });
  repo.git("switch", "-c", "feature", "main");
  repo.commit({ "specs/example.spec.ts": "test" });
  repo.git("merge", "--no-ff", "product", "-m", "merge product");
  expect(await planPreview(repo.history(), async () => null)).toMatchObject({
    action: "deploy",
    changes: { Product: ["apps/os/index.ts"] },
  });
});

test("a merge-base outside the first-parent chain falls back to deployment", async () => {
  using repo = repository();
  repo.commit({ "README.md": "base" });
  repo.git("switch", "-c", "feature");
  repo.commit({ "apps/os/index.ts": "feature product" });
  repo.git("switch", "main");
  repo.commit({ "docs.md": "main documentation" });
  repo.git("switch", "feature");
  repo.git("merge", "--no-ff", "main", "-m", "merge main");
  repo.commit({ "specs/example.spec.ts": "test" });
  // Reusing main here would omit the product change on feature. This first
  // version does not attempt to prove equivalence across side-branch bases.
  expect(
    await planPreview(repo.history(), async () => {
      throw new Error("Do not search across an ambiguous boundary");
    }),
  ).toMatchObject({ action: "deploy" });
});

test("a deleted test and a filename containing a newline keep their exact paths", async () => {
  using repo = repository();
  repo.commit({ "specs/old.spec.ts": "old test" });
  repo.git("switch", "-c", "feature");
  repo.git("rm", "specs/old.spec.ts");
  repo.commit({ "docs/line\nbreak.md": "docs" });
  expect(classifyChanges(repo.history().changedFiles(repo.history().head))).toEqual({
    Docs: ["docs/line\nbreak.md"],
    Tests: ["specs/old.spec.ts"],
  });
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
