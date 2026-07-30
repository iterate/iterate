import { describe, expect, it } from "vitest";
import {
  assertPreviewPetshopIntegrationConfigured,
  isExactOsProjectMiss,
  posthogBuildEnv,
  previewPackageSpecsToAwait,
  resolveOsContainerDeployArgs,
  waitForPreviewPackage,
} from "./deploy.ts";

describe("preview package prerequisite", () => {
  it("derives the URLs to await from the template's pkg.pr.new specs", () => {
    const sha = "f".repeat(40);
    // Name-agnostic: every iterate/iterate package the template declares is
    // awaited at its pinned URL before preview deployment starts.
    expect(previewPackageSpecsToAwait(sha)).toEqual([
      `https://pkg.pr.new/iterate/iterate/@iterate-com/docs@${sha}`,
      `https://pkg.pr.new/iterate/iterate/iterate@${sha}`,
    ]);
  });

  it("polls the exact immutable package with HEAD until it is available", async () => {
    const packageSpec = "https://pkg.pr.new/iterate/iterate/iterate@abc123";
    let now = 0;
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const responses = [new Response(null, { status: 404 }), new Response(null, { status: 200 })];
    const fetchPackage: typeof fetch = async (input, init) => {
      requests.push({ init, url: String(input) });
      return responses.shift() ?? new Response(null, { status: 200 });
    };

    await waitForPreviewPackage(packageSpec, {
      fetch: fetchPackage,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      timeoutMs: 5_000,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url)).toEqual([packageSpec, packageSpec]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["HEAD", "HEAD"]);
    expect(now).toBe(1_000);
  });

  it("fails closed with the missing URL and last response after a bounded wait", async () => {
    const packageSpec = "https://pkg.pr.new/iterate/iterate/iterate@missing";
    let now = 0;

    await expect(
      waitForPreviewPackage(packageSpec, {
        fetch: async () => new Response(null, { status: 404 }),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        timeoutMs: 2_500,
      }),
    ).rejects.toThrow(
      `Timed out waiting 2500ms for the preview package ${packageSpec}. Last check: HTTP 404.`,
    );
    expect(now).toBe(2_500);
  });
});

describe("OS container rollout", () => {
  it("skips only when preview explicitly proved an unchanged warm deployment", () => {
    expect(
      resolveOsContainerDeployArgs({
        bootstrapAction: "skipped",
        requestedRollout: "none",
      }),
    ).toEqual(["--containers-rollout", "none"]);
  });

  it("keeps the full rollout by default and after a first-time bootstrap", () => {
    expect(
      resolveOsContainerDeployArgs({
        bootstrapAction: "skipped",
        requestedRollout: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveOsContainerDeployArgs({
        bootstrapAction: "bootstrapped",
        requestedRollout: "none",
      }),
    ).toBeUndefined();
  });

  it("rejects an unknown rollout mode", () => {
    expect(() =>
      resolveOsContainerDeployArgs({
        bootstrapAction: "skipped",
        requestedRollout: "maybe",
      }),
    ).toThrow(/OS_CONTAINERS_ROLLOUT/);
  });
});

describe("preview Petshop deployment invariant", () => {
  it("requires first-party Petshop credentials in every preview OS config", () => {
    expect(() => assertPreviewPetshopIntegrationConfigured("preview_4", {})).toThrow(
      /preview_4 requires APP_CONFIG_INTEGRATIONS__PETSHOP/,
    );
    expect(() =>
      assertPreviewPetshopIntegrationConfigured("preview_4", {
        APP_CONFIG_INTEGRATIONS__PETSHOP: '{"oauthClientId":"petshop-default"}',
      }),
    ).not.toThrow();
  });

  it("does not require the test fixture in production", () => {
    expect(() => assertPreviewPetshopIntegrationConfigured("prd", {})).not.toThrow();
  });
});

describe("PostHog source-map build credentials", () => {
  it("passes production Doppler credentials to Vite without adding Worker secrets", () => {
    expect(
      posthogBuildEnv("prd", {
        POSTHOG_PERSONAL_API_KEY: "phx_personal",
        POSTHOG_PROJECT_ID: "123456",
      }),
    ).toEqual({
      POSTHOG_PERSONAL_API_KEY: "phx_personal",
      POSTHOG_PROJECT_ID: "123456",
    });
  });

  it("does not require or expose source-map credentials in previews", () => {
    expect(posthogBuildEnv("preview_4", {})).toEqual({});
  });

  it.each(["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"])(
    "fails a production deploy before building when %s is absent",
    (missing) => {
      const secrets = {
        POSTHOG_PERSONAL_API_KEY: "phx_personal",
        POSTHOG_PROJECT_ID: "123456",
      };
      delete secrets[missing as keyof typeof secrets];
      expect(() => posthogBuildEnv("prd", secrets)).toThrow(missing);
    },
  );
});

describe("auth Workers RPC deployment proof", () => {
  it("accepts only the exact OS project-miss response", async () => {
    await expect(
      isExactOsProjectMiss(Response.json({ error: "not found" }, { status: 404 })),
    ).resolves.toBe(true);
  });

  it("rejects an unrelated 404 body — an edge/router 404 is not a deployment proof", async () => {
    await expect(
      isExactOsProjectMiss(Response.json({ error: "route not found" }, { status: 404 })),
    ).resolves.toBe(false);
    await expect(isExactOsProjectMiss(new Response("not found", { status: 404 }))).resolves.toBe(
      false,
    );
  });

  it("rejects non-404 statuses even with the right body", async () => {
    await expect(
      isExactOsProjectMiss(Response.json({ error: "not found" }, { status: 200 })),
    ).resolves.toBe(false);
  });
});
