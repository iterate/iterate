import { expect, it } from "vitest";
import {
  planTemplateSync,
  runTemplateSync,
  templateReferenceForCreateRequest,
  type TemplateSyncDeps,
} from "./template-sync.ts";

it("adopts template changes the user never touched (clean sync)", async () => {
  const repo = seededRepo({
    "AGENTS.md": "seeded agents\n",
    "worker.ts": "export default seedWorker\n",
  });
  repo.template.set("worker.ts", "export default improvedWorker\n");
  repo.template.set("rules/new-rule.md", "be nice\n");

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  expect(result).toMatchObject({
    updated: ["rules/new-rule.md", "worker.ts"],
    skipped: [],
    templateCommitOid: repo.template.commitOid,
  });
  expect(result.upToDate).toBeUndefined();
  expect(repo.headFiles()).toMatchObject({
    "worker.ts": "export default improvedWorker\n",
    "rules/new-rule.md": "be nice\n",
  });
  expect(repo.templateSyncedEvents).toEqual([{ templateCommitOid: repo.template.commitOid }]);
  // Git-native provenance: the trailers name the exact template revision, so
  // plain git history answers "where did this commit come from" even on
  // mirrors and re-imports that never see the stream's events.
  expect(repo.commitMessages.at(-1)).toContain(
    `Sync from template github:iterate/iterate#path:configs/default @ ${repo.template.commitOid.slice(0, 7)}`,
  );
  expect(repo.commitMessages.at(-1)).toContain(
    "Template-Reference: github:iterate/iterate#path:configs/default",
  );
  expect(repo.commitMessages.at(-1)).toContain(`Template-Commit: ${repo.template.commitOid}`);
});

it("keeps the user's edits when the template did not change that file", async () => {
  const repo = seededRepo({
    "AGENTS.md": "seeded agents\n",
    "worker.ts": "export default seedWorker\n",
  });
  repo.commitUserEdit("AGENTS.md", "my own project notes\n");
  repo.template.set("worker.ts", "export default improvedWorker\n");

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  expect(result).toMatchObject({ updated: ["worker.ts"], skipped: [] });
  expect(repo.headFiles()).toMatchObject({
    "AGENTS.md": "my own project notes\n",
    "worker.ts": "export default improvedWorker\n",
  });
});

it("skips and reports files both sides changed, committing the rest", async () => {
  const repo = seededRepo({
    "package.json": `{"dependencies":{"left":"1"}}\n`,
    "worker.ts": "export default seedWorker\n",
  });
  repo.commitUserEdit("package.json", `{"dependencies":{"left":"1","mine":"2"}}\n`);
  repo.template.set("package.json", `{"dependencies":{"left":"3"}}\n`);
  repo.template.set("worker.ts", "export default improvedWorker\n");

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  expect(result).toMatchObject({ updated: ["worker.ts"], skipped: ["package.json"] });
  // The user's conflicting copy stands; git history covers the curious.
  expect(repo.headFiles()["package.json"]).toBe(`{"dependencies":{"left":"1","mine":"2"}}\n`);
  // The base advances anyway: a skip is reported once per template change,
  // not on every click of the button.
  expect(repo.templateSyncedEvents).toEqual([{ templateCommitOid: repo.template.commitOid }]);

  const repeat = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: result.templateCommitOid },
    repo.deps,
  );
  expect(repeat).toMatchObject({ upToDate: true, updated: [], skipped: [] });
});

it("deletes files the template removed, unless the user edited them", async () => {
  const repo = seededRepo({
    "keep-mine.md": "seed\n",
    "obsolete.md": "seed\n",
    "worker.ts": "export default seedWorker\n",
  });
  repo.commitUserEdit("keep-mine.md", "user version\n");
  repo.template.delete("obsolete.md");
  repo.template.delete("keep-mine.md");

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  expect(result).toMatchObject({ updated: ["obsolete.md"], skipped: ["keep-mine.md"] });
  expect(repo.headFiles()).not.toHaveProperty("obsolete.md");
  expect(repo.headFiles()["keep-mine.md"]).toBe("user version\n");
});

