// git-wire.test.ts — the wire's one refusal that matters to `itx.repos`: a TRUNCATED pkt-line body is
// an outage, never an empty ref list (an empty list reads as "unborn repo" → "no file", which would
// silently blank the config worker's source).

import { afterEach, expect, test, vi } from "vitest";
import { createGitWireTransport } from "./git-wire.ts";

afterEach(() => vi.unstubAllGlobals());

test("a pkt-line body cut mid-header rejects instead of yielding an empty ref list", async () => {
  vi.stubGlobal("fetch", async () => new Response("00", { status: 200 }));
  const transport = createGitWireTransport({
    remote: "https://account.artifacts.example/git/ns/prj.config.git",
    token: "t",
  });
  await expect(transport.lsRefs(["refs/heads/main"])).rejects.toThrow(/truncated pkt-line/);
});
