import { afterEach, describe, expect, it, vi } from "vitest";
import type { PosthogContext } from "@iterate-com/ui/components/posthog";

const posthogInit = vi.fn();
const posthogIdentify = vi.fn();
const posthogGroup = vi.fn();
const posthogCapture = vi.fn();
const posthogCaptureException = vi.fn();
const posthogRegister = vi.fn();
const posthogReset = vi.fn();
const posthogResetGroups = vi.fn();
const posthogGetProperty = vi.fn();
const posthogGetGroups = vi.fn();
// Resolve from packages/ui, which owns the SDK dependency; OS intentionally does not.
const posthogModuleSpecifier = "../../../../packages/ui/node_modules/posthog-js";

let currentUserId: string | undefined;
let currentGroups: Record<string, string> = {};

function mockPosthog() {
  posthogIdentify.mockImplementation((distinctId: string) => {
    currentUserId = distinctId;
  });
  posthogGroup.mockImplementation((type: string, key: string) => {
    currentGroups[type] = key;
  });
  posthogReset.mockImplementation(() => {
    currentUserId = undefined;
    currentGroups = {};
  });
  posthogResetGroups.mockImplementation(() => {
    currentGroups = {};
  });
  posthogGetProperty.mockImplementation((key: string) =>
    key === "$user_id" ? currentUserId : undefined,
  );
  posthogGetGroups.mockImplementation(() => ({ ...currentGroups }));
  vi.doMock(posthogModuleSpecifier, () => ({
    default: {
      capture: posthogCapture,
      captureException: posthogCaptureException,
      get_property: posthogGetProperty,
      getGroups: posthogGetGroups,
      group: posthogGroup,
      identify: posthogIdentify,
      init: posthogInit,
      register: posthogRegister,
      reset: posthogReset,
      resetGroups: posthogResetGroups,
    },
  }));
}

function posthogContext(projectId = "prj_123"): PosthogContext {
  return {
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
        key: projectId,
        properties: { id: projectId, slug: projectId },
      },
    ],
  };
}

async function loadPosthog(options: Record<string, unknown> = {}) {
  vi.stubEnv("SSR", false);
  mockPosthog();
  vi.stubGlobal("window", {
    location: { origin: "https://os.iterate.com" },
  });
  const api = await import("@iterate-com/ui/components/posthog");
  api.initPosthog({ apiKey: "phc_test", ...options });
  await vi.waitFor(() => expect(posthogInit).toHaveBeenCalledOnce());
  return api;
}

describe("shared PostHog initialization", () => {
  afterEach(() => {
    currentUserId = undefined;
    currentGroups = {};
    vi.clearAllMocks();
    vi.doUnmock(posthogModuleSpecifier);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses current PostHog defaults through the first-party proxy", async () => {
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
    expect(posthogInit.mock.calls[0]?.[1]).toMatchObject({
      api_host: "https://os.iterate.com/e",
      capture_exceptions: {
        capture_console_errors: false,
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
      },
      capture_pageview: "history_change",
      defaults: "2026-06-25",
      disable_session_recording: false,
      mask_all_element_attributes: true,
      mask_all_text: true,
      person_profiles: "identified_only",
      strict_script_versioning: true,
    });
    expect(posthogInit.mock.calls[0]?.[1]).not.toHaveProperty("bootstrap");
  });

  it("supports manual TanStack pageviews and disabling replay", async () => {
    await loadPosthog({ capturePageviews: false, sessionRecording: false });

    expect(posthogInit.mock.calls[0]?.[1]).toMatchObject({
      capture_pageview: false,
      disable_session_recording: true,
    });
  });

  it("identifies and groups before a resolved pageview", async () => {
    const { capturePosthogPageview } = await loadPosthog({ capturePageviews: false });
    capturePosthogPageview(
      posthogContext(),
      "/projects/difference-engine?secret=do-not-capture#fragment",
    );

    await vi.waitFor(() => expect(posthogCapture).toHaveBeenCalledOnce());
    expect(posthogIdentify).toHaveBeenCalledWith("usr_123", {
      email: "ada@example.com",
      name: "Ada",
    });
    expect(posthogGroup.mock.calls).toEqual([
      ["organization", "org_123", { id: "org_123", name: "Analytical Engines" }],
      ["project", "prj_123", { id: "prj_123", slug: "prj_123" }],
    ]);
    expect(posthogResetGroups).not.toHaveBeenCalled();
    expect(posthogCapture).toHaveBeenCalledWith("$pageview", {
      $current_url:
        "https://os.iterate.com/projects/difference-engine?secret=do-not-capture#fragment",
    });
    expect(posthogIdentify.mock.invocationCallOrder[0]).toBeLessThan(
      posthogGroup.mock.invocationCallOrder[0]!,
    );
    expect(posthogGroup.mock.invocationCallOrder[1]).toBeLessThan(
      posthogCapture.mock.invocationCallOrder[0]!,
    );
  });

  it("uses PostHog's exception API for framework-caught browser errors", async () => {
    const { capturePosthogException } = await loadPosthog();
    const error = new Error("render failed");

    capturePosthogException(error);

    await vi.waitFor(() => expect(posthogCaptureException).toHaveBeenCalledWith(error));
  });

  it("does not repeat identity or group metadata for unchanged context", async () => {
    const { capturePosthogPageview } = await loadPosthog({ capturePageviews: false });
    const context = posthogContext();
    capturePosthogPageview(context, "/projects/one");
    capturePosthogPageview(context, "/projects/one/agents");

    await vi.waitFor(() => expect(posthogCapture).toHaveBeenCalledTimes(2));
    expect(posthogIdentify).toHaveBeenCalledOnce();
    expect(posthogGroup).toHaveBeenCalledTimes(2);
  });

  it("changes only the project group and resets cleanly on sign-out", async () => {
    const { capturePosthogPageview, syncPosthogContext } = await loadPosthog({
      capturePageviews: false,
    });
    syncPosthogContext(posthogContext());
    syncPosthogContext(posthogContext("prj_456"));
    syncPosthogContext(null);

    await vi.waitFor(() => expect(posthogReset).toHaveBeenCalledOnce());
    expect(posthogIdentify).toHaveBeenCalledOnce();
    expect(posthogGroup.mock.calls.at(-1)).toEqual([
      "project",
      "prj_456",
      { id: "prj_456", slug: "prj_456" },
    ]);
    expect(posthogGroup).toHaveBeenCalledTimes(3);
    expect(posthogResetGroups).not.toHaveBeenCalled();

    capturePosthogPageview(null, "/signed-out");
    await vi.waitFor(() => expect(posthogCapture).toHaveBeenCalledOnce());
    expect(posthogReset).toHaveBeenCalledOnce();
  });
});
