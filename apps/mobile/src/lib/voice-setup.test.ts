import { expect, test } from "vitest";
import {
  chatVoiceStreamPath,
  ensureVoiceAgentInstalled,
  ensureVoiceAgentSetup,
  mobileVoiceStreamPath,
  setupMarker,
  voiceSetupConfig,
  MOBILE_VOICE_SETUP,
} from "./voice-setup.ts";
import { VOICE_AGENT_TEMPLATE_FILES } from "./voice-template.generated.ts";

/** A repo that already has the template — the common case. */
const repoWithTemplate = {
  readFile: async () => ({ content: "// installed" }),
  commitFiles: async () => {
    throw new Error("must not commit over an installed template");
  },
};

test("the marker is stable for one stream and distinct across streams and configs", () => {
  const base = voiceSetupConfig(null);
  expect(setupMarker("/agents/voice/mobile-a", base)).toBe(
    setupMarker("/agents/voice/mobile-a", base),
  );
  expect(setupMarker("/agents/voice/mobile-a", base)).not.toBe(
    setupMarker("/agents/voice/mobile-b", base),
  );
  /* Re-pointing a line at a different chat is a config change: the marker
   * must miss, or the certificate keeps the old colleague forever. */
  expect(setupMarker("/agents/voice/chat/mobile/1", voiceSetupConfig("/agents/mobile/1"))).not.toBe(
    setupMarker("/agents/voice/chat/mobile/1", voiceSetupConfig("/agents/mobile/2")),
  );
});

test("a chat's voice line derives from its path; the chat itself is the colleague", () => {
  expect(chatVoiceStreamPath("/agents/mobile/1756422")).toBe("/agents/voice/chat/mobile/1756422");
  expect(voiceSetupConfig("/agents/mobile/1756422")).toMatchObject({
    colleaguePath: "/agents/mobile/1756422",
    colleague: true,
  });
  /* The device's own line sends no colleaguePath at all — absent means the
   * facet derives its private voice-notes desk. */
  expect("colleaguePath" in voiceSetupConfig(null)).toBe(false);
});

test("a matching marker skips setup entirely", async () => {
  const calls: unknown[] = [];
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath: "/agents/voice/mobile-x",
    colleaguePath: null,
    readMarker: async () => setupMarker("/agents/voice/mobile-x", voiceSetupConfig(null)),
    writeMarker: async () => {
      throw new Error("must not rewrite a matching marker");
    },
  });
  expect(calls).toEqual([]);
});

test("a missing marker runs setup with the full config, then records the marker", async () => {
  const calls: any[] = [];
  const written: [string, string][] = [];
  const streamPath = mobileVoiceStreamPath("device-1");
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath,
    colleaguePath: null,
    readMarker: async () => null,
    writeMarker: async (path, marker) => {
      written.push([path, marker]);
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    streamPath: "/agents/voice/mobile-device-1",
    clientTakesTurns: true,
    colleague: true,
    instructions: MOBILE_VOICE_SETUP.instructions,
  });
  expect(calls[0].tools.map((tool: any) => tool.name)).toEqual(["hang_up"]);
  expect(written).toEqual([[streamPath, setupMarker(streamPath, voiceSetupConfig(null))]]);
});

test("a per-chat setup sends the chat as colleaguePath", async () => {
  const calls: any[] = [];
  const streamPath = chatVoiceStreamPath("/agents/mobile/42");
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath,
    colleaguePath: "/agents/mobile/42",
    readMarker: async () => null,
    writeMarker: async () => {},
  });
  expect(calls[0]).toMatchObject({
    streamPath: "/agents/voice/chat/mobile/42",
    colleaguePath: "/agents/mobile/42",
  });
});

test("a failed setup writes no marker, so the next tap retries", async () => {
  const written: string[] = [];
  await expect(
    ensureVoiceAgentSetup({
      workers: {
        get: () => ({
          setupVoiceAgent: async () => {
            throw new Error("secret missing");
          },
        }),
      },
      repo: repoWithTemplate,
      streamPath: "/agents/voice/mobile-x",
      colleaguePath: null,
      readMarker: async () => null,
      writeMarker: async (_, marker) => {
        written.push(marker);
      },
    }),
  ).rejects.toThrow("secret missing");
  expect(written).toEqual([]);
});

test("a project with no voice agent gets the embedded template committed, once", async () => {
  const commits: any[] = [];
  const empty = {
    readFile: async () => null,
    commitFiles: async (input: any) => {
      commits.push(input);
      return {};
    },
  };
  await ensureVoiceAgentInstalled(empty);
  expect(commits).toHaveLength(1);
  expect(commits[0].changes.map((c: any) => c.path)).toContain("voice-agent.ts");
  /* The embedded template is the deploy walk's result: entry point plus
   * every relative import, flat. */
  expect(VOICE_AGENT_TEMPLATE_FILES.map((f) => f.path).sort()).toEqual([
    "face.ts",
    "pcm.ts",
    "viseme-model.generated.ts",
    "viseme.ts",
    "voice-agent.ts",
  ]);
  /* And a present template is never overwritten — voicelab deploy owns
   * upgrades; an app must not downgrade. */
  await ensureVoiceAgentInstalled(repoWithTemplate);
});
