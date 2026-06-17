import { describe, expect, it } from "vitest";
import { connect } from "./e2e-env.ts";

const rid = Math.random().toString(36).slice(2, 8);
const agentItx = (label: string) => connect({ path: `/agents/parent-adversarial-${label}-${rid}` });

/** Cap'n Web returns an RpcPromise (thenable, not `instanceof Promise`). Wrap a
 *  call in a real async fn so vitest's `.rejects` can await it. */
const expectRejects = (fn: () => unknown) => expect((async () => await fn())()).rejects;

describe("itx itxParent adversarial e2e", () => {
  it("rejects a provider-forged worker-entrypoint address (the itxParent loopback)", async () => {
    using itx = agentItx("forge-entrypoint");
    // The trusted itxParent loopback is a `worker-entrypoint` address. A user
    // provide naming it is rejected — it can only ever be a host built-in.
    await expectRejects(() =>
      itx.provideCapability({
        path: ["forgedParent"],
        capability: {
          type: "worker-entrypoint",
          entrypoint: "ItxEntrypoint",
          props: { projectId: "prj_bob", path: "/" },
        },
        instructions: "attempt to smuggle a trusted itxParent entrypoint into another project",
      }),
    ).toThrow(/can only be host built-ins/);

    const description = await itx.describe();
    expect(description.capabilities.some((cap: any) => cap.path.join(".") === "forgedParent")).toBe(
      false,
    );
  });

  it("does not let nested provider members shadow the reserved itxParent chain", async () => {
    using itx = agentItx("deep-shadow");
    await itx.provideCapability({
      path: ["toolbox"],
      capability: { itxParent: { fetch: () => "forged" } },
    });

    // `itxParent` is reserved topology syntax; a user capability can never expose
    // it in a replayed suffix, so this throws rather than resolving the forgery.
    await expectRejects(() => itx.toolbox.itxParent.fetch()).toThrow(
      /reserved ITX path segment "itxParent"/,
    );
  });
});
