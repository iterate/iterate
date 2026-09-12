import { describe, expect, it } from "vitest";
import {
  installVoiceAgent,
  installVoiceAgentFromSource,
  legacyGuestPaths,
  removeLegacyGuest,
  VOICE_AGENT_GUEST_SOURCE,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_GUEST_SOURCE_FROM_REPO,
  VOICE_AGENT_PACKAGE_SPEC,
  VOICE_AGENT_SOURCE_FILES,
  VOICE_AGENT_ZOD_SPEC,
  withVoiceAgentDependency,
  withVoiceAgentGuestFile,
  type VoiceAgentConfigRepo,
} from "./install.ts";

const PINNED = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@0123456789abcdef";
const ITERATE = "https://pkg.pr.new/iterate/iterate/iterate@main";

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
  it("adds the package and zod to a manifest that lacks them, keeping everything else in order", () => {
    const after = withVoiceAgentDependency(manifest({ iterate: ITERATE }), { existing: "replace" });
    expect(after.changed).toBe(true);
    expect(after.spec).toBe(VOICE_AGENT_PACKAGE_SPEC);
    const parsed = JSON.parse(after.content);
    expect(parsed).toEqual({
      name: "a-project",
      private: true,
      dependencies: {
        iterate: ITERATE,
        [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
        zod: VOICE_AGENT_ZOD_SPEC,
      },
      devDependencies: { typescript: "^5" },
    });
    /* The layout the platform itself writes, so a later platform rewrite
     * produces no spurious diff — and the keys stay in the file's own order. */
    expect(after.content.endsWith("}\n")).toBe(true);
    expect(Object.keys(parsed)).toEqual(["name", "private", "dependencies", "devDependencies"]);
  });

  it("leaves a zod the project already pins alone", () => {
    const after = withVoiceAgentDependency(manifest({ zod: "4.3.6" }), { existing: "replace" });
    expect(JSON.parse(after.content).dependencies.zod).toBe("4.3.6");
  });

  it("creates the dependencies field when there is none", () => {
    const after = withVoiceAgentDependency(`{"name":"bare"}`, { existing: "keep" });
    expect(JSON.parse(after.content)).toEqual({
      name: "bare",
      dependencies: {
        [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
        zod: VOICE_AGENT_ZOD_SPEC,
      },
    });
  });

  it("is a no-op when both lines are already right", () => {
    const before = manifest({ [VOICE_AGENT_PACKAGE_NAME]: PINNED, zod: VOICE_AGENT_ZOD_SPEC });
    expect(withVoiceAgentDependency(before, { existing: "replace", spec: PINNED })).toEqual({
      content: before,
      spec: PINNED,
      changed: false,
    });
  });

  it("keeps a different existing spec when asked to, and replaces it otherwise", () => {
    const before = manifest({ [VOICE_AGENT_PACKAGE_NAME]: PINNED, zod: VOICE_AGENT_ZOD_SPEC });
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
    ).toThrow(/dependencies must map names to specs/);
    expect(() =>
      withVoiceAgentDependency(`{"dependencies":{"iterate":1}}`, { existing: "keep" }),
    ).toThrow(/dependencies must map names to specs/);
  });
});

describe("withVoiceAgentGuestFile", () => {
  it("writes the re-export when the file is missing, and leaves it alone once it is that", () => {
    expect(withVoiceAgentGuestFile(null, "keep")).toEqual({
      content: VOICE_AGENT_GUEST_SOURCE,
      changed: true,
    });
    expect(withVoiceAgentGuestFile(VOICE_AGENT_GUEST_SOURCE, "replace")).toEqual({
      content: VOICE_AGENT_GUEST_SOURCE,
      changed: false,
    });
  });

  it("keeps a file holding something else under keep, and overwrites it under replace", () => {
    const committedCopy = "// 5,000 lines of the agent, committed by an old deploy\n";
    expect(withVoiceAgentGuestFile(committedCopy, "keep")).toEqual({
      content: committedCopy,
      changed: false,
    });
    expect(withVoiceAgentGuestFile(committedCopy, "replace")).toEqual({
      content: VOICE_AGENT_GUEST_SOURCE,
      changed: true,
    });
  });
});

