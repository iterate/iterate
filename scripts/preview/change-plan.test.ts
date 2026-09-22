import { createServer } from "node:http";
import { Octokit } from "@octokit/rest";
import { expect, test } from "vitest";
import { listenOnFetchSafePort } from "../../packages/shared/src/test-support/fetch-safe-port.ts";
import { classifyChanges, planPreview } from "./change-plan.ts";
import { CommitHistory } from "./commit-history.ts";

test("a product head decides from one GitHub request without inspecting main", async () => {
  const requests: string[] = [];
  await using github = await githubServer((url) => {
    requests.push(url.pathname);
    if (url.pathname === "/repos/iterate/iterate/commits/head") {
      return Response.json({
        sha: "head",
        parents: [{ sha: "parent" }],
        files: [{ filename: "apps/os/index.ts" }],
      });
    }
    return new Response("Unexpected ancestry request", { status: 500 });
  });
  const history = new CommitHistory(github.client, "iterate/iterate", "head", "main");
  expect(await planPreview(history, noEvidence)).toMatchObject({
    action: "deploy",
    changes: { Product: ["apps/os/index.ts"] },
  });
  expect(requests).toEqual(["/repos/iterate/iterate/commits/head"]);
});

test.each(["success", "failure"] as const)(
  "docs follow first parents through the merge-base and inherit %s",
  async (conclusion) => {
    const requests: string[] = [];
    await using github = await githubServer((url) => {
      requests.push(url.pathname);
      if (url.pathname.includes("/compare/")) {
        return Response.json({ merge_base_commit: { sha: "base" } });
      }
      const sha = url.pathname.split("/").at(-1)!;
      const parents = { head: ["docs"], docs: ["base"], base: ["older"] }[sha];
      if (!parents) return new Response("Unexpected ancestor", { status: 404 });
      return Response.json({
        sha,
        parents: parents.map((sha) => ({ sha })),
        files: [{ filename: "README.md" }],
      });
    });
    expect(
      await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
        ...noEvidence,
        findPreviewResult: async (commit) =>
          commit === "base" ? { commit, conclusion, url: "https://depot.dev/preview" } : null,
      }),
    ).toMatchObject({ action: "inherit", result: { commit: "base", conclusion } });
    expect(requests).toEqual([
      "/repos/iterate/iterate/commits/head",
      "/repos/iterate/iterate/compare/main...head",
      "/repos/iterate/iterate/commits/docs",
      "/repos/iterate/iterate/commits/base",
    ]);
  },
);

test.each(["head", "parent"])(
  "a merge at %s deploys without trusting either parent's evidence",
  async (merge) => {
    await using github = await githubServer((url) => {
      if (url.pathname.includes("/compare/"))
        return Response.json({ merge_base_commit: { sha: "base" } });
      const sha = url.pathname.split("/").at(-1)!;
      return Response.json({
        sha,
        parents: (sha === merge ? ["first", "second"] : ["parent"]).map((sha) => ({ sha })),
        files: [{ filename: "README.md" }],
      });
    });
    const lookedUp: string[] = [];
    expect(
      await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
        ...noEvidence,
        findPreviewResult: async (commit) => {
          lookedUp.push(commit);
          return { commit, conclusion: "success", url: "https://depot.dev/preview" };
        },
      }),
    ).toMatchObject({ action: "deploy", reason: expect.stringContaining("merge commit") });
    expect(lookedUp).toEqual([]);
  },
);

test("a full page of docs files deploys because later files could change product behavior", async () => {
  const requests: string[] = [];
  await using github = await githubServer((url) => {
    requests.push(url.pathname);
    if (url.pathname.includes("/compare/"))
      return Response.json({ merge_base_commit: { sha: "parent" } });
    const sha = url.pathname.split("/").at(-1)!;
    return Response.json({
      sha,
      parents: [{ sha: "parent" }],
      files: Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })),
    });
  });
  expect(
    await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
      ...noEvidence,
      findPreviewResult: async (commit) => ({
        commit,
        conclusion: "success",
        url: "https://depot.dev/preview",
      }),
    }),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining("file limit") });
  expect(requests).toEqual(["/repos/iterate/iterate/commits/head"]);
});

test("an unproven history stops after twenty commits and deploys", async () => {
  let reads = 0;
  await using github = await githubServer((url) => {
    if (url.pathname.includes("/compare/"))
      return Response.json({ merge_base_commit: { sha: "base" } });
    if (++reads > 20) return new Response("Exceeded history budget", { status: 400 });
    const sha = url.pathname.split("/").at(-1)!;
    return Response.json({
      sha,
      parents: [{ sha: `commit-${reads}` }],
      files: [{ filename: "README.md" }],
    });
  });
  expect(
    await planPreview(
      new CommitHistory(github.client, "iterate/iterate", "head", "main"),
      noEvidence,
    ),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining("20 commits") });
  expect(reads).toBe(20);
});

