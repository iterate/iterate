import { describe, expect, it } from "vitest";
import { VoiceAgentApp } from "./app.ts";
import { voiceAgentEntrypointRef } from "./ref.ts";

/** A project handle that records what was dialed and whether it was released. */
function fakeEnv(
  guest: Partial<Record<"health" | "setupVoiceAgent" | "removeVoiceAgent", unknown>>,
) {
  const log: string[] = [];
  const env = {
    ITX: {
      get: async () => ({
        [Symbol.dispose]: () => {
          log.push("project disposed");
        },
        workers: {
          get: (ref: unknown) => {
            log.push(
              `workers.get ${ref === voiceAgentEntrypointRef ? "entrypoint ref" : "something else"}`,
            );
            return {
              ...guest,
              [Symbol.dispose]: () => {
                log.push("guest disposed");
              },
            };
          },
        },
      }),
    },
  };
  return { env, log };
}

describe("VoiceAgentApp", () => {
  it("dials the guest through the entrypoint ref and releases both handles", async () => {
    const { env, log } = fakeEnv({
      health: async () => ({ ok: true, projectId: "prj_1", buildCacheKey: "k" }),
      setupVoiceAgent: async (options: { streamPath?: string }) => ({
        streamPath: options.streamPath ?? "/agents/voice/fresh",
        warmMs: 12,
      }),
      removeVoiceAgent: async (options: { streamPath: string }) => options,
    });
    const app = VoiceAgentApp.create(env);
    expect(await app.health()).toEqual({ ok: true, projectId: "prj_1", buildCacheKey: "k" });
    expect(await app.setup({ streamPath: "/agents/voice/x", provider: "openai" })).toEqual({
      streamPath: "/agents/voice/x",
      warmMs: 12,
    });
    expect(await app.setup()).toEqual({ streamPath: "/agents/voice/fresh", warmMs: 12 });
    expect(await app.remove({ streamPath: "/agents/voice/x" })).toEqual({
      streamPath: "/agents/voice/x",
    });
    expect(log).toEqual(
      Array(4).fill(["workers.get entrypoint ref", "guest disposed", "project disposed"]).flat(),
    );
  });

  it("releases the handles when the guest throws, and lets the error through", async () => {
    const { env, log } = fakeEnv({
      health: async () => {
        throw new Error("build failed: Could not resolve zod");
      },
    });
    await expect(VoiceAgentApp.create(env).health()).rejects.toThrow(/build failed/);
    expect(log).toEqual(["workers.get entrypoint ref", "guest disposed", "project disposed"]);
  });
});
