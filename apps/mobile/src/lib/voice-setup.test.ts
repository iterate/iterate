import {
  VOICE_AGENT_GUEST_SOURCE,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_PACKAGE_SPEC,
  VOICE_AGENT_ZOD_SPEC,
} from "@iterate-com/voice-agent";
import { expect, test } from "vitest";
import {
  chatVoiceStreamPath,
  ensureVoiceAgentInstalled,
  ensureVoiceAgentSetup,
  setupMarker,
  voiceSetupConfig,
  MOBILE_VOICE_SETUP,
} from "./voice-setup.ts";

const packageJson = (dependencies: Record<string, string>) =>
  JSON.stringify({ name: "a-project", dependencies }, null, 2);

/** A repo that already has the agent: both dependency lines and the re-export — the common case. */
const repoWithTemplate = {
  readFile: async ({ path }: { path: string }) =>
    path === "package.json"
      ? {
          commitOid: "0".repeat(40),
          content: packageJson({
            [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
            zod: VOICE_AGENT_ZOD_SPEC,
          }),
        }
      : path === "voice-agent.ts"
        ? { commitOid: "0".repeat(40), content: VOICE_AGENT_GUEST_SOURCE }
        : null,
  commitFiles: async () => {
    throw new Error("must not commit over an installed package");
  },
};

test("the marker is stable for one stream and distinct across streams and configs", () => {
  const base = voiceSetupConfig();
  expect(setupMarker("/agents/voice/mobile-a", base)).toBe(
    setupMarker("/agents/voice/mobile-a", base),
  );
  expect(setupMarker("/agents/voice/mobile-a", base)).not.toBe(
    setupMarker("/agents/voice/mobile-b", base),
  );
  /* Each chat has its own line, so two chats never share a marker. */
  expect(setupMarker(chatVoiceStreamPath("/agents/mobile/1"), voiceSetupConfig())).not.toBe(
    setupMarker(chatVoiceStreamPath("/agents/mobile/2"), voiceSetupConfig()),
  );
});

test("a chat's voice line derives from its path without legacy routing settings", () => {
  expect(chatVoiceStreamPath("/agents/mobile/1756422")).toBe("/agents/voice/chat/mobile/1756422");
  expect("colleaguePath" in voiceSetupConfig()).toBe(false);
  expect("clientTakesTurns" in voiceSetupConfig()).toBe(false);
  expect("greeting" in voiceSetupConfig()).toBe(false);
});

test("a matching marker skips setup entirely", async () => {
  const calls: unknown[] = [];
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath: "/agents/voice/mobile-x",
    readMarker: async () => setupMarker("/agents/voice/mobile-x", voiceSetupConfig()),
    writeMarker: async () => {
      throw new Error("must not rewrite a matching marker");
    },
  });
  expect(calls).toEqual([]);
});

test("a missing marker runs setup with the full config, then records the marker", async () => {
  const calls: any[] = [];
  const written: [string, string][] = [];
  const streamPath = chatVoiceStreamPath("/agents/mobile/device-1");
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath,
    readMarker: async () => null,
    writeMarker: async (path, marker) => {
      written.push([path, marker]);
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    streamPath: "/agents/voice/chat/mobile/device-1",
    instructions: MOBILE_VOICE_SETUP.instructions,
  });
  expect(calls[0].tools.map((tool: any) => tool.name)).toEqual(["hang_up"]);
  expect(written).toEqual([[streamPath, setupMarker(streamPath, voiceSetupConfig())]]);
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
      readMarker: async () => null,
      writeMarker: async (_, marker) => {
        written.push(marker);
      },
    }),
  ).rejects.toThrow("secret missing");
  expect(written).toEqual([]);
});

test("a project without the agent gets the dependency lines and voice-agent.ts, once", async () => {
  const commits: any[] = [];
  const withoutPackage = {
    readFile: async ({ path }: { path: string }) =>
      path === "package.json"
        ? {
            commitOid: "0".repeat(40),
            content: packageJson({ iterate: "https://pkg.pr.new/iterate/iterate/iterate@main" }),
          }
        : null,
    commitFiles: async (input: any) => {
      commits.push(input);
      return {
        commitOid: "1".repeat(40),
        changedPaths: ["package.json", "voice-agent.ts"],
        noChanges: false,
      };
    },
  };
  await ensureVoiceAgentInstalled(withoutPackage);
  expect(commits).toHaveLength(1);
  expect(commits[0].changes.map((c: any) => c.path)).toEqual(["package.json", "voice-agent.ts"]);
  expect(JSON.parse(commits[0].changes[0].content).dependencies).toEqual({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
    [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
    zod: VOICE_AGENT_ZOD_SPEC,
  });
  expect(commits[0].changes[1].content).toBe(VOICE_AGENT_GUEST_SOURCE);
  /* And what is present is never rewritten — a pin somebody chose, or a
   * voice-agent.ts holding an old committed copy: voicelab deploy owns
   * upgrades; an app must not move a project. */
  await ensureVoiceAgentInstalled(repoWithTemplate);
  await ensureVoiceAgentInstalled({
    ...repoWithTemplate,
    readFile: async ({ path }: { path: string }) =>
      path === "package.json"
        ? {
            commitOid: "0".repeat(40),
            content: packageJson({
              [VOICE_AGENT_PACKAGE_NAME]:
                "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@0123456789abcdef",
              zod: VOICE_AGENT_ZOD_SPEC,
            }),
          }
        : { commitOid: "0".repeat(40), content: "// the old committed agent\n" },
  });
});
