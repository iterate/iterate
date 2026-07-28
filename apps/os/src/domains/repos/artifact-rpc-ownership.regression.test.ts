import { expect, test, vi } from "vitest";
import { replaceArtifactWithEmptyRepo } from "./artifact-replacement.ts";

function artifactsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

test.fails("DESIRED: deletion polling disposes each temporary repository handle", async () => {
  const calls: string[] = [];
  const disposeRepo = vi.fn(() => {
    calls.push("dispose:get:present");
  });
  const artifacts = {
    create: vi.fn(async () => {
      calls.push("create");
      return {} as ArtifactsCreateRepoResult;
    }),
    delete: vi.fn(async () => {
      calls.push("delete");
      return true;
    }),
    get: vi
      .fn<Artifacts["get"]>()
      .mockImplementationOnce(async () => {
        calls.push("get:present");
        return { [Symbol.dispose]: disposeRepo } as unknown as ArtifactsRepo;
      })
      .mockImplementationOnce(async () => {
        calls.push("get:missing");
        throw artifactsError("NOT_FOUND");
      }),
  };

  await replaceArtifactWithEmptyRepo(artifacts, "repo", {
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  expect(calls).toEqual(["delete", "get:present", "dispose:get:present", "get:missing", "create"]);
  expect(disposeRepo).toHaveBeenCalledOnce();
});

test.fails("DESIRED: cleanup failure does not masquerade as the repository deletion barrier", async () => {
  const cleanupError = artifactsError("NOT_FOUND");
  const disposeRepo = vi.fn(() => {
    throw cleanupError;
  });
  const artifacts = {
    create: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
    delete: vi.fn(async () => true),
    get: vi
      .fn<Artifacts["get"]>()
      .mockResolvedValueOnce({ [Symbol.dispose]: disposeRepo } as unknown as ArtifactsRepo)
      .mockRejectedValueOnce(artifactsError("NOT_FOUND")),
  };
  const sleep = vi.fn(async () => undefined);

  await replaceArtifactWithEmptyRepo(artifacts, "repo", {
    pollIntervalMs: 17,
    sleep,
  });

  expect(disposeRepo).toHaveBeenCalledOnce();
  expect(artifacts.get).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(17);
  expect(artifacts.create).toHaveBeenCalledOnce();
});
