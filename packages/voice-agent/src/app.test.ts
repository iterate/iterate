import { describe, expect, it } from "vitest";
import { VoiceAgentApp } from "./app.ts";
import { voiceAgentEntrypointRef } from "./ref.ts";

/** A project handle that records what was dialed and whether it was released. */
function fakeEnv(guest: Partial<Record<"setupVoiceAgent" | "removeVoiceAgent" | "say", unknown>>) {
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

const request = (app: string | null) =>
  new Request("https://voice--p.iterate.app/", {
    headers: app === null ? {} : { "x-iterate-app": app },
  });

describe("VoiceAgentApp", () => {
  it("answers only its app slug, and says the client is not built yet", async () => {
    const app = VoiceAgentApp.create(fakeEnv({}).env);
    expect(await app.fetch(request(null))).toBeNull();
    expect(await app.fetch(request("todo"))).toBeNull();
    const response = await app.fetch(request("voice"));
    expect(response?.status).toBe(501);
    expect(await response?.text()).toMatch(/not built yet/);

    const renamed = VoiceAgentApp.create(fakeEnv({}).env, { appSlug: "talk" });
    expect(await renamed.fetch(request("voice"))).toBeNull();
    expect((await renamed.fetch(request("talk")))?.status).toBe(501);
  });

  it("dials the guest through the entrypoint ref and releases both handles", async () => {
    const { env, log } = fakeEnv({
      setupVoiceAgent: async (options: { streamPath?: string }) => ({
        streamPath: options.streamPath ?? "/agents/voice/fresh",
        warmMs: 12,
      }),
      removeVoiceAgent: async (options: { streamPath: string }) => options,
      say: async (options: { streamPath: string; text: string }) => ({
        streamPath: options.streamPath,
        offset: options.text.length,
      }),
    });
    const app = VoiceAgentApp.create(env);
    expect(await app.setup({ streamPath: "/agents/voice/x", provider: "openai" })).toEqual({
      streamPath: "/agents/voice/x",
      warmMs: 12,
    });
    expect(await app.setup()).toEqual({ streamPath: "/agents/voice/fresh", warmMs: 12 });
    expect(await app.remove({ streamPath: "/agents/voice/x" })).toEqual({
      streamPath: "/agents/voice/x",
    });
    expect(
      await app.say({ streamPath: "/agents/voice/x", text: "bye now", thenHangUp: true }),
    ).toEqual({ streamPath: "/agents/voice/x", offset: 7 });
    expect(log).toEqual(
      Array(4).fill(["workers.get entrypoint ref", "guest disposed", "project disposed"]).flat(),
    );
  });

  it("releases the handles when the guest throws, and lets the error through", async () => {
    const { env, log } = fakeEnv({
      setupVoiceAgent: async () => {
        throw new Error('voice-agent setup requires secret "/secrets/openai" with material');
      },
    });
    await expect(VoiceAgentApp.create(env).setup()).rejects.toThrow(/requires secret/);
    expect(log).toEqual(["workers.get entrypoint ref", "guest disposed", "project disposed"]);
  });
});
