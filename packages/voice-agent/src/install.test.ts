import { describe, expect, it } from "vitest";
import {
  installVoiceAgent,
  legacyGuestPaths,
  removeLegacyGuest,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_PACKAGE_SPEC,
  withVoiceAgentDependency,
  type VoiceAgentConfigRepo,
} from "./install.ts";

const PINNED = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@0123456789abcdef";

const manifest = (dependencies: Record<string, string>) =>
  `${JSON.stringify({ name: "a-project", private: true, dependencies, devDependencies: { typescript: "^5" } }, null, 2)}\n`;

/** A config repo that remembers what it was handed and nothing else. */
function fakeRepo(files: Record<string, string>) {
  const commits: { message: string; changes: unknown[] }[] = [];
  const repo: VoiceAgentConfigRepo = {
    readFile: async ({ path }) =>
      path in files ? { commitOid: "head".padEnd(40, "0"), content: files[path]! } : null,
    commitFiles: async ({ message, changes }) => {
      commits.push({ message, changes });
      for (const change of changes) {
        if ("delete" in change) delete files[change.path];
        else files[change.path] = change.content;
      }
      return {
        commitOid: `commit-${commits.length}`.padEnd(40, "0"),
        changedPaths: changes.map((change) => change.path),
        noChanges: false,
      };
    },
  };
  return { repo, commits, files };
}

describe("withVoiceAgentDependency", () => {
  it("adds the package to a manifest that lacks it and keeps everything else", () => {
    const before = manifest({ iterate: "https://pkg.pr.new/iterate/iterate/iterate@main" });
    const after = withVoiceAgentDependency(before, { existing: "replace" });
    expect(after.changed).toBe(true);
    expect(after.spec).toBe(VOICE_AGENT_PACKAGE_SPEC);
    expect(JSON.parse(after.content)).toEqual({
      name: "a-project",
      private: true,
      dependencies: {
        iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
        [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
      },
      devDependencies: { typescript: "^5" },
    });
    /* The layout the platform itself writes, so a later platform rewrite
     * produces no spurious diff. */
    expect(after.content.endsWith("}\n")).toBe(true);
  });

  it("creates the dependencies field when there is none", () => {
    const after = withVoiceAgentDependency(`{"name":"bare"}`, { existing: "keep" });
    expect(JSON.parse(after.content)).toEqual({
      name: "bare",
      dependencies: { [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC },
    });
  });

  it("is a no-op when the wanted spec is already declared", () => {
    const before = manifest({ [VOICE_AGENT_PACKAGE_NAME]: PINNED });
    const after = withVoiceAgentDependency(before, { existing: "replace", spec: PINNED });
    expect(after).toEqual({ content: before, spec: PINNED, changed: false });
  });

  it("keeps a different existing spec when asked to, and replaces it otherwise", () => {
    const before = manifest({ [VOICE_AGENT_PACKAGE_NAME]: PINNED });
    expect(withVoiceAgentDependency(before, { existing: "keep" })).toEqual({
      content: before,
      spec: PINNED,
      changed: false,
    });
    const replaced = withVoiceAgentDependency(before, { existing: "replace" });
    expect(replaced.changed).toBe(true);
    expect(JSON.parse(replaced.content).dependencies[VOICE_AGENT_PACKAGE_NAME]).toBe(
      VOICE_AGENT_PACKAGE_SPEC,
    );
  });

  it("refuses a manifest it cannot read rather than guessing", () => {
    expect(() => withVoiceAgentDependency("{not json", { existing: "keep" })).toThrow(
      /not valid JSON/,
    );
    expect(() => withVoiceAgentDependency("[]", { existing: "keep" })).toThrow(/JSON object/);
    expect(() =>
      withVoiceAgentDependency(`{"dependencies":["iterate"]}`, { existing: "keep" }),
    ).toThrow(/dependencies must be an object/);
  });
});

describe("installVoiceAgent", () => {
  it("commits package.json once, then reports the head unchanged", async () => {
    const { repo, commits } = fakeRepo({ "package.json": manifest({}) });
    const first = await installVoiceAgent(repo, { existing: "replace" });
    expect(first).toEqual({
      changed: true,
      commitOid: "commit-1".padEnd(40, "0"),
      spec: VOICE_AGENT_PACKAGE_SPEC,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe(`voice-agent: depend on ${VOICE_AGENT_PACKAGE_SPEC}`);

    const second = await installVoiceAgent(repo, { existing: "replace" });
    expect(second).toEqual({
      changed: false,
      commitOid: "head".padEnd(40, "0"),
      spec: VOICE_AGENT_PACKAGE_SPEC,
    });
    expect(commits).toHaveLength(1);
  });

  it("fails loudly on a repo with no package.json", async () => {
    const { repo } = fakeRepo({});
    await expect(installVoiceAgent(repo, { existing: "keep" })).rejects.toThrow(/no package\.json/);
  });
});

describe("the committed copy from before the package", () => {
  it("is reported, and removed in one commit only when present", async () => {
    const { repo, commits, files } = fakeRepo({
      "package.json": manifest({}),
      "voice-agent.ts": "// old",
      "viseme.ts": "// old",
      "worker.ts": "// the project's own",
    });
    expect(await legacyGuestPaths(repo)).toEqual(["voice-agent.ts", "viseme.ts"]);

    const removed = await removeLegacyGuest(repo);
    expect(removed?.paths).toEqual(["voice-agent.ts", "viseme.ts"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.changes).toEqual([
      { path: "voice-agent.ts", delete: true },
      { path: "viseme.ts", delete: true },
    ]);
    expect(Object.keys(files).sort()).toEqual(["package.json", "worker.ts"]);

    expect(await removeLegacyGuest(repo)).toBeNull();
    expect(commits).toHaveLength(1);
  });
});
