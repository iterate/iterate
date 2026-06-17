// Cross-project isolation, the adversarial view. Threat model: a principal that
// legitimately holds a context in project A (here: alice in `prj_ref`) tries to
// reach project B (`prj_bob`) or the admin `__null__` plane WITHOUT access. The
// only authority decision is the connect door; everything else is confined by
// construction. These tests assert that confinement holds.

import { describe, expect, it } from "vitest";
import { connect } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentItx = (label: string) => connect({ path: `/agents/cross-project-${label}-${rid}` });
const expectRejects = (fn: () => unknown) => expect((async () => await fn())()).rejects;

describe("itx cross-project adversarial e2e", () => {
  it("rejects non-dynamic address types as user-provided capabilities", async () => {
    using itx = agentItx("unsupported-address-types");
    for (const capability of [
      { type: "durable-object", namespace: "itx", name: "prj_bob:/" },
      { type: "worker-entrypoint", binding: "PROJECT", name: "prj_ref:/" },
      { type: "rpc", worker: { type: "loopback" } },
    ]) {
      await expectRejects(() =>
        itx.provideCapability({
          path: ["unsupported"],
          capability,
        }),
      ).toThrow(/unsupported capability address type/);
    }

    const d = await itx.describe();
    expect(d.capabilities.some((c: any) => c.path.join(".") === "unsupported")).toBe(false);
  });

  it("denies connecting to a project the principal cannot access", async () => {
    using denied = connect({ projectId: "prj_bob", path: "/" });
    await expectRejects(() => denied.describe()).toThrow();
  });

  it("refuses to connect to __null__ as a project context", async () => {
    using nul = connect({ projectId: "__null__", path: "/" });
    await expectRejects(() => nul.describe()).toThrow();
  });
});
