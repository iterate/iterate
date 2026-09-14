import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./connect.ts", () => ({ connectProject: vi.fn() }));
vi.mock("@iterate-com/voice-agent", () => ({
  installVoiceAgent: vi.fn(),
  legacyGuestPaths: vi.fn(),
  removeLegacyGuest: vi.fn(),
}));

import { installVoiceAgent, legacyGuestPaths, removeLegacyGuest } from "@iterate-com/voice-agent";
import { connectProject } from "./connect.ts";
import { deploy } from "./deploy.ts";

const commitOid = "a".repeat(40);
const entrypointRef = {
  path: "/",
  props: { voiceAgentSourceCommitOid: commitOid },
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", ref: { commitOid }, type: "repo" },
    },
  },
  type: "stateless",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(installVoiceAgent).mockReset();
  vi.mocked(legacyGuestPaths).mockReset();
  vi.mocked(removeLegacyGuest).mockReset();
  vi.mocked(connectProject).mockReset();
});

describe("voicelab deploy prewarm", () => {
  it("prewarms precisely the installed pinned entrypoint without opening a voice conversation", async () => {
    const disposeProject = vi.fn();
    const disposeWorker = vi.fn();
    const disposeHealth = vi.fn();
    const health = { [Symbol.dispose]: disposeHealth, ok: true, buildCacheKey: "built-voice" };
    const worker = { [Symbol.dispose]: disposeWorker, health: vi.fn(async () => health) };
    const project = {
      [Symbol.dispose]: disposeProject,
      repo: {},
      workers: { get: vi.fn(() => worker) },
    };
    vi.mocked(connectProject).mockResolvedValue(project as never);
    vi.mocked(installVoiceAgent).mockResolvedValue({
      changed: true,
      changedPaths: ["package.json", "voice-agent.ts"],
      commitOid,
      entrypointRef,
      spec: "https://pkg.pr.new/example/voice-agent@sha",
    });
    vi.mocked(legacyGuestPaths).mockResolvedValue([]);

    await deploy({ project: "voice-proof" });

    expect(project.workers.get).toHaveBeenCalledTimes(1);
    expect(project.workers.get).toHaveBeenCalledWith(entrypointRef);
    expect(worker.health).toHaveBeenCalledOnce();
    expect(disposeHealth).toHaveBeenCalledOnce();
    expect(disposeWorker).toHaveBeenCalledOnce();
    expect(disposeProject).toHaveBeenCalledOnce();
    expect(removeLegacyGuest).not.toHaveBeenCalled();
  });

  it("prewarms the later pinned commit when legacy pruning creates one", async () => {
    const disposeProject = vi.fn();
    const disposeWorker = vi.fn();
    const worker = {
      [Symbol.dispose]: disposeWorker,
      health: vi.fn(async () => ({ ok: true, buildCacheKey: "built-pruned" })),
    };
    const project = {
      [Symbol.dispose]: disposeProject,
      repo: {},
      workers: { get: vi.fn(() => worker) },
    };
    const prunedCommitOid = "b".repeat(40);
    vi.mocked(connectProject).mockResolvedValue(project as never);
    vi.mocked(installVoiceAgent).mockResolvedValue({
      changed: true,
      changedPaths: ["package.json", "voice-agent.ts"],
      commitOid,
      entrypointRef,
      spec: "https://pkg.pr.new/example/voice-agent@sha",
    });
    vi.mocked(removeLegacyGuest).mockResolvedValue({
      commitOid: prunedCommitOid,
      paths: ["face.ts"],
    });

    await deploy({ project: "voice-proof", pruneLegacy: true });

    expect(project.workers.get).toHaveBeenCalledWith({
      ...entrypointRef,
      props: { voiceAgentSourceCommitOid: prunedCommitOid },
      source: {
        createWorker: {
          ...entrypointRef.source.createWorker,
          files: {
            ...entrypointRef.source.createWorker.files,
            ref: { commitOid: prunedCommitOid },
          },
        },
      },
    });
    expect(worker.health).toHaveBeenCalledOnce();
    expect(disposeWorker).toHaveBeenCalledOnce();
    expect(disposeProject).toHaveBeenCalledOnce();
  });

  it("reports a post-commit prewarm failure without attempting to undo the installed source", async () => {
    const disposeProject = vi.fn();
    const disposeWorker = vi.fn();
    const worker = {
      [Symbol.dispose]: disposeWorker,
      health: vi.fn(async () => {
        throw new Error("bundler unavailable");
      }),
    };
    const project = {
      [Symbol.dispose]: disposeProject,
      repo: { commitFiles: vi.fn() },
      workers: { get: vi.fn(() => worker) },
    };
    vi.mocked(connectProject).mockResolvedValue(project as never);
    vi.mocked(installVoiceAgent).mockResolvedValue({
      changed: true,
      changedPaths: ["package.json", "voice-agent.ts"],
      commitOid,
      entrypointRef,
      spec: "https://pkg.pr.new/example/voice-agent@sha",
    });
    vi.mocked(legacyGuestPaths).mockResolvedValue([]);

    await expect(deploy({ project: "voice-proof" })).rejects.toThrow(
      `voice agent install at ${commitOid} succeeded, but prewarming its pinned worker failed`,
    );

    expect(project.workers.get).toHaveBeenCalledWith(entrypointRef);
    expect(worker.health).toHaveBeenCalledOnce();
    expect(disposeWorker).toHaveBeenCalledOnce();
    expect(project.repo.commitFiles).not.toHaveBeenCalled();
    expect(removeLegacyGuest).not.toHaveBeenCalled();
    expect(disposeProject).toHaveBeenCalledOnce();
  });
});
