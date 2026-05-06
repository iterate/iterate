import { describe, expect, test } from "vitest";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { streamPathToAgentInstance } from "./iterate-agent-addressing.ts";

describe("streamPathToAgentInstance", () => {
  test("does not collapse path separators into literal punctuation", () => {
    expect(streamPathToAgentInstance("/agents/team/project" as StreamPath)).not.toBe(
      streamPathToAgentInstance("/agents/team-project" as StreamPath),
    );
    expect(streamPathToAgentInstance("/agents/team/project-chat" as StreamPath)).not.toBe(
      streamPathToAgentInstance("/agents/team-project/chat" as StreamPath),
    );
  });

  test("returns a URL path segment safe instance name", () => {
    expect(streamPathToAgentInstance("/a/b.c!/d" as StreamPath)).toMatch(/^stream-[0-9a-f]+$/);
  });
});
