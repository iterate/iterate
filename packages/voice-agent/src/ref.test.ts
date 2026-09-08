import type { StatefulDynamicWorkerRef, StatelessDynamicWorkerRef } from "iterate/sdk";
import { expect, it } from "vitest";
import { voiceAgentEntrypointRef, voiceAgentFacetRef } from "./ref.ts";

it("spells the SDK's worker ref shapes, so workers.get accepts them", () => {
  /* The assertions that matter are the two `satisfies`: this file is in the
   * package's own typecheck, which has the SDK's types, while ref.ts stays
   * free of them for callers that do not. */
  const entrypoint = voiceAgentEntrypointRef satisfies StatelessDynamicWorkerRef;
  const facet = voiceAgentFacetRef("/agents/voice/probe") satisfies StatefulDynamicWorkerRef;
  expect(entrypoint.source.createWorker.files.include).toEqual(["package.json"]);
  expect(facet.className).toBe("VoiceAgentFacet");
  /* The durable key from before the package: a migrated project keeps its facet state. */
  expect(facet.durableWorkerKey).toBe("voice-agent-facet");
  expect(facet.path).toBe("/agents/voice/probe");
});
