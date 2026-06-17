// Cross-project isolation, the adversarial view. Threat model: a principal that
// legitimately holds a context in project A (here: alice in `shared`) tries to
// reach project B (`bob`) or the admin `__null__` plane WITHOUT access. The only
// authority decision is the connect door; everything else is confined by
// construction. These tests assert that confinement holds.

import { describe, expect, it } from "vitest";
import { connect } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentItx = (label: string) => connect({ path: `/agents/cross-project-${label}-${rid}` });
const expectRejects = (fn: () => unknown) => expect((async () => await fn())()).rejects;

describe("itx cross-project adversarial e2e", () => {
  // Attack 1: dial project B's context by NAMING its Durable Object.
  it("rejects a user-provided durable-object address naming another project", async () => {
    using itx = agentItx("name-other-project");
    await expectRejects(() =>
      itx.provideCapability({
        path: ["pwn"],
        capability: { type: "durable-object", namespace: "itx", name: "bob:/" },
      }),
    ).toThrow(/can only be host built-ins/);

    const d = await itx.describe();
    expect(d.capabilities.some((c: any) => c.path.join(".") === "pwn")).toBe(false);
  });

  // Attack 3: the same trick aimed at the admin-only `__null__` platform plane.
  it("rejects a user-provided durable-object address naming the __null__ plane", async () => {
    using itx = agentItx("name-null");
    await expectRejects(() =>
      itx.provideCapability({
        path: ["platform"],
        capability: { type: "durable-object", namespace: "itx", name: "__null__:/integrations" },
      }),
    ).toThrow(/can only be host built-ins/);
  });

  // Even reaching a sibling DO in the SAME project family is just data the dialer
  // refuses — there is no user-providable durable-object address at all.
  it("rejects a user-provided durable-object address naming the project's own DOs", async () => {
    using itx = agentItx("name-own");
    await expectRejects(() =>
      itx.provideCapability({
        path: ["repoPeek"],
        capability: {
          type: "durable-object",
          namespace: "repo",
          name: "shared:/repos/project",
        },
      }),
    ).toThrow(/can only be host built-ins/);
  });

  // Attack 2 is gone structurally: there is no global catalog to enumerate or
  // hop through, so the connect door is the whole boundary.
  it("denies connecting to a project the principal cannot access", async () => {
    using denied = connect({ projectId: "bob", path: "/" }); // alice has no access to bob
    await expectRejects(() => denied.describe()).toThrow();
  });

  it("refuses to connect to __null__ as a project context", async () => {
    using nul = connect({ projectId: "__null__", path: "/" });
    await expectRejects(() => nul.describe()).toThrow();
  });
});
