import { describe, expect, test, vi } from "vitest";
import {
  authenticateProjectBearer,
  handleKitVoiceRequest,
  loadProjectBearerCredential,
  readKitDeviceIdentity,
  type KitVoiceRouteDependencies,
} from "./routes.ts";

function dependencies(overrides: Partial<KitVoiceRouteDependencies> = {}) {
  return {
    handlePcm: vi.fn(async () => new Response("pcm")),
    readMode: vi.fn(async () => "tone" as const),
    ...overrides,
  };
}

describe("kit voice userspace routes", () => {
  test("reports the currently selected provider mode without opening a socket", async () => {
    const deps = dependencies();
    const response = await handleKitVoiceRequest(
      new Request("https://kit--demo.iterate.app/health"),
      deps,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "tone",
      ok: true,
      service: "iterate-kit-voice",
    });
    expect(deps.handlePcm).not.toHaveBeenCalled();
  });

  test("does not proxy Cap'n Web through the PCM userspace app", async () => {
    const response = await handleKitVoiceRequest(
      new Request("https://kit--demo.iterate.app/api?device=m5sticks3", {
        headers: {
          authorization: "Bearer device-token",
          upgrade: "websocket",
          "x-iterate-app": "kit",
          "x-iterate-worker-dispatch": '{"ref":"internal"}',
        },
      }),
      dependencies(),
    );

    expect(response.status).toBe(404);
  });

  test("delegates only the dedicated PCM path to the binary proxy", async () => {
    const deps = dependencies();
    const request = new Request("https://kit--demo.iterate.app/pcm");
    const response = await handleKitVoiceRequest(request, deps);

    expect(await response.text()).toBe("pcm");
    expect(deps.handlePcm).toHaveBeenCalledWith(request);
  });

  test("requires the exact scoped project id and readable project API key", async () => {
    await expect(
      authenticateProjectBearer(
        new Request("https://kit.invalid/pcm", {
          headers: {
            authorization: "Bearer project-key",
            "x-iterate-project-id": "prj_expected",
          },
        }),
        async () => ({ projectId: "prj_expected", projectToken: "project-key" }),
      ),
    ).resolves.toEqual({ projectId: "prj_expected" });

    for (const headers of [
      new Headers(),
      { authorization: "Bearer wrong", "x-iterate-project-id": "prj_expected" },
      { authorization: "Bearer project-key", "x-iterate-project-id": "prj_other" },
    ]) {
      await expect(
        authenticateProjectBearer(
          new Request("https://kit.invalid/pcm", { headers }),
          async () => ({ projectId: "prj_expected", projectToken: "project-key" }),
        ),
      ).resolves.toBeNull();
    }
  });

  test("requires one namespace-safe firmware device identity on PCM", () => {
    expect(
      readKitDeviceIdentity(
        new Request("https://kit.invalid/pcm", {
          headers: { "x-iterate-kit-device-id": "stackchan" },
        }),
      ),
    ).toBe("stackchan");

    for (const value of [
      null,
      "",
      "-stackchan",
      "stackchan-",
      "StackChan",
      "stack/chan",
      "stack chan",
      "a".repeat(64),
    ]) {
      const headers = new Headers();
      if (value !== null) headers.set("x-iterate-kit-device-id", value);
      expect(readKitDeviceIdentity(new Request("https://kit.invalid/pcm", { headers }))).toBeNull();
    }
  });

  test("settles the Cap'n Web project-id property before comparing the PCM credential", async () => {
    /*
     * Cap'n Web property reads are awaitable RPC expressions even though the
     * generated target interface describes the settled value as a string.
     * Comparing that expression object directly to the HTTP header rejects a
     * correct production credential with 401. This test deliberately models
     * the remote shape instead of the simpler string-valued unit-test fake.
     */
    const credential = await loadProjectBearerCredential({
      projectId: Promise.resolve("prj_expected"),
      secrets: {
        get: () => ({
          reveal: async () => "project-key",
        }),
      },
    });

    expect(credential).toEqual({
      projectId: "prj_expected",
      projectToken: "project-key",
    });
  });
});
