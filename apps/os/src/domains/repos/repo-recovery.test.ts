// Focused repo-creation recovery through the shared processor harness.
// `crash()` is eviction; the durable keepalive alarm wakes the successor.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { RepoNotSeededError } from "./utils.ts";

const HOME = "/repos/config";
const CREATED_ARTIFACT = {
  artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
};
const EMPTY_REQUEST = {
  type: "events.iterate.com/repos/create-requested" as const,
  payload: { type: "empty" as const },
};

function makeHarness() {
  const createEmpty: { impl: () => Promise<typeof CREATED_ARTIFACT> } = {
    impl: () => {
      throw new Error("must not create an artifact in this scenario");
    },
  };
  const harness = makeProcessorHarness<RepoProcessorContract, RepoProcessor>({
    path: HOME,
    createProcessor: (deps) =>
      new RepoProcessor({
        ...deps,
        projectId: "prj_1",
        createEmptyArtifact: () => createEmpty.impl(),
        importPublicGithubArtifact: async () => {
          throw new Error("must not import in this scenario");
        },
        linkGithub: async () => {
          throw new Error("must not link in this scenario");
        },
        syncPrivateGithub: async () => {
          throw new Error("must not sync in this scenario");
        },
        syncFromGithubPush: async () => {
          throw new Error("must not sync a push in this scenario");
        },
        observeArtifactPush: () => {},
      }),
  });
  return { ...harness, createEmpty };
}

describe("RepoProcessor eviction recovery", () => {
  it("re-drives a transient creation error after revival without recording failure", async () => {
    const h = makeHarness();
    let calls = 0;
    h.createEmpty.impl = async () => {
      calls += 1;
      if (calls === 1) throw new RepoNotSeededError("Artifact import is still in progress");
      return CREATED_ARTIFACT;
    };

    await h.append(EMPTY_REQUEST);
    expect(calls).toBe(1);
    expect(h.events("events.iterate.com/repos/create-failed")).toHaveLength(0);

    h.crash();
    await h.advanceTime(KEEPALIVE_ALARM_LEAD_MS + 1);

    expect(calls).toBe(2);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("re-drives an interrupted creation obligation after the keepalive alarm", async () => {
    const h = makeHarness();
    h.createEmpty.impl = () => new Promise<never>(() => {});
    await h.append(EMPTY_REQUEST);

    h.crash();
    await h.settle();
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(0);

    h.createEmpty.impl = async () => CREATED_ARTIFACT;
    await h.advanceTime(KEEPALIVE_ALARM_LEAD_MS + 1);

    expect(h.events("events.iterate.com/stream/processor-revived")).toMatchObject([
      {
        payload: {
          processorSlug: RepoProcessorContract.slug,
          revivals: 1,
          version: "test-harness",
        },
      },
    ]);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });
});
