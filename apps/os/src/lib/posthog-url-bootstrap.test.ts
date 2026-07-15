import { afterEach, describe, expect, it, vi } from "vitest";

const posthogInit = vi.fn();
// Resolve from packages/ui, which owns the SDK dependency; OS intentionally does not.
const posthogModuleSpecifier = "../../../../packages/ui/node_modules/posthog-js";

describe("shared PostHog initialization", () => {
  afterEach(() => {
    posthogInit.mockReset();
    vi.doUnmock(posthogModuleSpecifier);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not read identity or session state from the URL", async () => {
    vi.stubEnv("SSR", false);
    vi.doMock(posthogModuleSpecifier, () => ({ default: { init: posthogInit } }));
    vi.stubGlobal("window", {
      location: {
        origin: "https://os.iterate.com",
        get search(): never {
          throw new Error("PostHog initialization read URL parameters");
        },
      },
    });

    const { initPosthog } = await import("@iterate-com/ui/components/posthog");
    initPosthog({ apiKey: "phc_test" });

    await vi.waitFor(() => expect(posthogInit).toHaveBeenCalledOnce());
    expect(posthogInit.mock.calls[0]?.[1]).not.toHaveProperty("bootstrap");
  });
});