test("a product-to-doc rename includes both paths, including newlines", async () => {
  await using github = await githubServer((url) => {
    if (url.pathname.includes("/compare/"))
      return Response.json({ merge_base_commit: { sha: "head" } });
    return Response.json({
      sha: "head",
      parents: [{ sha: "parent" }],
      files: [
        {
          filename: "docs/new\nname.md",
          previous_filename: "apps/os/old\nname.ts",
          status: "renamed",
        },
      ],
    });
  });
  expect(
    await planPreview(
      new CommitHistory(github.client, "iterate/iterate", "head", "main"),
      noEvidence,
    ),
  ).toMatchObject({
    action: "deploy",
    changes: { Product: ["apps/os/old\nname.ts"], Docs: ["docs/new\nname.md"] },
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

test("new tests can reuse head's deployment without asking about main or old outcomes", async () => {
  const requests: string[] = [];
  await using github = await githubServer((url) => {
    requests.push(url.pathname);
    return Response.json({
      sha: "head",
      parents: [{ sha: "parent" }],
      files: [{ filename: "specs/new.spec.ts" }],
    });
  });
  expect(
    await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
      findPreviewResult: async () => {
        throw new Error("New tests cannot inherit old results");
      },
      findPreviewDeployment: async (commit) => ({ commit, slot: "preview-2" }),
    }),
  ).toMatchObject({ action: "reuse", deployment: { commit: "head", slot: "preview-2" } });
  expect(requests).toEqual(["/repos/iterate/iterate/commits/head"]);
});

test.each(["apps/os/index.ts", "specs/new.spec.ts"])(
  "docs cannot skip an untested change to %s",
  async (path) => {
    const resultLookups: string[] = [];
    const requests: string[] = [];
    await using github = await githubServer((url) => {
      requests.push(url.pathname);
      if (url.pathname.includes("/compare/"))
        return Response.json({ merge_base_commit: { sha: "base" } });
      const sha = url.pathname.split("/").at(-1)!;
      const commit = {
        head: { parents: [{ sha: "untested" }], files: [{ filename: "README.md" }] },
        untested: { parents: [{ sha: "base" }], files: [{ filename: path }] },
        base: { parents: [{ sha: "older" }], files: [{ filename: "apps/os/index.ts" }] },
      }[sha];
      return commit ? Response.json({ sha, ...commit }) : new Response("Too far", { status: 404 });
    });
    expect(
      await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
        findPreviewResult: async (commit) => {
          resultLookups.push(commit);
          return commit === "base"
            ? { commit, conclusion: "success", url: "https://depot.dev/preview" }
            : null;
        },
        findPreviewDeployment: async (commit) =>
          commit === "base" ? { commit, slot: "preview-2" } : null,
      }),
    ).toMatchObject({ action: path.startsWith("specs/") ? "reuse" : "deploy" });
    expect(resultLookups).toEqual(["untested"]);
    // The deployment search restarts at head, but reuses the already-read metadata.
    expect(requests.length).toBe(new Set(requests).size);
  },
);

test("untested ancestor tests can reuse a newer docs deployment", async () => {
  const requests: string[] = [];
  await using github = await githubServer((url) => {
    requests.push(url.pathname);
    if (url.pathname.includes("/compare/"))
      return Response.json({ merge_base_commit: { sha: "base" } });
    const sha = url.pathname.split("/").at(-1)!;
    return Response.json({
      sha,
      parents: [{ sha: "tests" }],
      files: [{ filename: sha === "head" ? "README.md" : "specs/new.spec.ts" }],
    });
  });
  expect(
    await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
      ...noEvidence,
      findPreviewDeployment: async (commit) =>
        commit === "head" ? { commit, slot: "preview-2" } : null,
    }),
  ).toMatchObject({ action: "reuse", deployment: { commit: "head", slot: "preview-2" } });
  expect(requests).toEqual([
    "/repos/iterate/iterate/commits/head",
    "/repos/iterate/iterate/compare/main...head",
    "/repos/iterate/iterate/commits/tests",
  ]);
});

