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
const TEMPLATE_REQUEST = {
  type: "events.iterate.com/repos/create-requested" as const,
  payload: {
    type: "github-public-template" as const,
    owner: "iterate",
    path: "configs/with-voice",
    ref: "main",
    repo: "iterate",
  },
};
const RESOLVED_TEMPLATE = {
  commitSha: "a".repeat(40),
  owner: "iterate",
  path: "configs/with-voice",
  ref: "main",
  repo: "iterate",
};

function makeHarness() {
  const creationQueue = { calls: 0, queued: false };
  const createEmpty: { impl: () => Promise<typeof CREATED_ARTIFACT> } = {
    impl: () => {
      throw new Error("must not create an artifact in this scenario");
    },
  };
  const createTemplate: { impl: () => Promise<typeof CREATED_ARTIFACT> } = {
    impl: async () => {
      throw new Error("must not create a template artifact in this scenario");
    },
  };
  const resolveTemplate: { calls: number; impl: () => Promise<typeof RESOLVED_TEMPLATE> } = {
    calls: 0,
    impl: async () => {
      throw new Error("must not resolve a template in this scenario");
    },
  };
  const harness = makeProcessorHarness<RepoProcessorContract, RepoProcessor>({
    path: HOME,
    createProcessor: (deps) =>
      new RepoProcessor({
        ...deps,
        projectId: "prj_1",
        enqueueCreation: async () => {
          if (creationQueue.queued) return;
          creationQueue.queued = true;
          creationQueue.calls += 1;
        },
        createEmptyArtifact: () => createEmpty.impl(),
        createGithubTemplateArtifact: () => createTemplate.impl(),
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
        resolveGithubTemplateSource: async () => {
          resolveTemplate.calls += 1;
          return await resolveTemplate.impl();
        },
      }),
  });
  return { ...harness, creationQueue, createEmpty, createTemplate, resolveTemplate };
}

describe("RepoProcessor eviction recovery", () => {
  it("redelivers empty creation interrupted by a deployment without poisoning the repo", async () => {
    const h = makeHarness();
    let calls = 0;
    h.createEmpty.impl = async () => {
      calls += 1;
      if (calls === 1) {
        const reset = Object.assign(
          new Error("Durable Object reset because its code was updated."),
          { durableObjectReset: true },
        );
        throw new Error("Artifact client could not create the repo", { cause: reset });
      }
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);

    await expect(h.settle()).rejects.toThrow("Artifact client could not create the repo");
    expect(h.events("events.iterate.com/repos/create-failed")).toHaveLength(0);

    await h.settle();

    expect(calls).toBe(2);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("redelivers a still-materializing empty Artifact without recording failure", async () => {
    const h = makeHarness();
    let calls = 0;
    h.createEmpty.impl = async () => {
      calls += 1;
      if (calls === 1) throw new RepoNotSeededError("Artifact import is still in progress");
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);
    await expect(h.settle()).rejects.toThrow("Artifact import is still in progress");
    expect(calls).toBe(1);
    expect(h.events("events.iterate.com/repos/create-failed")).toHaveLength(0);

    await h.settle();

    expect(calls).toBe(2);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("redelivers an Artifacts infrastructure failure without poisoning the repo", async () => {
    const h = makeHarness();
    let calls = 0;
    h.createEmpty.impl = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("An internal error occurred."), {
          code: "INTERNAL_ERROR",
          name: "ArtifactsError",
        });
      }
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);

    await expect(h.settle()).rejects.toThrow("An internal error occurred.");
    expect(calls).toBe(1);
    expect(h.events("events.iterate.com/repos/create-failed")).toHaveLength(0);

    await h.settle();

    expect(calls).toBe(2);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("redelivers the property-stripped Artifacts 503 observed during preview bootstrap", async () => {
    const h = makeHarness();
    let calls = 0;
    h.createEmpty.impl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP Error: 503 Service Unavailable");
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);

    await expect(h.settle()).rejects.toThrow("HTTP Error: 503 Service Unavailable");
    expect(calls).toBe(1);
    expect(h.events("events.iterate.com/repos/create-failed")).toHaveLength(0);

    await h.settle();

    expect(calls).toBe(2);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("re-drives an interrupted empty creation obligation after the keepalive alarm", async () => {
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

  it("recovery materializes the journaled commit without resolving a moved ref again", async () => {
    const h = makeHarness();
    h.resolveTemplate.impl = async () => RESOLVED_TEMPLATE;
    h.createTemplate.impl = async () => {
      throw new RepoNotSeededError("template Artifact is still materializing");
    };
    await h.append(TEMPLATE_REQUEST);

    expect(h.resolveTemplate.calls).toBe(0);
    expect(h.creationQueue).toEqual({ calls: 1, queued: true });
    await expect(h.processor().driveCreation(h.state())).rejects.toThrow(
      "template Artifact is still materializing",
    );
    await h.settle();
    expect(h.events("events.iterate.com/repos/template-source-resolved")).toHaveLength(1);
    expect(h.resolveTemplate.calls).toBe(1);
    h.crash();
    await h.runner().catchUp();

    h.resolveTemplate.impl = async () => {
      throw new Error("recovery must not resolve the ref again");
    };
    h.createTemplate.impl = async () => CREATED_ARTIFACT;
    await h.processor().driveCreation(h.state());
    await h.settle();

    expect(h.resolveTemplate.calls).toBe(1);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
    expect(h.state().templateSource).toEqual(RESOLVED_TEMPLATE);
  });

  it("reads the journaled source when the local fold has not observed its append", async () => {
    const h = makeHarness();
    h.resolveTemplate.impl = async () => RESOLVED_TEMPLATE;
    h.createTemplate.impl = async () => {
      throw new RepoNotSeededError("template Artifact is still materializing");
    };
    await h.append(TEMPLATE_REQUEST);
    await expect(h.processor().driveCreation(h.state())).rejects.toThrow(
      "template Artifact is still materializing",
    );

    // Do not settle the source append into the processor. This is the alarm
    // retry window Cursor found: the stream has the immutable SHA while the
    // runner snapshot still reports templateSource: null.
    expect(h.state().templateSource).toBeNull();
    h.resolveTemplate.impl = async () => {
      throw new Error("the journaled source must win over the moved ref");
    };
    h.createTemplate.impl = async () => CREATED_ARTIFACT;

    await h.processor().driveCreation(h.state());
    await h.settle();

    expect(h.resolveTemplate.calls).toBe(1);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
    expect(h.state().templateSource).toEqual(RESOLVED_TEMPLATE);
  });
});
