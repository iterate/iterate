import { describe, expect, it, vi } from "vitest";
import { CapabilityProvisionRpcTarget } from "../../rpc-targets.ts";

describe("CapabilityProvisionRpcTarget", () => {
  it("checks Pager-backed ownership locally and turns inactive before revoke awaits I/O", async () => {
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

    expect(provision.__capabilityProviderPagerActive()).toBe(true);
    active = false;
    expect(provision.__capabilityProviderPagerActive()).toBe(false);
    active = true;
    expect(provision.__capabilityProviderPagerActive()).toBe(true);

    const revoking = provision.revoke();
    expect(provision.__capabilityProviderPagerActive()).toBe(false);
    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      path: ["tools"],
      providedAtOffset: 7,
    });
    finishRevoke();
    await revoking;
  });
});