describe("installVoiceAgent", () => {
  it("commits package.json and voice-agent.ts together once, then reports the head unchanged", async () => {
    const { repo, commits, files } = fakeRepo({ "package.json": manifest({ iterate: ITERATE }) });
    const first = await installVoiceAgent(repo, { existing: "replace" });
    expect(first).toEqual({
      changed: true,
      commitOid: "commit-1".padEnd(40, "0"),
      spec: VOICE_AGENT_PACKAGE_SPEC,
      changedPaths: ["package.json", "voice-agent.ts"],
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe(`voice-agent: depend on ${VOICE_AGENT_PACKAGE_SPEC}`);
    expect(files["voice-agent.ts"]).toBe(VOICE_AGENT_GUEST_SOURCE);

    const second = await installVoiceAgent(repo, { existing: "replace" });
    expect(second).toEqual({
      changed: false,
      commitOid: "head".padEnd(40, "0"),
      spec: VOICE_AGENT_PACKAGE_SPEC,
      changedPaths: [],
    });
    expect(commits).toHaveLength(1);
  });

  it("under keep, fills only the gaps: a pin and an old copy both stay", async () => {
    const committedCopy = "// the old committed agent\n";
    const { repo, commits, files } = fakeRepo({
      "package.json": manifest({ [VOICE_AGENT_PACKAGE_NAME]: PINNED }),
      "voice-agent.ts": committedCopy,
    });
    const result = await installVoiceAgent(repo, { existing: "keep" });
    expect(result.spec).toBe(PINNED);
    expect(result.changedPaths).toEqual(["package.json"]); // zod was missing
    expect(JSON.parse(files["package.json"]!).dependencies).toEqual({
      [VOICE_AGENT_PACKAGE_NAME]: PINNED,
      zod: VOICE_AGENT_ZOD_SPEC,
    });
    expect(files["voice-agent.ts"]).toBe(committedCopy);
    expect(commits).toHaveLength(1);
  });

  it("fails loudly on a repo with no package.json", async () => {
    const { repo } = fakeRepo({});
    await expect(installVoiceAgent(repo, { existing: "keep" })).rejects.toThrow(/no package\.json/);
  });
});

describe("the committed copy from before the package", () => {
  it("is reported by its sibling files, and removed in one commit only when present", async () => {
    const { repo, commits, files } = fakeRepo({
      "package.json": manifest({}),
      "voice-agent.ts": "// old",
      "viseme.ts": "// old",
      "pcm.ts": "// old",
      "worker.ts": "// the project's own",
    });
    expect(await legacyGuestPaths(repo)).toEqual(["pcm.ts", "viseme.ts"]);

    const removed = await removeLegacyGuest(repo);
    expect(removed?.paths).toEqual(["pcm.ts", "viseme.ts"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.changes).toEqual([
      { path: "pcm.ts", delete: true },
      { path: "viseme.ts", delete: true },
    ]);
    /* voice-agent.ts is not a legacy file: the installer overwrites it with the re-export. */
    expect(Object.keys(files).sort()).toEqual(["package.json", "voice-agent.ts", "worker.ts"]);

    expect(await removeLegacyGuest(repo)).toBeNull();
    expect(commits).toHaveLength(1);
  });
});

describe("installVoiceAgentFromSource", () => {
  const source = Object.fromEntries(
    VOICE_AGENT_SOURCE_FILES.map((file) => [file, `// ${file}\n`]),
  ) as Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>;

  it("commits the checkout's files, the repo re-export and a manifest without the published package", async () => {
    const { repo, commits, files } = fakeRepo({
      "package.json": manifest({
        iterate: ITERATE,
        [VOICE_AGENT_PACKAGE_NAME]: PINNED,
        zod: "4.5.4",
      }),
      "voice-agent.ts": VOICE_AGENT_GUEST_SOURCE,
    });
    const result = await installVoiceAgentFromSource(repo, source);
    expect(result.changed).toBe(true);
    expect(commits).toHaveLength(1);
    expect(result.changedPaths).toEqual([
      "package.json",
      "voice-agent.ts",
      ...VOICE_AGENT_SOURCE_FILES.map((file) => `voice-agent/${file}`),
    ]);
    expect(files["voice-agent.ts"]).toBe(VOICE_AGENT_GUEST_SOURCE_FROM_REPO);
    expect(files["voice-agent/worker.ts"]).toBe("// worker.ts\n");
    const dependencies = JSON.parse(files["package.json"]!).dependencies;
    expect(dependencies[VOICE_AGENT_PACKAGE_NAME]).toBeUndefined();
    expect(dependencies.zod).toBe("4.5.4");
    expect(dependencies.iterate).toBe(ITERATE);
  });

  it("commits nothing when the repo already carries this exact copy, and only the file that changed otherwise", async () => {
    const { repo, commits } = fakeRepo({
      "package.json": manifest({ iterate: ITERATE, zod: "4.5.4" }),
      "voice-agent.ts": VOICE_AGENT_GUEST_SOURCE_FROM_REPO,
      ...Object.fromEntries(
        VOICE_AGENT_SOURCE_FILES.map((file) => [`voice-agent/${file}`, source[file]]),
      ),
    });
    const same = await installVoiceAgentFromSource(repo, source);
    expect(same.changed).toBe(false);
    expect(commits).toHaveLength(0);
    const edited = await installVoiceAgentFromSource(repo, {
      ...source,
      "face.ts": "// face.ts, edited\n",
    });
    expect(edited.changed).toBe(true);
    expect(edited.changedPaths).toEqual(["voice-agent/face.ts"]);
  });

  it("can install an isolated source guest without changing the project's package guest", async () => {
    const customGuest = "export { CustomVoice } from './custom.ts';\n";
    const { repo, files } = fakeRepo({
      "package.json": manifest({
        iterate: ITERATE,
        [VOICE_AGENT_PACKAGE_NAME]: PINNED,
        zod: "4.5.4",
      }),
      "voice-agent.ts": customGuest,
    });
    const result = await installVoiceAgentFromSource(repo, source, {
      guestFile: "kit-voice-agent.ts",
      sourceDirectory: "kit-voice-agent",
      preservePublishedVoiceAgentDependency: true,
    });
    expect(result.changedPaths).toEqual([
      "kit-voice-agent.ts",
      ...VOICE_AGENT_SOURCE_FILES.map((file) => `kit-voice-agent/${file}`),
    ]);
    expect(files["voice-agent.ts"]).toBe(customGuest);
    expect(JSON.parse(files["package.json"]!).dependencies[VOICE_AGENT_PACKAGE_NAME]).toBe(PINNED);
    expect(files["kit-voice-agent.ts"]).toBe(
      'export { default, VoiceAgentFacet } from "./kit-voice-agent/worker.ts";\n',
    );
  });

  it("a from-source repo is left alone by the package install's keep mode and cleaned by prune", async () => {
    const { repo, files } = fakeRepo({
      "package.json": manifest({ iterate: ITERATE, zod: "4.5.4" }),
    });
    await installVoiceAgentFromSource(repo, source);
    const kept = await installVoiceAgent(repo, { existing: "keep" });
    expect(files["voice-agent.ts"]).toBe(VOICE_AGENT_GUEST_SOURCE_FROM_REPO);
    expect(kept.changedPaths).toEqual(["package.json"]);
    expect(await legacyGuestPaths(repo)).toEqual(
      VOICE_AGENT_SOURCE_FILES.map((file) => `voice-agent/${file}`),
    );
    const removed = await removeLegacyGuest(repo);
    expect(removed?.paths).toHaveLength(VOICE_AGENT_SOURCE_FILES.length);
    expect(files["voice-agent/worker.ts"]).toBeUndefined();
  });
});
