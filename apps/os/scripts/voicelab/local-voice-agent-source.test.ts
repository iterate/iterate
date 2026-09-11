import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildLocalVoiceAgentArtifact,
  localVoiceAgentArtifactHash,
} from "./local-voice-agent-source.ts";

describe("buildLocalVoiceAgentArtifact", () => {
  it("bundles the checked-out worker while retaining only platform dependencies", async () => {
    const artifact = await buildLocalVoiceAgentArtifact();
    const body = artifact.source.slice(artifact.source.indexOf("\n") + 1);

    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash("sha256").update(body).digest("hex")).toBe(artifact.sha256);
    expect(artifact.source).toContain('from "iterate/sdk"');
    expect(artifact.source).toContain('from "zod"');
    expect(artifact.source).not.toContain("@iterate-com/voice-agent");
    expect(artifact.source).not.toMatch(/from "\.\.?\//);
    expect(artifact.source).toContain("VoiceAgentFacet");
    expect(localVoiceAgentArtifactHash(artifact.source)).toBe(artifact.sha256);
    expect(localVoiceAgentArtifactHash("export default {};")).toBeNull();
  });
});