test.each([true, false])(
  "the merge-base is the last deployment candidate (available=%s)",
  async (available) => {
    const lookedUp: string[] = [];
    await using github = await githubServer((url) => {
      if (url.pathname.includes("/compare/"))
        return Response.json({ merge_base_commit: { sha: "base" } });
      const sha = url.pathname.split("/").at(-1)!;
      if (sha === "older") return new Response("Walked past merge-base", { status: 400 });
      return Response.json({
        sha,
        parents: [{ sha: sha === "head" ? "base" : "older" }],
        files: [{ filename: "specs/test.spec.ts" }],
      });
    });
    expect(
      await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
        findPreviewResult: async () => {
          throw new Error("Tests must run");
        },
        findPreviewDeployment: async (commit) => {
          lookedUp.push(commit);
          return available && commit === "base" ? { commit, slot: "preview-2" } : null;
        },
      }),
    ).toMatchObject({ action: available ? "reuse" : "deploy" });
    expect(lookedUp).toEqual(["head", "base"]);
  },
);

test("tests cannot reuse a deployment older than an undeployed product change", async () => {
  const lookedUp: string[] = [];
  await using github = await githubServer((url) => {
    if (url.pathname.includes("/compare/"))
      return Response.json({ merge_base_commit: { sha: "base" } });
    const sha = url.pathname.split("/").at(-1)!;
    return Response.json({
      sha,
      parents: [{ sha: sha === "head" ? "product" : "base" }],
      files: [{ filename: sha === "head" ? "specs/new.spec.ts" : "apps/os/index.ts" }],
    });
  });
  expect(
    await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
      ...noEvidence,
      findPreviewDeployment: async (commit) => {
        lookedUp.push(commit);
        return commit === "base" ? { commit, slot: "preview-2" } : null;
      },
    }),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining("product") });
  expect(lookedUp).toEqual(["head", "product"]);
});

test.each(["root", "merge-base"])(
  "a docs head at %s cannot inherit older results",
  async (boundary) => {
    await using github = await githubServer((url) => {
      if (url.pathname.includes("/compare/"))
        return Response.json({ merge_base_commit: { sha: "head" } });
      return Response.json({
        sha: "head",
        parents: boundary === "root" ? [] : [{ sha: "older" }],
        files: [],
      });
    });
    expect(
      await planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
        ...noEvidence,
        findPreviewResult: async () => {
          throw new Error("No older candidates");
        },
      }),
    ).toMatchObject({ action: "deploy" });
  },
);

test.each(["commit", "comparison"])(
  "GitHub %s failures remain visible errors",
  async (operation) => {
    await using github = await githubServer((url) => {
      if (operation === "commit" || url.pathname.includes("/compare/")) {
        return Response.json({ message: "API unavailable" }, { status: 503 });
      }
      return Response.json({ sha: "head", parents: [{ sha: "base" }], files: [] });
    });
    await expect(
      planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), noEvidence),
    ).rejects.toThrow("API unavailable");
  },
);

test("missing file metadata is an error rather than an empty docs change", async () => {
  await using github = await githubServer(() => Response.json({ sha: "head", parents: [] }));
  await expect(
    planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), noEvidence),
  ).rejects.toThrow("omitted files");
});

test("a pagination header prevents inheritance even when the first page is short", async () => {
  await using github = await githubServer(() =>
    Response.json(
      { sha: "head", parents: [], files: [] },
      {
        headers: { link: '</repos/iterate/iterate/commits/head?page=2>; rel="next"' },
      },
    ),
  );
  expect(
    await planPreview(
      new CommitHistory(github.client, "iterate/iterate", "head", "main"),
      noEvidence,
    ),
  ).toMatchObject({ action: "deploy", reason: expect.stringContaining("file limit") });
});

test("a failed deployment lookup is not a missing deployment", async () => {
  await using github = await githubServer(() =>
    Response.json({ sha: "head", parents: [], files: [{ filename: "specs/test.spec.ts" }] }),
  );
  await expect(
    planPreview(new CommitHistory(github.client, "iterate/iterate", "head", "main"), {
      ...noEvidence,
      findPreviewDeployment: async () => {
        throw new Error("Inventory unavailable");
      },
    }),
  ).rejects.toThrow("Inventory unavailable");
});

const noEvidence = {
  findPreviewResult: async () => null,
  findPreviewDeployment: async () => null,
};

async function githubServer(handle: (url: URL) => Response | Promise<Response>) {
  const server = createServer(async (request, response) => {
    const result = await handle(new URL(request.url!, `http://${request.headers.host}`));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  const port = await listenOnFetchSafePort(server);
  return {
    client: new Octokit({ baseUrl: `http://127.0.0.1:${port}` }),
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
