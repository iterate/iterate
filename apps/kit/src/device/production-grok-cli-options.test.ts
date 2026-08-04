import { describe, expect, test } from "vitest";
import {
  parseProductionGrokCliOptions,
  productionSpokenCountPlan,
  productionSpokenCountRange,
} from "./production-grok-cli-options.ts";

const environment = {
  ITERATE_KIT_PROJECT_API_KEY: "itxk_project_secret",
  XAI_API_KEY: "xai_provider_secret",
};

describe("production Grok proof CLI options", () => {
  test("keeps the historical Stick invocation as the default device route", () => {
    const options = parseProductionGrokCliOptions([], environment);

    expect(options.deviceId).toBe("m5sticks3");
    expect(options.outputDirectory).toMatch(/\/evidence\/m5sticks3-production-grok$/u);
    expect(options.scenario).toBe("conversation");
    expect(options.turns).toBe(1);
  });

  test("selects the deliberate unbroken count-to-one-hundred scenario", () => {
    const options = parseProductionGrokCliOptions(["--count-to-100"], environment);

    expect(options.scenario).toBe("count-to-100");
  });

  test.each([
    ["--count-100-to-200", "count-100-to-200", { end: 200, start: 100 }],
    ["--count-200-to-300", "count-200-to-300", { end: 300, start: 200 }],
  ] as const)("selects the later exact spoken-count range with %s", (flag, scenario, range) => {
    /*
     * These are distinct physical endurance runs, not aliases for 1..100. A
     * typed range derived from the scenario keeps the spoken prompt, provider
     * transcript oracle, and Mac-microphone oracle on the same boundaries.
     */
    const options = parseProductionGrokCliOptions([flag], environment);

    expect(options.scenario).toBe(scenario);
    expect(productionSpokenCountRange(options.scenario)).toEqual(range);
  });

  test("rejects two count scenarios instead of silently running the last one", () => {
    expect(() =>
      parseProductionGrokCliOptions(["--count-to-100", "--count-100-to-200"], environment),
    ).toThrow("Only one spoken-count scenario");
  });

  test("models the final 300-to-400 gate as a substantial interrupted prefix", () => {
    /*
     * Treating this as another unbroken range would make a correctly cancelled
     * response fail, while accepting an arbitrary prefix would let an early
     * transport collapse pass. The scenario therefore carries its distinct
     * terminal rule and minimum audible prefix into the production harness.
     */
    const options = parseProductionGrokCliOptions(["--count-300-to-400-interrupted"], environment);

    expect(options.scenario).toBe("count-300-to-400-interrupted");
    expect(productionSpokenCountPlan(options.scenario)).toEqual({
      interrupted: true,
      minimumNumbers: 25,
      range: { end: 400, start: 300 },
    });
  });

  test("selects a bounded number of PTT turns for one deployed conversation", () => {
    const options = parseProductionGrokCliOptions(["--turns", "3"], environment);

    expect(options.turns).toBe(3);
  });

  test("selects a reusable device identity explicitly", () => {
    const options = parseProductionGrokCliOptions(
      ["--device-id", "stackchan", "--device-host", "192.168.0.31"],
      environment,
    );

    expect(options).toMatchObject({
      deviceHost: "192.168.0.31",
      deviceId: "stackchan",
    });
    expect(options.outputDirectory).toMatch(/\/evidence\/stackchan-production-grok$/u);
  });

  test("accepts a Doppler admin credential as a pairing source without inventing a project key", () => {
    /*
     * The direct physical runner must not read/reset the ESP merely to recover
     * a credential already revealable by the production pairing authority.
     * Resolution happens later and in memory; the parser must therefore retain
     * an absent direct key honestly rather than substituting the admin secret.
     */
    const options = parseProductionGrokCliOptions([], {
      APP_CONFIG_ADMIN_API_SECRET: "admin_pairing_secret",
      XAI_API_KEY: "xai_provider_secret",
    });

    expect(options.projectApiKey).toBeUndefined();
  });

  test("uses the production Doppler name for the independent xAI oracle", () => {
    /*
     * The deployed app calls this secret APP_CONFIG_X_AI_API_KEY, while a
     * standalone developer shell historically used XAI_API_KEY. Requiring the
     * latter after `doppler run --config prd` made the unattended physical
     * proof fail before touching hardware even though the configured provider
     * credential was present. Both names refer to the same provider boundary;
     * the explicit short alias remains the override when both exist.
     */
    const options = parseProductionGrokCliOptions([], {
      APP_CONFIG_ADMIN_API_SECRET: "admin_pairing_secret",
      APP_CONFIG_X_AI_API_KEY: "xai_doppler_secret",
    });

    expect(options.xaiApiKey).toBe("xai_doppler_secret");
  });

  test("still rejects a proof with neither project nor pairing authority", () => {
    expect(() => parseProductionGrokCliOptions([], { XAI_API_KEY: "xai_provider_secret" })).toThrow(
      "project ingress credential",
    );
  });

  test("rejects a device identity that cannot own one isolated stream", () => {
    expect(() =>
      parseProductionGrokCliOptions(["--device-id", "devices/stackchan"], environment),
    ).toThrow("device id");
  });
});
