import { afterEach, describe, expect, it, vi } from "vitest";

const posthogInit = vi.fn();
const posthogIdentify = vi.fn();
const posthogGroup = vi.fn();
const posthogRegister = vi.fn();
const posthogReset = vi.fn();
const posthogResetGroups = vi.fn();
const posthogUnregister = vi.fn();
// Resolve from packages/ui, which owns the SDK dependency; OS intentionally does not.
const posthogModuleSpecifier = "../../../../packages/ui/node_modules/posthog-js";

function mockPosthog() {
  vi.doMock(posthogModuleSpecifier, () => ({
    default: {
      group: posthogGroup,
      identify: posthogIdentify,
      init: posthogInit,
      register: posthogRegister,
      reset: posthogReset,
      resetGroups: posthogResetGroups,
      unregister: posthogUnregister,
    },
  }));
}

describe("shared PostHog initialization", () => {
  afterEach(() => {
    posthogInit.mockReset();
    posthogIdentify.mockReset();
    posthogGroup.mockReset();
    posthogRegister.mockReset();
    posthogReset.mockReset();
    posthogResetGroups.mockReset();
    posthogUnregister.mockReset();
    vi.doUnmock(posthogModuleSpecifier);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not read identity or session state from the URL", async () => {
    vi.stubEnv("SSR", false);
    mockPosthog();
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

  it("identifies a person before replacing and identifying their groups", async () => {
    vi.stubEnv("SSR", false);
    mockPosthog();
    vi.stubGlobal("window", {
      location: { origin: "https://os.iterate.com" },
    });

    const { initPosthog, syncPosthogContext } = await import("@iterate-com/ui/components/posthog");
    initPosthog({ apiKey: "phc_test" });
    syncPosthogContext({
      eventProperties: {
        organization_id: "org_123",
        project_id: "prj_123",
      },
      person: {
        distinctId: "usr_123",
        properties: { email: "ada@example.com", name: "Ada" },
      },
      groups: [
        {
          type: "organization",
          key: "org_123",
          properties: { id: "org_123", name: "Analytical Engines" },
        },
        {
          type: "project",
          key: "prj_123",
          properties: { id: "prj_123", slug: "difference-engine" },
        },
      ],
    });

    await vi.waitFor(() => expect(posthogGroup).toHaveBeenCalledTimes(2));
    expect(posthogIdentify).toHaveBeenCalledWith("usr_123", {
      email: "ada@example.com",
      name: "Ada",
    });
    expect(posthogResetGroups).toHaveBeenCalledOnce();
    expect(posthogRegister).toHaveBeenCalledWith({
      organization_id: "org_123",
      project_id: "prj_123",
    });
    expect(posthogUnregister).not.toHaveBeenCalled();
    expect(posthogGroup.mock.calls).toEqual([
      ["organization", "org_123", { id: "org_123", name: "Analytical Engines" }],
      ["project", "prj_123", { id: "prj_123", slug: "difference-engine" }],
    ]);
    expect(posthogIdentify.mock.invocationCallOrder[0]).toBeLessThan(
      posthogResetGroups.mock.invocationCallOrder[0]!,
    );
    expect(posthogResetGroups.mock.invocationCallOrder[0]).toBeLessThan(
      posthogGroup.mock.invocationCallOrder[0]!,
    );
  });

  it("resets the persisted person and groups on sign-out", async () => {
    vi.stubEnv("SSR", false);
    mockPosthog();
    vi.stubGlobal("window", {
      location: { origin: "https://os.iterate.com" },
    });

    const { initPosthog, resetPosthogIdentity } =
      await import("@iterate-com/ui/components/posthog");
    initPosthog({ apiKey: "phc_test" });
    resetPosthogIdentity();

    await vi.waitFor(() => expect(posthogReset).toHaveBeenCalledOnce());
  });
});
