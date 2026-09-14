// The two security kernels of the OS deploy, tested directly against the
// assert helpers — no mocked pipeline. (The previous version of this file
// mocked nine modules to re-enact deploy call ordering; the ordering is the
// e2e-proven deploy pipeline's job, the invariants below are what must never
// regress.) `deploy.ts` guards its own CLI entrypoint (trpc-cli's main-module
// check), so importing it here is inert.
import { describe, expect, it } from "vitest";
import {
  assertDopplerSecretAbsent,
  removeWorkerSecrets,
} from "../../../scripts/lib/deploy-helpers.ts";
import { RETIRED_WORKER_SECRETS } from "./generate-wrangler-config.ts";
import {
  assertPreviewPetshopIntegrationConfigured,
  detachRetiredWorkerQueueConsumers,
  isExactOsProjectMiss,
  posthogBuildEnv,
  pinnedPackageSpecsToAwait,
  resolveOsContainerDeployArgs,
  waitForPinnedPackage,
} from "./deploy.ts";

const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";

describe("preview package prerequisite", () => {
  it("derives the URLs to await from the template's pkg.pr.new specs", () => {
    const sha = "f".repeat(40);
    // Name-agnostic: every iterate/iterate package the template declares is
    // awaited at its pinned URL before preview deployment starts.
    expect(pinnedPackageSpecsToAwait(sha)).toEqual([
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

    await waitForPinnedPackage(packageSpec, {
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
      waitForPinnedPackage(packageSpec, {
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

describe("retired Worker Queue consumers", () => {
  it.each(["script", "script_name"] as const)(
    "detaches only this Worker's retired consumers when Cloudflare returns %s",
    async (workerField) => {
      const calls: Array<{ init?: RequestInit; path: string }> = [];
      const cf = async <T>(path: string, init?: RequestInit): Promise<T> => {
        calls.push({ init, path });
        if (path === "/queues?per_page=100&page=1") {
          return Array.from({ length: 100 }, (_, index) => ({
            queue_id: `other-${index}`,
            queue_name: `other-${index}-events`,
          })) as T;
        }
        if (path === "/queues?per_page=100&page=2") {
          return [
            { queue_id: "events-queue-id", queue_name: "os-preview-4-events" },
            {
              queue_id: "search-queue-id",
              queue_name: "os-preview-4-search-index-writes",
            },
          ] as T;
        }
        if (path === "/queues/events-queue-id/consumers") {
          return [
            { consumer_id: "other-consumer", script: "other", type: "worker" },
            {
              consumer_id: "events-consumer-id",
              [workerField]: "os-preview-4",
              type: "worker",
            },
          ] as T;
        }
        if (path === "/queues/search-queue-id/consumers") {
          return [
            { consumer_id: "http-consumer", type: "http_pull" },
            {
              consumer_id: "search-consumer-id",
              [workerField]: "os-preview-4",
              type: "worker",
            },
          ] as T;
        }
        return undefined as T;
      };

      await expect(
        detachRetiredWorkerQueueConsumers({ cf, workerName: "os-preview-4" }),
      ).resolves.toEqual([
        { queueName: "os-preview-4-events", status: "detached" },
        { queueName: "os-preview-4-search-index-writes", status: "detached" },
      ]);
      expect(calls).toEqual([
        { path: "/queues?per_page=100&page=1", init: undefined },
        { path: "/queues?per_page=100&page=2", init: undefined },
        { path: "/queues/events-queue-id/consumers", init: undefined },
        { path: "/queues/search-queue-id/consumers", init: undefined },
        {
          path: "/queues/events-queue-id/consumers/events-consumer-id",
          init: { method: "DELETE" },
        },
        {
          path: "/queues/search-queue-id/consumers/search-consumer-id",
          init: { method: "DELETE" },
        },
      ]);
    },
  );

  it("is a read-only no-op once the consumer is gone", async () => {
    const calls: string[] = [];
    const cf = async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path === "/queues?per_page=100&page=1") {
        return [{ queue_id: "events-queue-id", queue_name: "os-preview-4-events" }] as T;
      }
      return [] as T;
    };

    await expect(
      detachRetiredWorkerQueueConsumers({ cf, workerName: "os-preview-4" }),
    ).resolves.toEqual([
      { queueName: "os-preview-4-events", status: "absent" },
      { queueName: "os-preview-4-search-index-writes", status: "absent" },
    ]);
    expect(calls).toEqual(["/queues?per_page=100&page=1", "/queues/events-queue-id/consumers"]);
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

describe("retired secret invariants (secret-leak protection)", () => {
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

  // Worker-side retirement converges instead of failing closed: deploy
  // scripts are the only writers of Worker secrets, so a lingering retired
  // binding only ever means "last deployed by older code" — and an assert
  // proved sticky for previews, where a failed deploy renews the slot lease
  // and so never reaches the erase-on-acquire that removes retired secrets.
  it("deletes a lingering retired Worker secret and verifies removal (omitted secrets survive uploads)", async () => {
    const workerName = "os-preview-4";
    const staleSecret = "APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC";
    expect(RETIRED_WORKER_SECRETS).toContain(staleSecret);

    const calls: Array<{ init?: RequestInit; path: string }> = [];
    let bindings = [
      { name: staleSecret, type: "secret_text" },
      { name: "APP_CONFIG_OPEN_AI_API_KEY", type: "secret_text" },
    ];
    const cf = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ init, path });
      if (init?.method === "DELETE") {
        bindings = bindings.filter((binding) => !path.endsWith(`/${binding.name}`));
        return {} as T;
      }
      return bindings as T;
    };

    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: RETIRED_WORKER_SECRETS }),
    ).resolves.toEqual([staleSecret]);
    expect(calls).toContainEqual({
      init: { method: "DELETE" },
      path: `/workers/scripts/${workerName}/secrets/${staleSecret}`,
    });
    expect(bindings).toEqual([{ name: "APP_CONFIG_OPEN_AI_API_KEY", type: "secret_text" }]);

    // Already-converged Workers are a read-only no-op.
    calls.length = 0;
    await expect(
      removeWorkerSecrets({ cf, workerName, secretNames: RETIRED_WORKER_SECRETS }),
    ).resolves.toEqual([]);
    expect(calls).toEqual([{ init: undefined, path: `/workers/scripts/${workerName}/secrets` }]);
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
