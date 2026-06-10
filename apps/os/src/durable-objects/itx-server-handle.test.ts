// Proves getServerItx end to end inside a real worker: a hand-built
// RequestContext (principal + D1 + ctx.exports) becomes an in-process Itx
// handle whose streams built-in reaches a REAL Stream Durable Object through
// the StreamsCapability loopback — no capnweb, no HTTP, exactly the SSR
// loader path. Also pins the auth boundary: narrowing fails for principals
// that may not hold the project, with the kernel's no-existence-probing
// "not found" wording.
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

// Must match itx-server-handle-test-entry.ts (importing the entry into the
// test isolate would drag worker-only modules into vitest's node side).
const PROJECT_ID = "proj__test__itxserver";
const PROJECT_SLUG = "itx-server-demo";

type ListResult = { ok: true; paths: string[] } | { ok: false; error: string };

type HarnessStub = {
  appendMarker(input: { marker: string; path: string }): Promise<void>;
  listStreamPaths(input: {
    principal: "admin" | "member" | "stranger" | "anonymous";
    slugOrId: string;
  }): Promise<ListResult>;
};

const harness = (env as unknown as { HARNESS: HarnessStub }).HARNESS;

function pathsOf(result: ListResult): string[] {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result.paths;
}

describe("getServerItx against real capabilities", () => {
  test("a project member's handle reaches streams.list() in-process", async () => {
    // A single-segment path: the harness reads the ROOT's childPaths (the
    // flat list()/descendantPaths catalog is gone — explorers walk levels).
    const path = `/itx-server-tests-${crypto.randomUUID()}`;
    await harness.appendMarker({ marker: "seed", path });

    // Ancestor announcements that feed the root's catalog are fire-and-forget
    // background appends, so poll until the new stream lands.
    await vi.waitFor(
      async () => {
        const result = await harness.listStreamPaths({
          principal: "member",
          slugOrId: PROJECT_SLUG,
        });
        expect(pathsOf(result)).toEqual(expect.arrayContaining(["/", path]));
      },
      { timeout: 10_000 },
    );
  });

  test("resolves by project id as well as slug, and for admins", async () => {
    const bySlug = await harness.listStreamPaths({ principal: "admin", slugOrId: PROJECT_SLUG });
    const byId = await harness.listStreamPaths({ principal: "member", slugOrId: PROJECT_ID });
    expect(pathsOf(bySlug)).toEqual(pathsOf(byId));
  });

  test("a principal without the project cannot obtain a handle", async () => {
    const result = await harness.listStreamPaths({
      principal: "stranger",
      slugOrId: PROJECT_SLUG,
    });
    expect(result).toEqual({ ok: false, error: `Project ${PROJECT_SLUG} not found.` });
  });

  test("an unauthenticated request cannot obtain a handle", async () => {
    const result = await harness.listStreamPaths({
      principal: "anonymous",
      slugOrId: PROJECT_SLUG,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  test("an unknown slug resolves to nothing even for admins", async () => {
    const result = await harness.listStreamPaths({
      principal: "admin",
      slugOrId: "no-such-project",
    });
    expect(result).toEqual({ ok: false, error: "Project no-such-project not found." });
  });
});
