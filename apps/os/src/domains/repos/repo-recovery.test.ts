// Focused repo-creation recovery through the shared processor harness.
// `crash()` is eviction; the durable keepalive alarm wakes the successor.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const HOME = "/repos/config";
const CREATED_ARTIFACT = {
  artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
};
const PRIVATE_REQUEST = {
  type: "events.iterate.com/repos/create-requested" as const,
  payload: {
    type: "github-private" as const,
    connection: "installation-1",
    owner: "iterate",
    repo: "private-config",
  },
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
        enqueueEmptyCreation: async () => {},
        recordSeededHead: () => {},
        createEmptyArtifact: () => createEmpty.impl(),
        createPublicGithubTemplateArtifact: async () => {
          throw new Error("must not create from a template in this scenario");
        },
        importPublicGithubArtifact: async () => {
          throw new Error("must not import in this scenario");
        },
        linkGithub: async () => {},
        syncPrivateGithub: async () => {},
        syncFromGithubPush: async () => {
          throw new Error("must not sync a push in this scenario");
        },
        observeArtifactPush: () => {},
      }),
  });
  return { ...harness, createEmpty };
}

describe("RepoProcessor long-creation eviction recovery", () => {
  it("re-drives an interrupted private creation obligation after the keepalive alarm", async () => {
    const h = makeHarness();
    h.createEmpty.impl = () => new Promise<never>(() => {});
    await h.append(PRIVATE_REQUEST);

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
