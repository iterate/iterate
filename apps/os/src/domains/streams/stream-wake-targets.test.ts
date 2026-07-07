// Guards the derived-subscription model in stream-wake-targets.ts against the
// real processor contracts. The wake-targets module keeps slugs as string
// literals so the Stream Durable Object's worker never bundles the domain
// contract modules; this test is what makes that safe.

import { describe, expect, test } from "vitest";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "../agents/cloudflare-ai-processor-contract.ts";
import { OpenAiWsProcessorContract } from "../agents/openai-ws-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { SlackProcessorContract } from "../integrations/slack-processor-contract.ts";
import { ProjectProcessorContract } from "../projects/project-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import {
  derivedStreamProcessors,
  residentStreamProcessors,
  WAKEABLE_EVENT_NAMESPACE_KINDS,
  wakeableEventNamespace,
} from "./stream-wake-targets.ts";

const slugsOf = (targets: { slug: string }[]) => targets.map((target) => target.slug).sort();

describe("resident processors", () => {
  test("root stream hosts the project processor", () => {
    expect(residentStreamProcessors({ projectId: "prj_1", path: "/" })).toEqual([
      { slug: ProjectProcessorContract.slug, kind: "project" },
    ]);
  });

  test("agent streams host the agent family", () => {
    expect(slugsOf(residentStreamProcessors({ projectId: "prj_1", path: "/agents/main" }))).toEqual(
      [
        AgentProcessorContract.slug,
        CloudflareAiProcessorContract.slug,
        OpenAiWsProcessorContract.slug,
      ].sort(),
    );
  });

  test("slack agent streams additionally host the slack-agent processor", () => {
    expect(
      slugsOf(residentStreamProcessors({ projectId: "prj_1", path: "/agents/slack/c1/ts-2" })),
    ).toEqual(
      [
        AgentProcessorContract.slug,
        CloudflareAiProcessorContract.slug,
        OpenAiWsProcessorContract.slug,
        SlackAgentProcessorContract.slug,
      ].sort(),
    );
  });

  test("the slack integration stream hosts the webhook router on the project DO kind", () => {
    expect(residentStreamProcessors({ projectId: "prj_1", path: "/integrations/slack" })).toEqual([
      { slug: SlackProcessorContract.slug, kind: "project" },
    ]);
  });

  test("global streams and unclaimed paths have no residents", () => {
    expect(residentStreamProcessors({ projectId: null, path: "/" })).toEqual([]);
    expect(
      residentStreamProcessors({ projectId: null, path: "/integrations/slack-team-directory" }),
    ).toEqual([]);
    expect(residentStreamProcessors({ projectId: "prj_1", path: "/secrets/x" })).toEqual([]);
    expect(residentStreamProcessors({ projectId: "prj_1", path: "/sandboxes/cloudflare" })).toEqual(
      [],
    );
    // The bare /agents collection stream is NOT an agent Durable Object path;
    // waking an agent DO there fails its name validation forever.
    expect(residentStreamProcessors({ projectId: "prj_1", path: "/agents" })).toEqual([]);
  });
});

describe("wakeable event namespaces", () => {
  test("map keys are exactly the derivable actor processor slugs", () => {
    expect(Object.keys(WAKEABLE_EVENT_NAMESPACE_KINDS).sort()).toEqual(
      [
        CapabilityHostProcessorContract.slug,
        RepoProcessorContract.slug,
        SecretProcessorContract.slug,
      ].sort(),
    );
  });

  test("every owned event type of an actor contract parses to its slug", () => {
    for (const contract of [
      CapabilityHostProcessorContract,
      RepoProcessorContract,
      SecretProcessorContract,
    ]) {
      for (const type of Object.keys(contract.events)) {
        expect(wakeableEventNamespace(type)).toBe(contract.slug);
      }
    }
  });

  test("observer and vendor event types have no wakeable namespace", () => {
    expect(wakeableEventNamespace("events.iterate.com/agent/input-added")).toBeUndefined();
    expect(wakeableEventNamespace("events.iterate.com/slack/webhook-received")).toBeUndefined();
    expect(wakeableEventNamespace("events.iterate.com/project/created")).toBeUndefined();
    expect(wakeableEventNamespace("com.example.vendor/thing-happened")).toBeUndefined();
    expect(wakeableEventNamespace("not-a-type")).toBeUndefined();
  });

  test("actor processors consume nothing outside their own vocabulary", () => {
    // This is the property that makes namespace-derived wakes SUFFICIENT for
    // these processors: they never react to another processor's events, so
    // waking them on their own vocabulary (plus replay from the checkpoint)
    // delivers everything they consume. If this fails, the processor you
    // changed needs to become a path resident instead — see
    // stream-wake-targets.ts.
    for (const contract of [
      CapabilityHostProcessorContract,
      RepoProcessorContract,
      SecretProcessorContract,
    ]) {
      for (const consumed of contract.consumes) {
        const namespace = /^events\.iterate\.com\/([^/]+)\//.exec(consumed)?.[1];
        expect(
          namespace === contract.slug || namespace === "stream",
          `${contract.slug} consumes foreign event "${consumed}"`,
        ).toBe(true);
      }
    }
  });
});

describe("derived stream processors", () => {
  test("residents merge with journal-derived namespaces, deduped by slug", () => {
    expect(
      slugsOf(
        derivedStreamProcessors({
          projectId: "prj_1",
          path: "/",
          wakeableNamespaces: ["repo", "capability-host", "repo"],
        }),
      ),
    ).toEqual(["capability-host", "project", "repo"]);
  });

  test("unknown namespaces are ignored", () => {
    expect(
      derivedStreamProcessors({
        projectId: "prj_1",
        path: "/secrets/x",
        wakeableNamespaces: ["secret", "made-up"],
      }),
    ).toEqual([{ slug: "secret", kind: "secret" }]);
  });
});
