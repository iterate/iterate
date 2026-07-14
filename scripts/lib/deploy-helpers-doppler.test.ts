import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));

import { deleteDopplerSecretIfPresent } from "./deploy-helpers.ts";

const project = "os";
const config = "preview_4";
const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";

function dopplerResult(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

afterEach(() => vi.clearAllMocks());

describe("deleteDopplerSecretIfPresent", () => {
  it("does nothing when the retired source is already absent", () => {
    spawnSync.mockReturnValueOnce(dopplerResult("{}"));

    expect(deleteDopplerSecretIfPresent({ project, config, secretName })).toBe(false);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("deletes an existing source and verifies the resolved config no longer carries it", () => {
    spawnSync
      .mockReturnValueOnce(dopplerResult(JSON.stringify({ [secretName]: "retired" })))
      .mockReturnValueOnce(dopplerResult(""))
      .mockReturnValueOnce(dopplerResult("{}"));

    expect(deleteDopplerSecretIfPresent({ project, config, secretName })).toBe(true);
    expect(spawnSync.mock.calls[1]?.[1]).toEqual([
      "secrets",
      "delete",
      secretName,
      "--project",
      project,
      "--config",
      config,
      "--yes",
      "--silent",
    ]);
  });

  it("fails closed when Doppler rejects the deletion", () => {
    spawnSync
      .mockReturnValueOnce(dopplerResult(JSON.stringify({ [secretName]: "retired" })))
      .mockReturnValueOnce(dopplerResult("", 1));

    expect(() => deleteDopplerSecretIfPresent({ project, config, secretName })).toThrow(
      /Failed to delete retired Doppler secret/,
    );
  });

  it("fails closed when the resolved config still inherits the retired source", () => {
    const inherited = JSON.stringify({ [secretName]: "retired" });
    spawnSync
      .mockReturnValueOnce(dopplerResult(inherited))
      .mockReturnValueOnce(dopplerResult(""))
      .mockReturnValueOnce(dopplerResult(inherited));

    expect(() => deleteDopplerSecretIfPresent({ project, config, secretName })).toThrow(
      /Retired Doppler secret remains after deletion/,
    );
  });
});