it("reports upToDate on a repeated sync and does not commit again", async () => {
  const repo = seededRepo({ "worker.ts": "export default seedWorker\n" });
  repo.template.set("worker.ts", "export default improvedWorker\n");

  const first = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );
  const commitsAfterFirst = repo.commitCount();
  const second = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: first.templateCommitOid },
    repo.deps,
  );

  expect(second).toMatchObject({
    upToDate: true,
    updated: [],
    skipped: [],
    templateCommitOid: first.templateCommitOid,
    commitOid: first.commitOid,
  });
  expect(repo.commitCount()).toBe(commitsAfterFirst);
});

it("advances the base without a commit when the repo already matches a newer template", async () => {
  const repo = seededRepo({ "worker.ts": "export default seedWorker\n" });
  repo.template.set("worker.ts", "export default improvedWorker\n");
  repo.commitUserEdit("worker.ts", "export default improvedWorker\n");

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  expect(result).toMatchObject({ upToDate: true, updated: [], skipped: [] });
  expect(repo.templateSyncedEvents).toEqual([{ templateCommitOid: repo.template.commitOid }]);
});

it("re-applies the package.json substitution before diffing, so a pinned seed stays clean", async () => {
  const rawManifest = `{\n  "dependencies": {\n    "@iterate-com/sdk": "https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@main"\n  }\n}\n`;
  const pinnedManifest = `{\n  "dependencies": {\n    "@iterate-com/sdk": "https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@abc1234"\n  }\n}\n`;
  const repo = seededRepo({ "package.json": pinnedManifest }, { iterateRepoPkgRef: "abc1234" });
  repo.template.set("package.json", rawManifest);

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    repo.deps,
  );

  // The template's raw spec substitutes to exactly the seeded pin: no change.
  expect(result).toMatchObject({ upToDate: true, updated: [], skipped: [] });
});

it("first sync on pre-substitution history skips package.json noisily but harmlessly", async () => {
  // Old repos seeded before the substitution existed: the root commit holds
  // the RAW spec while later platform commits pinned it — package.json reads
  // as user-edited AND (once the template moves) template-changed.
  const rawManifest = `{\n  "dependencies": {\n    "@iterate-com/sdk": "https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@main"\n  }\n}\n`;
  const pinnedManifest = `{\n  "dependencies": {\n    "@iterate-com/sdk": "https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@abc1234"\n  }\n}\n`;
  const movedManifest = `{\n  "dependencies": {\n    "@iterate-com/sdk": "https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@main",\n    "left-pad": "1.0.0"\n  }\n}\n`;
  // Seed WITHOUT the knob (the pre-substitution era), then pin at sync time.
  const repo = seededRepo({ "package.json": rawManifest }, {});
  repo.commitUserEdit("package.json", pinnedManifest);
  repo.template.set("package.json", movedManifest);

  const result = await runTemplateSync(
    { reference: REFERENCE, baseTemplateCommitOid: null },
    { ...repo.deps, repointConfig: { iterateRepoPkgRef: "abc1234" } },
  );

  expect(result).toMatchObject({ updated: [], skipped: ["package.json"] });
});

