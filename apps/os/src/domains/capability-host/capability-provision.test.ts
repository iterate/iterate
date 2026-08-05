import { describe, expect, it, vi } from "vitest";
import { CapabilityProvisionRpcTarget } from "../../rpc-targets.ts";

describe("CapabilityProvisionRpcTarget", () => {
  it("probes the logical lease locally and turns inactive before revoke awaits I/O", async () => {
    let active = true;
    let finishRevoke!: () => void;
    const revoke = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRevoke = resolve;
        }),
    );
    const provision = new CapabilityProvisionRpcTarget({
      isActive: () => active,
      path: ["tools"],
      providedAtOffset: 7,
      revoke,
    });

    expect(provision.ping()).toBe(true);
    active = false;
    expect(provision.ping()).toBe(false);
    active = true;
    expect(provision.ping()).toBe(true);

    const revoking = provision.revoke();
    expect(provision.ping()).toBe(false);
    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      path: ["tools"],
      providedAtOffset: 7,
    });
    finishRevoke();
    await revoking;
  });
});
