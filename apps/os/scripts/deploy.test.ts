// The two security kernels of the OS deploy, tested directly against the
// assert helpers — no mocked pipeline. (The previous version of this file
// mocked nine modules to re-enact deploy call ordering; the ordering is the
// e2e-proven deploy pipeline's job, the invariants below are what must never
// regress.) `deploy.ts` guards its own CLI entrypoint (trpc-cli's main-module
// check), so importing it here is inert.
import { describe, expect, it } from "vitest";
import {
  assertDopplerSecretAbsent,
  assertWorkerSecretAbsent,
} from "../../../scripts/lib/deploy-helpers.ts";
import {
  assertPreviewPetshopIntegrationConfigured,
  detachRetiredArtifactEventQueueConsumer,
  isExactOsProjectMiss,
  posthogBuildEnv,
  resolveOsContainerDeployArgs,
} from "./deploy.ts";

const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";

describe("retired Artifact event Queue consumer", () => {
  it("detaches only the legacy consumer for this Worker", async () => {
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    const cf = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ init, path });
      if (path === "/queues?per_page=100") {
        return [
          { queue_id: "other-id", queue_name: "other-events" },
          { queue_id: "queue-id", queue_name: "os-preview-4-events" },
        ] as T;
      }
      if (path === "/queues/queue-id/consumers") {
        return [
          { consumer_id: "other-consumer", script: "other", type: "worker" },
          { consumer_id: "consumer-id", script: "os-preview-4", type: "worker" },
        ] as T;
      }
      return undefined as T;
    };

    await expect(
      detachRetiredArtifactEventQueueConsumer({ cf, workerName: "os-preview-4" }),
    ).resolves.toBe("detached");
    expect(calls).toEqual([
      { path: "/queues?per_page=100", init: undefined },
      { path: "/queues/queue-id/consumers", init: undefined },
      {
        path: "/queues/queue-id/consumers/consumer-id",
        init: { method: "DELETE" },
      },
    ]);
  });

  it("is a read-only no-op once the consumer is gone", async () => {
    const calls: string[] = [];
    const cf = async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path === "/queues?per_page=100") {
        return [{ queue_id: "queue-id", queue_name: "os-preview-4-events" }] as T;
      }
      return [] as T;
    };

    await expect(
      detachRetiredArtifactEventQueueConsumer({ cf, workerName: "os-preview-4" }),
    ).resolves.toBe("absent");
    expect(calls).toEqual(["/queues?per_page=100", "/queues/queue-id/consumers"]);
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

describe("forbidden auth service-token invariants (secret-leak protection)", () => {
  it("refuses when the resolved Doppler config carries the retired secret", () => {
    expect(() =>
      assertDopplerSecretAbsent({
        project: "os",
        config: "preview_4",
        secretName,
        secrets: { [secretName]: "redacted" },
      }),
    ).toThrow(/Forbidden Doppler secret is present/);

    expect(() =>
      assertDopplerSecretAbsent({
        project: "os",
        config: "preview_4",
        secretName,
        secrets: { OTHER_SECRET: "fine" },
      }),
    ).not.toThrow();
  });

  it("refuses while the live Worker still binds the secret (omitted secrets survive uploads)", async () => {
    const workerName = "os-preview-4";
    await expect(
      assertWorkerSecretAbsent({
        cf: async () => [{ name: secretName, type: "secret_text" }],
        workerName,
        secretName,
      }),
    ).rejects.toThrow(/Forbidden Worker secret is present/);

    await expect(
      assertWorkerSecretAbsent({
        cf: async () => [{ name: "SOME_OTHER_SECRET", type: "secret_text" }],
        workerName,
        secretName,
      }),
    ).resolves.toBeUndefined();
  });
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