it("maps empty creates to the Default template and strips pinned-SHA refs", () => {
  expect(templateReferenceForCreateRequest({ type: "empty" })).toEqual({
    owner: "iterate",
    repo: "iterate",
    path: "configs/default",
  });
  expect(
    templateReferenceForCreateRequest({
      type: "github-public-template",
      owner: "iterate",
      repo: "iterate",
      path: "configs/voice-agent",
      ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ).toEqual({ owner: "iterate", repo: "iterate", path: "configs/voice-agent" });
  expect(
    templateReferenceForCreateRequest({
      type: "github-public-template",
      owner: "acme",
      repo: "templates",
      ref: "release-2",
    }),
  ).toEqual({ owner: "acme", repo: "templates", ref: "release-2" });
});

it("refuses import-created repos with a clear error", () => {
  expect(() =>
    templateReferenceForCreateRequest({
      type: "github-private",
      connection: "install-1",
      owner: "acme",
      repo: "internal",
    }),
  ).toThrow(/not from a template.*syncFromGithub/s);
  expect(() => templateReferenceForCreateRequest(null)).toThrow(/no creation request/);
});

it("plans nothing when template and base agree, whatever the user did", () => {
  const plan = planTemplateSync({
    base: { "a.md": "same\n" },
    latest: { "a.md": "same\n" },
    head: { "a.md": "user rewrote this\n" },
  });
  expect(plan).toEqual({ changes: [], updated: [], skipped: [] });
});

// -----------------------------------------------------------------------------
// In-memory repo + template pair driving runTemplateSync's injected reads and
// writes: the template is a mutable file map with a synthetic commit oid per
// mutation; the repo records its root commit (the substituted seed) and a
// mutable head the way seeding and later commits produce them.
// -----------------------------------------------------------------------------

const REFERENCE = { owner: "iterate", repo: "iterate", path: "configs/default" };

function seededRepo(
  templateFiles: Record<string, string>,
  repointConfig: TemplateSyncDeps["repointConfig"] = {},
) {
  let templateVersion = 0;
  const template = new Map(Object.entries(templateFiles));
  const templateCommitOid = () => `template${templateVersion}`.padEnd(40, "0");

  // Seeding applies the substitution exactly like createEmptyArtifactRepo.
  const seeded = Object.fromEntries(
    Object.entries(templateFiles).map(([path, content]) => {
      if (!path.endsWith("package.json") || repointConfig.iterateRepoPkgRef === undefined) {
        return [path, content];
      }
      return [path, content.replaceAll("@main", `@${repointConfig.iterateRepoPkgRef}`)];
    }),
  );
  const root = { ...seeded };
  const head = { ...seeded };
  let commitCount = 1;
  const templateSyncedEvents: Array<{ templateCommitOid: string }> = [];
  const commitMessages: string[] = [];

  const deps: TemplateSyncDeps = {
    downloadTemplate: (reference) => {
      if (reference.ref !== undefined && reference.ref !== templateCommitOid()) {
        throw new Error(`fake template store has no revision ${reference.ref}`);
      }
      return Promise.resolve({
        commitOid: templateCommitOid(),
        files: [...template.entries()].map(([path, content]) => ({ content, path })),
      });
    },
    repointConfig,
    readRootCommitFiles: () => Promise.resolve({ ...root }),
    readHeadFiles: (paths) =>
      Promise.resolve({
        commitOid: `head${commitCount}`.padEnd(40, "0"),
        files: Object.fromEntries(paths.filter((path) => path in head).map((p) => [p, head[p]!])),
      }),
    commitChanges: ({ changes, message }) => {
      commitMessages.push(message);
      for (const change of changes) {
        if ("delete" in change) delete head[change.path];
        else if ("content" in change) head[change.path] = change.content;
      }
      commitCount += 1;
      return Promise.resolve({ commitOid: `head${commitCount}`.padEnd(40, "0") });
    },
    appendTemplateSynced: (payload) => {
      templateSyncedEvents.push(payload);
      return Promise.resolve();
    },
  };

  return {
    deps,
    templateSyncedEvents,
    commitMessages,
    headFiles: () => ({ ...head }),
    commitCount: () => commitCount,
    commitUserEdit: (path: string, content: string) => {
      head[path] = content;
      commitCount += 1;
    },
    template: {
      set: (path: string, content: string) => {
        template.set(path, content);
        templateVersion += 1;
      },
      delete: (path: string) => {
        template.delete(path);
        templateVersion += 1;
      },
      get commitOid() {
        return templateCommitOid();
      },
    },
  };
}
